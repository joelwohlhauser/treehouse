const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const { getConfig } = require("./config");
const { shellQuote } = require("./shell");
const { createTargetAdapter } = require("./target-adapters");
const { tryGetCurrentWorkspaceLocation } = require("./targets");

const DEFAULT_POLL_INTERVAL_MS = 2500;
const MIN_POLL_INTERVAL_MS = 1000;
const FULL_SCAN_INTERVAL_MS = 60 * 1000;
const RECENT_SCAN_DAY_SPAN = 2;
const STARTUP_TITLE_REFRESH_DELAYS_MS = [500, 2000, 5000];
const TITLE_VARIABLE_NAME = "treehouseCodexStatus";
const TITLE_CONTEXT_KEY = "treehouse.codexSessionStatus";
const CODEX_NO_WORKSPACE_STATUS = "";
const CODEX_IDLE_STATUS = "⚪";

function startCodexSessionWatcher(context, output) {
  const watcher = new CodexSessionWatcher(output);
  watcher.start();
  context.subscriptions.push(watcher);
  return watcher;
}

class CodexSessionWatcher {
  [key: string]: any;

  constructor(output) {
    this.output = output;
    this.disposables = [];
    this.sessions = new Map();
    this.pollTimer = null;
    this.pollInFlight = false;
    this.started = false;
    this.root = "";
    this.rootSetting = "";
    this.pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    this.lastFullScanAt = 0;
    this.titleStatus = "";
    this.titleVariableRegistrationAttempted = false;
    this.titleVariableUnavailableLogged = false;
    this.titleRefreshTimers = new Set();
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;

    void this.registerTitleVariable();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.sessions.clear();
        this.lastFullScanAt = 0;
        void this.poll({ forceFullScan: true });
      }),
      vscode.window.onDidChangeWindowState(() => {
        void this.updateTitleStatus(getCurrentWorkspacePaths(), { force: true });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("treehouse.codexSessionPollIntervalMs") ||
          event.affectsConfiguration("treehouse.codexSessionsRoot")
        ) {
          this.configureFromSettings();
        }
        if (event.affectsConfiguration("window.title") || event.affectsConfiguration("window.titleSeparator")) {
          void this.updateTitleStatus(getCurrentWorkspacePaths(), { force: true });
        }
      })
    );

    this.configureFromSettings();
  }

  configureFromSettings() {
    const config = getConfig();
    const nextRootSetting = String(config.codexSessionsRoot || "~/.codex/sessions").trim() || "~/.codex/sessions";
    const nextRoot = expandHome(nextRootSetting);
    const nextInterval = normalizePollInterval(config.codexSessionPollIntervalMs);
    const rootChanged = this.rootSetting && this.rootSetting !== nextRootSetting;
    this.rootSetting = nextRootSetting;
    this.root = nextRoot;
    this.pollIntervalMs = nextInterval;

    if (rootChanged) {
      this.sessions.clear();
      this.lastFullScanAt = 0;
    }

    this.stopTimer();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    void this.poll({ forceFullScan: true });
  }

  stopTimer() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async poll(options: any = {}) {
    if (this.pollInFlight) {
      return;
    }

    const location = tryGetCurrentWorkspaceLocation();
    const workspacePaths = getCurrentWorkspacePaths(location);
    if (workspacePaths.length === 0) {
      await this.setTitleStatus(CODEX_NO_WORKSPACE_STATUS);
      return;
    }

    this.pollInFlight = true;
    try {
      const now = Date.now();
      const shouldFullScan =
        options.forceFullScan || this.lastFullScanAt === 0 || now - this.lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
      if (location?.target?.type === "ssh") {
        await this.pollRemote(location, shouldFullScan);
      } else {
        const filePaths = new Set(this.sessions.keys());

        if (shouldFullScan) {
          for (const filePath of await collectCodexSessionFiles(this.root)) {
            filePaths.add(filePath);
          }
        } else {
          for (const filePath of await collectRecentCodexSessionFiles(this.root)) {
            filePaths.add(filePath);
          }
        }

        for (const filePath of filePaths) {
          await this.processFile(filePath, workspacePaths);
        }
      }

      if (shouldFullScan) {
        this.lastFullScanAt = now;
      }
      await this.updateTitleStatus(workspacePaths);
    } catch (error) {
      this.output?.appendLine(`Codex session watcher failed: ${getErrorMessage(error)}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  async pollRemote(location, forceFullScan) {
    const adapter = createTargetAdapter(location.target);
    const result = await adapter.runCommand(
      buildRemoteCodexSessionStatusCommand(this.rootSetting || "~/.codex/sessions", location.workspacePath, forceFullScan),
      location.workspacePath,
      undefined
    );

    for (const rawLine of result.split(/\r?\n/)) {
      if (!rawLine.trim()) {
        continue;
      }

      let remoteSession;
      try {
        remoteSession = JSON.parse(rawLine);
      } catch {
        continue;
      }

      if (!remoteSession?.filePath || !remoteSession.meta?.cwd) {
        continue;
      }

      const previous = this.sessions.get(remoteSession.filePath);
      const state = {
        filePath: asString(remoteSession.filePath),
        offset: 0,
        pendingText: "",
        meta: {
          id: asString(remoteSession.meta.id),
          cwd: asString(remoteSession.meta.cwd),
          originator: asString(remoteSession.meta.originator),
          source: asString(remoteSession.meta.source)
        },
        status: asString(remoteSession.status) || "unknown",
        modifiedAt: Number(remoteSession.modifiedAt || 0)
      };
      this.sessions.set(state.filePath, state);

      if (previous?.status === "active" && isTerminalStatus(state.status)) {
        this.logCompletedSession(state);
      }
    }
  }

  async processFile(filePath, workspacePaths) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      this.sessions.delete(filePath);
      return;
    }

    if (!stat.isFile()) {
      this.sessions.delete(filePath);
      return;
    }

    let state = this.sessions.get(filePath);
    const isFirstRead = !state;
    if (!state) {
      state = {
        filePath,
        offset: 0,
        pendingText: "",
        meta: null,
        status: "unknown",
        modifiedAt: 0
      };
      this.sessions.set(filePath, state);
    }

    if (stat.size < state.offset) {
      state.offset = 0;
      state.pendingText = "";
      state.meta = null;
      state.status = "unknown";
    }

    if (stat.size === state.offset) {
      return;
    }

    const chunk = await readFileChunk(filePath, state.offset, stat.size);
    state.offset = stat.size;
    state.modifiedAt = stat.mtimeMs;

    const text = state.pendingText + chunk;
    const lines = text.split("\n");
    state.pendingText = text.endsWith("\n") ? "" : lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) {
        continue;
      }

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const previousStatus = state.status;
      this.applyEntry(state, entry);

      if (!state.meta || !matchesAnyWorkspacePath(state.meta.cwd, workspacePaths)) {
        continue;
      }

      if (
        !isFirstRead &&
        previousStatus === "active" &&
        isTerminalStatus(state.status)
      ) {
        this.logCompletedSession(state);
      }
    }
  }

  applyEntry(state, entry) {
    if (entry?.type === "session_meta" && entry.payload && typeof entry.payload === "object") {
      state.meta = {
        id: asString(entry.payload.id),
        cwd: asString(entry.payload.cwd),
        originator: asString(entry.payload.originator),
        source: asString(entry.payload.source)
      };
      return;
    }

    const eventType = asString(entry?.payload?.type || entry?.method);
    if (eventType === "task_started" || eventType === "turn/started") {
      state.status = "active";
      return;
    }

    if (eventType === "task_complete" || eventType === "turn/completed") {
      state.status = "completed";
      return;
    }

    if (eventType === "turn_aborted") {
      state.status = "interrupted";
      return;
    }

    if (eventType === "stream_error" || eventType === "error") {
      state.status = "failed";
    }
  }

  logCompletedSession(state) {
    const statusText = state.status === "completed" ? "finished" : state.status;
    this.output?.appendLine(
      `Codex session ${state.meta.id || state.filePath} ${statusText} for ${state.meta.cwd}.`
    );
  }

  async showStatus() {
    await this.poll({ forceFullScan: true });

    const workspacePaths = getCurrentWorkspacePaths();
    const matchingSessions = [...this.sessions.values()]
      .filter((session) => session.meta?.cwd && matchesAnyWorkspacePath(session.meta.cwd, workspacePaths))
      .sort((left, right) => right.modifiedAt - left.modifiedAt);

    if (matchingSessions.length === 0) {
      this.reportStatus("No Codex sessions are known for the open workspace.");
      return;
    }

    const active = matchingSessions.filter((session) => session.status === "active");
    const newest = matchingSessions[0];
    const message =
      active.length > 0
        ? `${active.length} Codex session${active.length === 1 ? "" : "s"} active for this workspace.`
        : `No active Codex sessions. Latest status: ${formatStatus(newest.status)}.`;
    this.reportStatus(message);
  }

  reportStatus(message) {
    this.output?.appendLine(`[Codex] ${message}`);
    this.output?.show?.(true);
  }

  async registerTitleVariable() {
    if (this.titleVariableRegistrationAttempted) {
      return;
    }

    if (await this.ensureTitleVariableRegistered()) {
      await this.updateTitleStatus(getCurrentWorkspacePaths(), { force: true });
      this.scheduleStartupTitleRefreshes();
    }
  }

  async ensureTitleVariableRegistered() {
    this.titleVariableRegistrationAttempted = true;
    try {
      await vscode.commands.executeCommand("registerWindowTitleVariable", TITLE_VARIABLE_NAME, TITLE_CONTEXT_KEY);
      return true;
    } catch (error) {
      if (!this.titleVariableUnavailableLogged) {
        this.titleVariableUnavailableLogged = true;
        this.output?.appendLine(
          `VS Code window title variable support is unavailable: ${getErrorMessage(error)}`
        );
      }
      return false;
    }
  }

  scheduleStartupTitleRefreshes() {
    for (const delayMs of STARTUP_TITLE_REFRESH_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.titleRefreshTimers.delete(timer);
        void this.updateTitleStatus(getCurrentWorkspacePaths(), { force: true });
      }, delayMs);
      this.titleRefreshTimers.add(timer);
    }
  }

  async updateTitleStatus(workspacePaths = getCurrentWorkspacePaths(), options: any = {}) {
    await this.setTitleStatus(getTitleStatusLabel(this.sessions.values(), workspacePaths), options);
  }

  async setTitleStatus(status, _options = undefined) {
    try {
      // Re-send and re-register even when unchanged; VS Code can drop title variables after titlebar churn.
      await this.ensureTitleVariableRegistered();
      await vscode.commands.executeCommand("setContext", TITLE_CONTEXT_KEY, status);
      this.titleStatus = status;
    } catch (error) {
      this.output?.appendLine(`Failed to update Codex title status: ${getErrorMessage(error)}`);
    }
  }

  dispose() {
    this.stopTimer();
    for (const timer of this.titleRefreshTimers) {
      clearTimeout(timer);
    }
    this.titleRefreshTimers.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.sessions.clear();
  }
}

function buildRemoteCodexSessionStatusCommand(sessionsRoot, workspacePath, forceFullScan) {
  return `
sessions_root=${shellQuote(sessionsRoot)}
workspace_path=${shellQuote(workspacePath)}
scan_mode=${shellQuote(forceFullScan ? "full" : "recent")}

case "$sessions_root" in
  "~")
    sessions_root="$HOME"
    ;;
  "~/"*)
    sessions_root="$HOME/\${sessions_root#\\~/}"
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

node - "$sessions_root" "$workspace_path" "$scan_mode" <<'NODE'
const fs = require("fs");
const path = require("path");

const [root, workspace, scanMode] = process.argv.slice(2);
const dayMs = 24 * 60 * 60 * 1000;

function normalize(value) {
  const normalized = path.posix.normalize(String(value || ""));
  if (normalized === path.posix.sep) {
    return normalized;
  }
  return normalized.endsWith(path.posix.sep) ? normalized.slice(0, -1) : normalized;
}

function canonical(value) {
  const normalized = normalize(value);
  try {
    return fs.existsSync(normalized) ? normalize(fs.realpathSync(normalized)) : normalized;
  } catch {
    return normalized;
  }
}

function isSameOrDescendant(candidate, base) {
  if (!candidate || !base) {
    return false;
  }
  if (candidate === base) {
    return true;
  }
  const normalizedBase = base.endsWith(path.posix.sep) ? base : base + path.posix.sep;
  return candidate.startsWith(normalizedBase);
}

function matchesWorkspace(candidatePath) {
  const candidates = [normalize(candidatePath), canonical(candidatePath)];
  const workspaces = [normalize(workspace), canonical(workspace)];
  return candidates.some((candidate) =>
    workspaces.some((workspacePath) => isSameOrDescendant(candidate, workspacePath))
  );
}

function isCodexSessionFile(fileName) {
  return fileName.startsWith("rollout-") && fileName.endsWith(".jsonl");
}

function collectFiles(dirPath, recursive, results) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.posix.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        collectFiles(entryPath, recursive, results);
      }
      continue;
    }

    if (entry.isFile() && isCodexSessionFile(entry.name)) {
      results.push(entryPath);
    }
  }
}

function getRecentSessionDateDirs(rootPath) {
  const dirs = [];
  for (let offset = -${RECENT_SCAN_DAY_SPAN}; offset <= 1; offset += 1) {
    const date = new Date(Date.now() + offset * dayMs);
    dirs.push(
      path.posix.join(
        rootPath,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
      )
    );
  }
  return dirs;
}

function applyEntry(state, entry) {
  if (entry?.type === "session_meta" && entry.payload && typeof entry.payload === "object") {
    state.meta = {
      id: typeof entry.payload.id === "string" ? entry.payload.id : "",
      cwd: typeof entry.payload.cwd === "string" ? entry.payload.cwd : "",
      originator: typeof entry.payload.originator === "string" ? entry.payload.originator : "",
      source: typeof entry.payload.source === "string" ? entry.payload.source : ""
    };
    return;
  }

  const eventType = String(entry?.payload?.type || entry?.method || "");
  if (eventType === "task_started" || eventType === "turn/started") {
    state.status = "active";
    return;
  }

  if (eventType === "task_complete" || eventType === "turn/completed") {
    state.status = "completed";
    return;
  }

  if (eventType === "turn_aborted") {
    state.status = "interrupted";
    return;
  }

  if (eventType === "stream_error" || eventType === "error") {
    state.status = "failed";
  }
}

function readSession(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const state = {
    filePath,
    modifiedAt: stat.mtimeMs,
    meta: null,
    status: "unknown"
  };

  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  for (const rawLine of text.split("\\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    try {
      applyEntry(state, JSON.parse(line));
    } catch {
      continue;
    }
  }

  if (!state.meta?.cwd || !matchesWorkspace(state.meta.cwd)) {
    return null;
  }

  return state;
}

const files = [];
if (scanMode === "full") {
  collectFiles(root, true, files);
} else {
  for (const dirPath of getRecentSessionDateDirs(root)) {
    collectFiles(dirPath, false, files);
  }
}

for (const filePath of files) {
  const session = readSession(filePath);
  if (session) {
    console.log(JSON.stringify(session));
  }
}
NODE
`;
}

async function readFileChunk(filePath, start, end) {
  if (end <= start) {
    return "";
  }

  const handle = await fs.open(filePath, "r");
  try {
    const length = end - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function collectCodexSessionFiles(root) {
  const results = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (entry.isFile() && isCodexSessionFileName(entry.name)) {
        results.push(entryPath);
      }
    }
  }

  return results;
}

async function collectRecentCodexSessionFiles(root) {
  const results = [];
  for (const dirPath of getRecentSessionDateDirs(root)) {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && isCodexSessionFileName(entry.name)) {
        results.push(path.join(dirPath, entry.name));
      }
    }
  }

  return results;
}

function getRecentSessionDateDirs(root) {
  const dirs = [];
  const now = new Date();
  for (let offset = -RECENT_SCAN_DAY_SPAN; offset <= 1; offset += 1) {
    const date = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    dirs.push(
      path.join(
        root,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
      )
    );
  }
  return dirs;
}

function isCodexSessionFileName(fileName) {
  return fileName.startsWith("rollout-") && fileName.endsWith(".jsonl");
}

function getCurrentWorkspacePaths(location = tryGetCurrentWorkspaceLocation()) {
  if (location) {
    return [normalizeComparablePath(location.workspacePath)].filter(Boolean);
  }

  return getWorkspaceFolderPaths();
}

function getWorkspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder.uri.fsPath || folder.uri.path)
    .map(normalizeComparablePath)
    .filter(Boolean);
}

function matchesAnyWorkspacePath(candidatePath, workspacePaths) {
  const candidate = normalizeComparablePath(candidatePath);
  return workspacePaths.some((workspacePath) => candidate === workspacePath || isDescendantPath(candidate, workspacePath));
}

function isDescendantPath(candidatePath, basePath) {
  const base = basePath.endsWith(path.sep) ? basePath : `${basePath}${path.sep}`;
  return candidatePath.startsWith(base);
}

function normalizeComparablePath(inputPath) {
  const value = String(inputPath || "").trim();
  if (!value) {
    return "";
  }

  const normalized = path.normalize(value);
  return normalized !== path.sep && normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
}

function getTitleStatusLabel(sessions, workspacePaths) {
  const matchingSessions = [...sessions]
    .filter((session) => session.meta?.cwd && matchesAnyWorkspacePath(session.meta.cwd, workspacePaths))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const active = matchingSessions.filter((session) => session.status === "active");

  if (active.length === 1) {
    return "🟡";
  }

  if (active.length > 1) {
    return "🟡";
  }

  const latest = matchingSessions[0];
  if (!latest) {
    return CODEX_IDLE_STATUS;
  }

  return formatStatusLabel(latest.status);
}

function expandHome(inputPath) {
  const value = String(inputPath || "").trim() || "~/.codex/sessions";
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function normalizePollInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(parsed));
}

function isTerminalStatus(status) {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function formatStatus(status) {
  if (status === "unknown") {
    return "unknown";
  }

  return status;
}

function formatStatusLabel(status) {
  if (status === "completed") {
    return "🟢";
  }

  if (status === "active") {
    return "🟡";
  }

  if (status === "failed") {
    return "🔴";
  }

  if (status === "interrupted") {
    return "🟠";
  }

  return CODEX_IDLE_STATUS;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  CodexSessionWatcher,
  startCodexSessionWatcher
};
