const net = require("node:net");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const vscode = require("vscode");

const { getConfig } = require("./config");
const { ensureLocalCommandAvailable, runLocalShellCommand, shellQuote } = require("./shell");
const { createTargetAdapter } = require("./target-adapters");
const { buildWorkspaceUri, tryGetCurrentWorkspaceLocation } = require("./targets");

const MIN_PORT = 3000;
const MAX_PORT = 9999;
const BROWSER_TAB_TIMEOUT_MS = 1500;
const SHELL_INTEGRATION_TIMEOUT_MS = 3000;
const SERVER_READY_TIMEOUT_MS = 60000;
const SERVER_STOP_TIMEOUT_MS = 10000;
const READY_PATTERN = /\bready\b/i;
const PREVIEW_STATUS_IDLE = "idle";
const PREVIEW_STATUS_STARTING = "starting";
const PREVIEW_STATUS_RUNNING = "running";
const PREVIEW_ACTION_START = "start";
const PREVIEW_ACTION_OPEN_PREVIEW = "open-preview";
const PREVIEW_ACTION_OPEN_EXTERNAL_BROWSER = "open-external-browser";
const PREVIEW_ACTION_OPEN_VSCODE_BROWSER = "open-vscode-browser";
const PREVIEW_ACTION_OPEN_TERMINAL = "open-terminal";
const PREVIEW_ACTION_RESTART = "restart";
const PREVIEW_ACTION_STOP = "stop";
const previewSessions = new Map();
const pendingPreviewActions = new Map();
const remotePreviewRecoveryPromises = new Map();
const appPreviewStateEmitter = new vscode.EventEmitter();
let previewStatusBarItem;
let previewOutputChannel;
const previewTerminalsBeingReplaced = new WeakSet();

function initializeAppPreviewStatusBar(context, output) {
  previewOutputChannel = output;

  if (previewStatusBarItem) {
    void recoverCurrentRemotePreviewSession(previewOutputChannel);
    return;
  }

  previewStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  previewStatusBarItem.name = "Treehouse App Preview";

  context.subscriptions.push(
    previewStatusBarItem,
    appPreviewStateEmitter,
    vscode.window.onDidCloseTerminal((terminal) => {
      if (previewTerminalsBeingReplaced.has(terminal)) {
        previewTerminalsBeingReplaced.delete(terminal);
        return;
      }
      if (removePreviewSessionForTerminal(terminal)) {
        refreshAppPreviewStatusBar();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void recoverCurrentRemotePreviewSession(previewOutputChannel);
      refreshAppPreviewStatusBar();
    })
  );

  void recoverCurrentRemotePreviewSession(previewOutputChannel);
  refreshAppPreviewStatusBar();
}

async function openAppPreview(output) {
  return openAppPreviewWithTarget(output);
}

async function openAppPreviewExternalBrowser(output) {
  return openAppPreviewWithTarget(output, "externalBrowser");
}

async function openAppPreviewInVsCodeBrowser(output) {
  return openAppPreviewWithTarget(output, "vscodeBrowser");
}

async function openAppPreviewWithTarget(output, openTarget) {
  const pendingSessionKey = markCurrentWorkspacePreviewActionPending(getAppPreviewPendingAction(openTarget));
  try {
    const { hadExistingSession, session, startedServer, workspace } = await ensurePreviewSession(output);
    const { probePort, remotePort } = session;

    if (output) {
      output.appendLine(
        hadExistingSession || session.recovered
          ? `Reusing app preview in ${workspace.workspacePath}`
          : `Starting app preview in ${workspace.workspacePath}`
      );
      if (session.target?.type === "ssh") {
        output.appendLine(
          `Using remote port ${remotePort} on ${session.target.label} and local forwarded port ${probePort}`
        );
      } else {
        output.appendLine(`Using port ${remotePort}`);
      }
    }

    if (startedServer && session.target?.type === "ssh") {
      await attachRemoteDevServerTerminal(session, workspace, output);
    }

    const previewOpened = await openPreviewUrl(session, output, openTarget);
    if (!previewOpened) {
      throw new Error("Treehouse could not open the app preview.");
    }

    if (previewOpened.openedNewTab) {
      await pinActiveBrowserTab(output);
    }
  } finally {
    clearPreviewActionPending(pendingSessionKey);
  }
}

async function openDevServerTerminal(output) {
  const pendingSessionKey = markCurrentWorkspacePreviewActionPending(PREVIEW_ACTION_OPEN_TERMINAL);
  try {
    const { session, workspace } = await ensurePreviewSession(output);

    if (session.target?.type === "ssh") {
      await attachRemoteDevServerTerminal(session, workspace, output);
      return;
    }

    const terminal = ensurePreviewTerminal(session);
    terminal.show(true);
  } finally {
    clearPreviewActionPending(pendingSessionKey);
  }
}

async function restartAppPreview(output) {
  const pendingSessionKey = markCurrentWorkspacePreviewActionPending(PREVIEW_ACTION_RESTART);
  try {
    const workspace = getCurrentWorkspaceContext();
    if (!workspace) {
      throw new Error("Treehouse needs an open workspace folder to restart the dev server.");
    }

    await ensurePreviewPrerequisites(workspace);

    const session = await getOrCreatePreviewSession(workspace, output);
    const serverRunning = await isPreviewServerRunning(session, workspace);

    updatePreviewSessionStatus(session, PREVIEW_STATUS_STARTING);
    try {
      if (serverRunning) {
        output?.appendLine(
          session.target?.type === "ssh"
            ? `Restarting remote dev server on ${session.target.label}:${session.remotePort}.`
            : `Restarting dev server on port ${session.remotePort}.`
        );
        await restartDevServer(session, workspace, output);
      } else {
        output?.appendLine(
          session.target?.type === "ssh"
            ? `Remote dev server is not running on ${session.target.label}:${session.remotePort}. Starting it.`
            : `Dev server is not running on port ${session.remotePort}. Starting it.`
        );
        await startDevServer(session, output);
      }
    } catch (error) {
      updatePreviewSessionStatus(session);
      throw error;
    }

    ensurePreviewSessionRegistered(session);
    updatePreviewSessionStatus(session, PREVIEW_STATUS_RUNNING);
  } finally {
    clearPreviewActionPending(pendingSessionKey);
  }
}

async function stopAppPreview(output) {
  const pendingSessionKey = markCurrentWorkspacePreviewActionPending(PREVIEW_ACTION_STOP);
  try {
    const workspace = getCurrentWorkspaceContext();
    if (!workspace) {
      throw new Error("Treehouse needs an open workspace folder to stop the dev server.");
    }

    const stopped = await stopPreviewForWorkspace(workspace.location, output);
    if (!stopped) {
      output?.appendLine("Dev server is not running for the current workspace.");
    }
  } finally {
    clearPreviewActionPending(pendingSessionKey);
  }
}

async function openPreviewUrl(session, output, openTarget = getConfig().appPreviewOpenTarget) {
  if (openTarget === "vscodeBrowser") {
    return openBrowserTab(session, output);
  }

  const opened = await vscode.env.openExternal(vscode.Uri.parse(session.url));
  if (!opened) {
    return undefined;
  }

  if (output) {
    output.appendLine(`Opened app preview in external browser: ${session.url}`);
  }

  return { openedNewTab: false };
}

async function openBrowserTab(session, output) {
  const existingBrowserTab = findReusableBrowserTab(session);
  if (existingBrowserTab) {
    if (output) {
      output.appendLine("Reusing existing browser tab.");
    }

    const reused = await revealExistingBrowserTab(existingBrowserTab);
    if (reused) {
      session.browserTab = existingBrowserTab;
      return { openedNewTab: false };
    }
  }

  const { url } = session;
  const previousActiveTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  await executeBrowserOpenCommand(url);

  const { activeTab, changed } = await waitForBrowserTab(previousActiveTab);
  if (!activeTab) {
    return undefined;
  }

  session.browserTab = activeTab;

  if (!changed && output) {
    output.appendLine("Browser command completed without changing the active tab. Pinning the current active tab.");
  }

  return { openedNewTab: true };
}

async function pinActiveBrowserTab(output) {
  try {
    await vscode.commands.executeCommand("workbench.action.pinEditor");
    return true;
  } catch (error) {
    if (output) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Failed to pin browser tab: ${message}`);
    }
    return false;
  }
}

async function createPreviewSession(workspace, output) {
  return createPreviewSessionWithOptions(workspace, output);
}

async function createPreviewSessionWithOptions(workspace, output, options = {}) {
  const previewTarget =
    options.previewTarget ||
    (await resolvePreviewTarget(workspace, output, {
      allowPrompt: !options.recovered && options.allowPreviewTargetPrompt !== false
    }));
  const remotePort = Number.isInteger(options.remotePort)
    ? options.remotePort
    : Number.isInteger(previewTarget.primaryPort)
      ? previewTarget.primaryPort
      : await findPreviewPort(workspace);
  const resolvedPreviewTarget = resolvePreviewTargetPort(previewTarget, remotePort);
  let probePort = remotePort;
  let url;
  let tunnelProcess;

  if (workspace.location?.target?.type === "ssh") {
    const portForward = await getOrCreateSshPortForward(workspace.location.target, remotePort, output);
    probePort = portForward.localPort;
    tunnelProcess = portForward.tunnelProcess;
    url = `https://localhost:${probePort}/app`;
  } else {
    url = (await vscode.env.asExternalUri(vscode.Uri.parse(`https://localhost:${remotePort}/app`))).toString(true);
  }

  const shouldCreateTerminal =
    !options.skipTerminal && workspace.location?.target?.type !== "ssh";
  const terminal = shouldCreateTerminal ? createPreviewTerminal(workspace.workspaceUri, remotePort) : undefined;
  const session = {
    allowMissingTerminal:
      workspace.location?.target?.type === "ssh" || Boolean(options.allowMissingTerminal),
    probePort,
    remoteSessionName: workspace.location?.target?.type === "ssh" ? getRemotePreviewSessionName(workspace) : undefined,
    recovered: Boolean(options.recovered),
    remotePort,
    sessionKey: workspace.sessionKey,
    status: options.status || PREVIEW_STATUS_IDLE,
    target: workspace.location?.target || null,
    terminal,
    tunnelProcess,
    url,
    commandLine: resolvedPreviewTarget.commandLine,
    previewTarget: resolvedPreviewTarget,
    workspacePath: workspace.workspacePath,
    workspaceUri: workspace.workspaceUri
  };

  registerPreviewSession(session);
  return session;
}

async function resolvePreviewTarget(workspace, output, options = {}) {
  const workspaceInfo = await inspectWorkspacePackages(workspace);
  const runnableWorkspaces = workspaceInfo.workspaces.filter((entry) => entry.hasDevScript);
  const monorepoCandidates = workspaceInfo.isMonorepo ? runnableWorkspaces : [];

  if (monorepoCandidates.length === 0) {
    return buildRootPreviewTarget();
  }

  let selectedCandidate = getDefaultPreviewCandidate(monorepoCandidates);
  if (monorepoCandidates.length > 1 && options.allowPrompt !== false) {
    selectedCandidate = await promptForPreviewTarget(monorepoCandidates, {
      startsAllDevServers: workspaceInfo.rootHasDevScript
    });
  }

  if (!selectedCandidate) {
    return buildRootPreviewTarget();
  }

  if (workspaceInfo.rootHasDevScript) {
    const previewTarget = buildMonorepoPreviewTarget(monorepoCandidates, selectedCandidate);
    output?.appendLine(`Using ${previewTarget.label} for app preview.`);
    return previewTarget;
  }

  const previewTarget = buildWorkspacePreviewTarget(selectedCandidate);
  output?.appendLine(`Using ${previewTarget.label} for app preview.`);
  return previewTarget;
}

async function inspectWorkspacePackages(workspace) {
  const adapter = workspace.location?.target ? createTargetAdapter(workspace.location.target) : null;
  const command = `node -e ${shellQuote(buildWorkspacePackageInspectionScript())}`;
  const rawOutput = adapter
    ? await adapter.runCommand(command, workspace.workspacePath)
    : await runLocalShellCommand(command, workspace.workspacePath);

  try {
    const parsed = JSON.parse(rawOutput);
    return {
      isMonorepo: Boolean(parsed?.isMonorepo),
      rootHasDevScript: Boolean(parsed?.rootHasDevScript),
      workspaces: Array.isArray(parsed?.workspaces) ? parsed.workspaces.map(normalizePreviewWorkspaceCandidate) : []
    };
  } catch (error) {
    throw new Error(
      `Treehouse could not inspect workspace package.json files: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function normalizePreviewWorkspaceCandidate(candidate) {
  const relativePath = String(candidate?.relativePath || "").trim();
  const packageName = String(candidate?.packageName || "").trim();
  const devScript = String(candidate?.devScript || "").trim();
  const kind = String(candidate?.kind || "").trim();
  const explicitPort = normalizePort(candidate?.port);
  const folderName = relativePath.split(/[\\/]/).filter(Boolean).pop() || relativePath || packageName;

  return {
    devScript,
    displayName: packageName || folderName,
    hasDevScript: Boolean(devScript),
    kind,
    packageName,
    port: explicitPort || inferDevScriptPort(devScript),
    relativePath
  };
}

function getDefaultPreviewCandidate(candidates) {
  return candidates.find((candidate) => Number.isInteger(candidate.port)) || candidates[0];
}

async function promptForPreviewTarget(candidates, options = {}) {
  const items = candidates.map((candidate) => ({
    label: candidate.displayName,
    description: candidate.relativePath,
    detail: Number.isInteger(candidate.port)
      ? `${candidate.devScript} (port ${candidate.port})`
      : candidate.devScript,
    candidate
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: options.startsAllDevServers
      ? "Select the app to open after starting all dev servers"
      : "Select an app to preview"
  });

  if (!selected) {
    throw new Error("Select an app before starting the Treehouse preview.");
  }

  return selected.candidate;
}

function buildRootPreviewTarget() {
  return {
    commandKind: "root",
    isRoot: true,
    label: "workspace root"
  };
}

function buildWorkspacePreviewTarget(candidate) {
  const filter = candidate.packageName || `./${candidate.relativePath}`;
  return {
    commandKind: "workspace",
    filter,
    isRoot: false,
    label: `${candidate.displayName} (${candidate.relativePath})`,
    packageName: candidate.packageName,
    primaryPort: candidate.port,
    relativePath: candidate.relativePath
  };
}

function buildMonorepoPreviewTarget(candidates, primaryCandidate) {
  const ports = candidates
    .filter((candidate) => Number.isInteger(candidate.port))
    .map((candidate) => ({
      label: candidate.displayName,
      port: candidate.port,
      relativePath: candidate.relativePath
    }));

  return {
    commandKind: "monorepo",
    commandLine: "pnpm dev",
    isRoot: true,
    label: `all dev servers (${primaryCandidate.displayName})`,
    primaryPackageName: primaryCandidate.packageName,
    primaryPort: primaryCandidate.port,
    primaryRelativePath: primaryCandidate.relativePath,
    startsAllDevServers: true,
    ports
  };
}

function resolvePreviewTargetPort(previewTarget, remotePort) {
  if (previewTarget.commandKind === "monorepo") {
    const primaryPort = Number.isInteger(remotePort) ? remotePort : previewTarget.primaryPort;
    const primaryApp = previewTarget.ports?.find((entry) => entry.port === primaryPort);
    return {
      ...previewTarget,
      commandLine: previewTarget.commandLine || "pnpm dev",
      label: primaryApp ? `all dev servers (${primaryApp.label})` : previewTarget.label,
      primaryPort,
      primaryRelativePath: primaryApp?.relativePath || previewTarget.primaryRelativePath
    };
  }

  if (previewTarget.commandKind === "workspace") {
    return {
      ...previewTarget,
      commandLine: `pnpm --filter ${shellQuote(previewTarget.filter)} dev -p ${Number(remotePort)}`,
      primaryPort: remotePort
    };
  }

  return {
    ...previewTarget,
    commandLine: buildDefaultPreviewCommand(remotePort),
    primaryPort: remotePort
  };
}

function buildDefaultPreviewCommand(remotePort) {
  return `pnpm dev -p ${Number(remotePort)}`;
}

function inferDevScriptPort(devScript) {
  const match = String(devScript || "").match(/(?:^|\s)(?:--port|-p)(?:=|\s+)(\d{2,5})(?=\s|$)/);
  if (!match) {
    return undefined;
  }

  return normalizePort(match[1]);
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function buildWorkspacePackageInspectionScript() {
  return `
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const skipDirs = new Set([".git", ".next", ".turbo", "dist", "build", "coverage", "node_modules"]);

function readPackageJson(packageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function hasDirectory(relativePath) {
  try {
    return fs.statSync(path.join(root, relativePath)).isDirectory();
  } catch {
    return false;
  }
}

function hasFile(relativePath) {
  try {
    return fs.statSync(path.join(root, relativePath)).isFile();
  } catch {
    return false;
  }
}

function inferPortFromText(text) {
  const patterns = [
    /(?:^|\\s)(?:--port|-p)(?:=|\\s+)(\\d{2,5})(?=\\s|$)/,
    /\\.listen\\(\\s*(\\d{2,5})\\b/
  ];

  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (!match) {
      continue;
    }

    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
  }

  return undefined;
}

function inferPortFromEnvFiles(packageDir) {
  for (const fileName of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(packageDir, fileName), "utf8");
    } catch {
      continue;
    }

    const match = text.match(/^(?:PORT|APP_PORT|API_PORT|BACKEND_PORT|NEST_PORT)=(\\d{2,5})\\s*$/m);
    if (!match) {
      continue;
    }

    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
  }

  return undefined;
}

function inferPortFromSourceFiles(packageDir) {
  for (const relativeFile of ["src/main.ts", "src/main.js", "main.ts", "main.js", "server.ts", "server.js"]) {
    try {
      const port = inferPortFromText(fs.readFileSync(path.join(packageDir, relativeFile), "utf8"));
      if (port) {
        return port;
      }
    } catch {}
  }

  return undefined;
}

function collectWorkspacePackages(relativeRoot, depthRemaining, candidates) {
  const absoluteRoot = path.join(root, relativeRoot);
  let entries;
  try {
    entries = fs.readdirSync(absoluteRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || skipDirs.has(entry.name)) {
      continue;
    }

    const relativePath = path.join(relativeRoot, entry.name);
    const packageDir = path.join(root, relativePath);
    const packageJson = readPackageJson(packageDir);
    if (packageJson) {
      const devScript = typeof packageJson.scripts?.dev === "string" ? packageJson.scripts.dev.trim() : "";
      candidates.push({
        devScript,
        hasDevScript: Boolean(devScript),
        kind: relativeRoot.split(/[\\\\/]/)[0],
        packageName: typeof packageJson.name === "string" ? packageJson.name : "",
        port: inferPortFromText(devScript) || inferPortFromEnvFiles(packageDir) || inferPortFromSourceFiles(packageDir),
        relativePath: relativePath.split(path.sep).join("/")
      });
    }

    if (depthRemaining > 0) {
      collectWorkspacePackages(relativePath, depthRemaining - 1, candidates);
    }
  }
}

const rootPackage = readPackageJson(root);
const workspaces = [];
for (const relativeRoot of ["apps", "packages"]) {
  collectWorkspacePackages(relativeRoot, 3, workspaces);
}

const rootDevScript = typeof rootPackage?.scripts?.dev === "string" ? rootPackage.scripts.dev.trim() : "";
const isMonorepo =
  workspaces.length > 0 &&
  (hasFile("turbo.json") ||
    hasFile("pnpm-workspace.yaml") ||
    hasDirectory("apps") ||
    hasDirectory("packages") ||
    /(^|[\\s])turbo([\\s]|$)/.test(rootDevScript));

workspaces.sort((left, right) => {
  const kindOrder = { apps: 0, packages: 1 };
  const leftKind = kindOrder[left.kind] ?? 2;
  const rightKind = kindOrder[right.kind] ?? 2;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  return left.relativePath.localeCompare(right.relativePath);
});

process.stdout.write(JSON.stringify({
  isMonorepo,
  rootHasDevScript: Boolean(rootDevScript),
  workspaces
}));
`;
}

function getExistingSession(sessionKey) {
  const session = previewSessions.get(sessionKey);
  if (!session) {
    return undefined;
  }

  if (!isPreviewSessionUsable(session)) {
    clearPreviewSession(sessionKey);
    return undefined;
  }

  return session;
}

function updatePreviewSessionStatus(session, status) {
  session.status = status;
  refreshAppPreviewStatusBar();
}

function refreshAppPreviewStatusBar() {
  if (!previewStatusBarItem) {
    return;
  }

  const workspace = getCurrentWorkspaceContext();
  if (!workspace) {
    previewStatusBarItem.hide();
    appPreviewStateEmitter.fire();
    return;
  }

  const session = getActiveWorkspacePreviewSession();
  const pendingAction = pendingPreviewActions.get(workspace.sessionKey);
  if (pendingAction) {
    showPendingPreviewActionStatusBar(pendingAction, session);
    return;
  }

  if (!session && workspace.location?.target?.type === "ssh" && remotePreviewRecoveryPromises.has(workspace.sessionKey)) {
    previewStatusBarItem.text = "$(loading~spin) Dev Server: checking";
    previewStatusBarItem.tooltip = "Treehouse is checking for an existing remote dev server. Controls are in the Treehouse Dev Servers view.";
    previewStatusBarItem.command = undefined;
    previewStatusBarItem.show();
    appPreviewStateEmitter.fire();
    return;
  }

  if (!session?.status || session.status === PREVIEW_STATUS_IDLE) {
    previewStatusBarItem.text = "$(circle-slash) Dev Server: stopped";
    previewStatusBarItem.tooltip = "Treehouse app preview is not running. Controls are in the Treehouse Dev Servers view.";
    previewStatusBarItem.command = undefined;
    previewStatusBarItem.show();
    appPreviewStateEmitter.fire();
    return;
  }

  if (session.status === PREVIEW_STATUS_STARTING) {
    showPendingPreviewActionStatusBar(PREVIEW_ACTION_START, session);
    return;
  } else {
    renderRunningPreviewStatusBar(session);
  }

  previewStatusBarItem.show();
  appPreviewStateEmitter.fire();
}

function getActiveWorkspacePreviewSession() {
  const workspace = getCurrentWorkspaceContext();
  if (!workspace) {
    return undefined;
  }

  return getExistingSession(workspace.sessionKey);
}

function removePreviewSessionForTerminal(terminal) {
  for (const [sessionKey, session] of previewSessions.entries()) {
    if (session.terminal !== terminal) {
      continue;
    }

    clearPreviewSession(sessionKey);
    return true;
  }

  return false;
}

function clearPreviewSession(sessionKey) {
  const session = previewSessions.get(sessionKey);
  if (session?.tunnelProcess && !session.tunnelProcess.killed && session.tunnelProcess.exitCode === null) {
    session.tunnelProcess.kill("SIGTERM");
  }
  previewSessions.delete(sessionKey);
  pendingPreviewActions.delete(sessionKey);
  refreshAppPreviewStatusBar();
}

async function stopPreviewForWorkspace(workspaceLocation, output) {
  const workspace = getWorkspaceContextForLocation(workspaceLocation);
  if (!workspace) {
    return false;
  }

  const trackedSession = previewSessions.get(workspace.sessionKey);
  if (workspace.location?.target?.type === "ssh") {
    const stopped = await stopRemotePreviewForWorkspace(workspace, trackedSession, output);
    if (trackedSession) {
      clearPreviewSession(workspace.sessionKey);
    } else {
      pendingPreviewActions.delete(workspace.sessionKey);
      refreshAppPreviewStatusBar();
    }
    return stopped;
  }

  if (!trackedSession) {
    return false;
  }

  if (await isPreviewServerRunning(trackedSession, workspace)) {
    await stopLocalDevServer(trackedSession, output);
  }
  clearPreviewSession(workspace.sessionKey);
  return true;
}

function getWorkspaceContextForLocation(workspaceLocation) {
  if (!workspaceLocation?.target || !workspaceLocation.workspacePath) {
    return null;
  }

  const workspaceUri =
    workspaceLocation.workspaceUri || buildWorkspaceUri(workspaceLocation.target, workspaceLocation.workspacePath);
  return {
    location: workspaceLocation,
    sessionKey: workspaceUri.toString(),
    workspacePath: workspaceLocation.workspacePath,
    workspaceUri
  };
}

async function stopRemotePreviewForWorkspace(workspace, trackedSession, output) {
  const remotePort = trackedSession?.remotePort || (await findRunningRemotePreviewPort(workspace));
  const existingTunnel =
    !trackedSession?.probePort && remotePort
      ? await findExistingSshPortForward(workspace.location.target, remotePort)
      : undefined;
  const probePort = trackedSession?.probePort || existingTunnel?.localPort || remotePort;
  const session =
    trackedSession ||
    (remotePort
      ? {
          allowMissingTerminal: true,
          probePort,
          remotePort,
          remoteSessionName: getRemotePreviewSessionName(workspace),
          sessionKey: workspace.sessionKey,
          status: PREVIEW_STATUS_RUNNING,
          target: workspace.location.target,
          workspacePath: workspace.workspacePath,
          workspaceUri: workspace.workspaceUri
        }
      : undefined);

  let stopped = false;
  if (session?.remotePort) {
    output?.appendLine(
      `Stopping remote dev server before removing worktree on ${session.target.label}:${session.remotePort}.`
    );
    await stopRemoteDevServer(session, workspace, output);
    stopped = true;
  }

  if (session?.remotePort && session?.probePort) {
    stopped = (await stopSshPortForward(session, output)) || stopped;
  }

  return stopped;
}

function markCurrentWorkspacePreviewActionPending(action) {
  const workspace = getCurrentWorkspaceContext();
  if (!workspace) {
    return undefined;
  }

  pendingPreviewActions.set(workspace.sessionKey, action);
  refreshAppPreviewStatusBar();
  return workspace.sessionKey;
}

function clearPreviewActionPending(sessionKey) {
  if (!sessionKey) {
    return;
  }

  pendingPreviewActions.delete(sessionKey);
  refreshAppPreviewStatusBar();
}

function getAppPreviewPendingAction(openTarget) {
  const workspace = getCurrentWorkspaceContext();
  if (!workspace) {
    return PREVIEW_ACTION_START;
  }

  const session = getExistingSession(workspace.sessionKey);
  if (session?.status !== PREVIEW_STATUS_RUNNING) {
    return PREVIEW_ACTION_START;
  }

  if (openTarget === "externalBrowser") {
    return PREVIEW_ACTION_OPEN_EXTERNAL_BROWSER;
  }

  if (openTarget === "vscodeBrowser") {
    return PREVIEW_ACTION_OPEN_VSCODE_BROWSER;
  }

  return PREVIEW_ACTION_OPEN_PREVIEW;
}

function getAppPreviewState() {
  const workspace = getCurrentWorkspaceContext();
  if (!workspace) {
    return {
      hasWorkspace: false,
      status: "no-workspace",
      title: "No workspace",
      description: "Open a workspace folder"
    };
  }

  const session = getActiveWorkspacePreviewSession();
  const pendingAction = pendingPreviewActions.get(workspace.sessionKey);
  const isRecovering =
    !session && workspace.location?.target?.type === "ssh" && remotePreviewRecoveryPromises.has(workspace.sessionKey);

  if (pendingAction) {
    const pendingState = getPendingPreviewActionState(pendingAction, session);
    return {
      hasWorkspace: true,
      pendingAction,
      port: session?.remotePort,
      status: getPendingActionStatus(pendingAction),
      targetLabel: workspace.location?.target?.label,
      title: pendingState.text.replace(/^\$\(loading~spin\)\s*/, ""),
      description: pendingState.tooltip,
      url: session?.url,
      workspacePath: workspace.workspacePath
    };
  }

  if (isRecovering) {
    return {
      hasWorkspace: true,
      status: "checking",
      targetLabel: workspace.location?.target?.label,
      title: "Checking for dev server",
      description: "Treehouse is checking for an existing remote dev server.",
      workspacePath: workspace.workspacePath
    };
  }

  if (session?.status === PREVIEW_STATUS_RUNNING) {
    return {
      hasWorkspace: true,
      port: session.remotePort,
      status: "running",
      targetLabel: workspace.location?.target?.label,
      title: sessionStartsAllDevServers(session)
        ? `Running all dev servers; preview on port ${session.remotePort}`
        : `Running on port ${session.remotePort}`,
      description: sessionStartsAllDevServers(session)
        ? `Treehouse monorepo dev servers are running. Preview: ${session.url}`
        : session.url,
      url: session.url,
      workspacePath: workspace.workspacePath
    };
  }

  if (session?.status === PREVIEW_STATUS_STARTING) {
    return {
      hasWorkspace: true,
      port: session.remotePort,
      status: "starting",
      targetLabel: workspace.location?.target?.label,
      title: sessionStartsAllDevServers(session) ? "Starting dev servers" : "Starting dev server",
      description: sessionStartsAllDevServers(session)
        ? session.url || "Treehouse is starting the monorepo dev servers."
        : session.url || "Treehouse is starting the dev server.",
      url: session.url,
      workspacePath: workspace.workspacePath
    };
  }

  return {
    hasWorkspace: true,
    status: "stopped",
    targetLabel: workspace.location?.target?.label,
    title: "Stopped",
    description: "Treehouse app preview is not running.",
    workspacePath: workspace.workspacePath
  };
}

function getPendingActionStatus(action) {
  switch (action) {
    case PREVIEW_ACTION_OPEN_TERMINAL:
      return "opening-terminal";
    case PREVIEW_ACTION_OPEN_PREVIEW:
    case PREVIEW_ACTION_OPEN_EXTERNAL_BROWSER:
    case PREVIEW_ACTION_OPEN_VSCODE_BROWSER:
      return "opening-preview";
    case PREVIEW_ACTION_RESTART:
      return "restarting";
    case PREVIEW_ACTION_STOP:
      return "stopping";
    case PREVIEW_ACTION_START:
    default:
      return "starting";
  }
}

function showPendingPreviewActionStatusBar(action, session) {
  const state = getPendingPreviewActionState(action, session);
  previewStatusBarItem.text = state.text;
  previewStatusBarItem.tooltip = `${state.tooltip} Controls are in the Treehouse Dev Servers view.`;
  previewStatusBarItem.command = undefined;
  previewStatusBarItem.show();
  appPreviewStateEmitter.fire();
}

function renderRunningPreviewStatusBar(session) {
  previewStatusBarItem.text = sessionStartsAllDevServers(session)
    ? `$(radio-tower) Dev Servers running, preview on port ${session.remotePort}`
    : `$(radio-tower) Dev Server running on port ${session.remotePort}`;
  previewStatusBarItem.tooltip = sessionStartsAllDevServers(session)
    ? `Treehouse monorepo dev servers are running. The preview opens ${session.url}. Controls are in the Treehouse Dev Servers view.`
    : `Treehouse app preview is running on ${session.url}. Controls are in the Treehouse Dev Servers view.`;
  previewStatusBarItem.command = undefined;
  previewStatusBarItem.show();
}

async function stopSshPortForward(session, output) {
  if (session?.target?.type !== "ssh" || !session.probePort || !session.remotePort) {
    return false;
  }

  if (session.tunnelProcess && !session.tunnelProcess.killed && session.tunnelProcess.exitCode === null) {
    output?.appendLine(`Stopping SSH port forward on local port ${session.probePort}.`);
    session.tunnelProcess.kill("SIGTERM");
    session.tunnelProcess = undefined;
    await waitForSshPortForwardStopped(session.target, session.probePort, session.remotePort);
    return true;
  }

  const existingTunnel = await findExistingSshPortForward(session.target, session.remotePort, session.probePort);
  if (!existingTunnel) {
    return false;
  }

  output?.appendLine(`Stopping SSH port forward on local port ${session.probePort} (pid ${existingTunnel.pid}).`);
  try {
    process.kill(existingTunnel.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  await waitForSshPortForwardStopped(session.target, session.probePort, session.remotePort);
  return true;
}

async function waitForSshPortForwardStopped(target, localPort, remotePort) {
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const existingTunnel = await findExistingSshPortForward(target, remotePort, localPort);
    if (!existingTunnel) {
      return;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for SSH port forward on local port ${localPort} to stop.`);
}

function getPendingPreviewActionState(action, session) {
  const baseUrl = session?.url;

  switch (action) {
    case PREVIEW_ACTION_OPEN_TERMINAL:
      return {
        text: "$(loading~spin) Opening Dev Server Terminal...",
        tooltip: baseUrl
          ? `Treehouse is opening the dev server terminal for ${baseUrl}.`
          : "Treehouse is opening the dev server terminal."
      };
    case PREVIEW_ACTION_OPEN_PREVIEW:
      return {
        text: "$(loading~spin) Opening Preview...",
        tooltip: getOpenPreviewTooltip(baseUrl)
      };
    case PREVIEW_ACTION_OPEN_EXTERNAL_BROWSER:
      return {
        text: "$(loading~spin) Opening Preview...",
        tooltip: getOpenPreviewTooltip(baseUrl, "externalBrowser")
      };
    case PREVIEW_ACTION_OPEN_VSCODE_BROWSER:
      return {
        text: "$(loading~spin) Opening Preview...",
        tooltip: getOpenPreviewTooltip(baseUrl, "vscodeBrowser")
      };
    case PREVIEW_ACTION_RESTART:
      return {
        text: "$(loading~spin) Restarting Dev Server...",
        tooltip: baseUrl ? `Treehouse is restarting the dev server for ${baseUrl}.` : "Treehouse is restarting the dev server."
      };
    case PREVIEW_ACTION_STOP:
      return {
        text: "$(loading~spin) Stopping Dev Server...",
        tooltip: baseUrl ? `Treehouse is stopping the dev server for ${baseUrl}.` : "Treehouse is stopping the dev server."
      };
    case PREVIEW_ACTION_START:
    default:
      return {
        text: "$(loading~spin) Dev Server starting...",
        tooltip: baseUrl ? `Treehouse is starting the dev server for ${baseUrl}.` : "Treehouse is starting the dev server."
      };
  }
}

function getOpenPreviewTooltip(baseUrl, openTarget = getConfig().appPreviewOpenTarget) {
  const target =
    openTarget === "vscodeBrowser" ? "VS Code browser" : "external browser";
  return baseUrl ? `Treehouse is opening ${baseUrl} in the ${target}.` : `Treehouse is opening the preview in the ${target}.`;
}

function findReusableBrowserTab(session) {
  const trackedTab = findTrackedBrowserTab(session);
  if (trackedTab) {
    return trackedTab;
  }

  const matchingUrlTab = findBrowserTabByUrl(session.url);
  if (matchingUrlTab) {
    return matchingUrlTab;
  }

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (isBrowserLikeTab(tab)) {
        return tab;
      }
    }
  }

  return undefined;
}

function findTrackedBrowserTab(session) {
  const trackedTab = session.browserTab;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (trackedTab && tab === trackedTab) {
        return tab;
      }
    }
  }

  return undefined;
}

function findBrowserTabByUrl(targetUrl) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!isBrowserLikeTab(tab)) {
        continue;
      }

      if (getBrowserTabUrl(tab) === targetUrl) {
        return tab;
      }
    }
  }

  return undefined;
}

function isBrowserLikeTab(tab) {
  const input = tab.input;
  const uri = getBrowserTabUri(tab);
  if (uri && (uri.scheme === "http" || uri.scheme === "https")) {
    return true;
  }

  if (input instanceof vscode.TabInputWebview) {
    return input.viewType === "simpleBrowser.view";
  }

  return String(tab.label || "").toLowerCase().includes("browser");
}

function getBrowserTabUri(tab) {
  const input = tab.input;
  if (input instanceof vscode.TabInputCustom) {
    return input.uri;
  }

  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }

  return undefined;
}

function getBrowserTabUrl(tab) {
  const uri = getBrowserTabUri(tab);
  if (!uri) {
    return undefined;
  }

  if (uri.scheme === "http" || uri.scheme === "https") {
    return uri.toString(true);
  }

  return undefined;
}

async function revealExistingBrowserTab(tab) {
  const input = tab.input;
  const uri = getBrowserTabUri(tab);
  if (uri) {
    try {
      if (input instanceof vscode.TabInputCustom && input.viewType && uri.scheme !== INTEGRATED_BROWSER_SCHEME) {
        await vscode.commands.executeCommand("vscode.openWith", uri, input.viewType, {
          preview: false,
          preserveFocus: false
        });
      } else {
        await vscode.commands.executeCommand("vscode.open", uri, {
          preview: false,
          preserveFocus: false
        });
      }
      return true;
    } catch {}
  }

  const tabIndex = tab.group.tabs.indexOf(tab);
  if (tabIndex < 0) {
    return false;
  }

  await focusEditorGroup(tab.group.viewColumn);
  await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", tabIndex + 1);
  return true;
}

async function startDevServer(session, output) {
  if (session.target?.type === "ssh") {
    await startRemoteDevServer(session, output);
    return;
  }

  const commandLine = session.commandLine || buildDefaultPreviewCommand(session.remotePort);
  const terminal = ensurePreviewTerminal(session);
  const { probePort } = session;
  const shellIntegration = await waitForShellIntegration(terminal);

  if (!shellIntegration) {
    if (output) {
      output.appendLine("Shell integration is unavailable. Falling back to probing the dev server port.");
    }
    terminal.sendText(commandLine, true);
    await waitForPortReady(probePort);
    return;
  }

  const execution = shellIntegration.executeCommand(commandLine);
  await waitForExecutionReady(execution, terminal, probePort);
}

async function restartDevServer(session, workspace, output) {
  if (session.target?.type === "ssh") {
    await stopRemoteDevServer(session, workspace, output);
    await startRemoteDevServer(session, output);
    return;
  }

  await stopLocalDevServer(session, output);
  await startDevServer(session, output);
}

async function startRemoteDevServer(session, output) {
  const adapter = createTargetAdapter(session.target);
  const commandLine = session.commandLine || buildDefaultPreviewCommand(session.remotePort);
  const script = `
session_name=${shellQuote(session.remoteSessionName)}
if tmux has-session -t "$session_name" 2>/dev/null; then
  tmux kill-session -t "$session_name"
fi
tmux new-session -d -s "$session_name" -c ${shellQuote(session.workspacePath)} ${shellQuote(commandLine)}
`;

  await adapter.ensureCommandAvailable("tmux", session.workspacePath);
  output?.appendLine(`Starting remote dev server in tmux session ${session.remoteSessionName}.`);
  await adapter.runCommand(script, session.workspacePath, output);
  await waitForRemotePortReady(session);
}

async function stopLocalDevServer(session, output) {
  const terminal = getSessionTerminal(session);
  if (!terminal) {
    throw new Error("Treehouse cannot restart the local dev server because its terminal is no longer available.");
  }

  output?.appendLine(
    sessionStartsAllDevServers(session)
      ? `Stopping local monorepo dev servers; waiting for preview port ${session.remotePort} to close.`
      : `Stopping local dev server on port ${session.remotePort}.`
  );
  previewTerminalsBeingReplaced.add(terminal);
  session.allowMissingTerminal = true;
  session.terminal = undefined;
  terminal.dispose();
  await waitForPortClosed(session.probePort);
}

async function stopRemoteDevServer(session, workspace, output) {
  const adapter = createTargetAdapter(session.target);
  const script = `
workspace_path=$(readlink -f ${shellQuote(workspace.workspacePath)} 2>/dev/null || printf '%s\\n' ${shellQuote(
    workspace.workspacePath
  )})
target_port=${Number(session.remotePort)}
stop_all=${session.previewTarget?.startsAllDevServers ? 1 : 0}
session_name=${shellQuote(session.remoteSessionName)}

is_workspace_cwd() {
  case "$1" in
    "$workspace_path"|"$workspace_path"/*)
      return 0
      ;;
  esac
  return 1
}

matches_dev_server() {
  command_line=" $1 "
  case "$command_line" in
    *" pnpm dev "*|*" npm run dev "*|*" yarn dev "*|*" bun run dev "*|*" turbo run dev "*|*" vite "*|*" next dev "*|*" react-scripts start "*|*" astro dev "*|*" nuxt dev "*|*" remix dev "*|*" webpack serve "*)
      return 0
      ;;
  esac
  if printf '%s\\n' "$command_line" | grep -Eq ' pnpm .* dev '; then
    return 0
  fi
  return 1
}

extract_port() {
  printf '%s\\n' "$1" | sed -nE 's/.*(^|[[:space:]])(--port|-p)(=|[[:space:]]+)([0-9]{4,5})([[:space:]].*)?$/\\4/p'
}

if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$session_name" 2>/dev/null; then
  tmux kill-session -t "$session_name" || true
fi

for proc_dir in /proc/[0-9]*; do
  [ -d "$proc_dir" ] || continue
  pid=\${proc_dir#/proc/}
  case "$pid" in
    ''|*[!0-9]*)
      continue
      ;;
  esac

  cwd=$(readlink -f "$proc_dir/cwd" 2>/dev/null || readlink "$proc_dir/cwd" 2>/dev/null || true)
  is_workspace_cwd "$cwd" || continue

  cmdline=$(tr '\\0' ' ' < "$proc_dir/cmdline" 2>/dev/null || true)
  [ -n "$cmdline" ] || continue
  matches_dev_server "$cmdline" || continue

  if [ "$stop_all" != "1" ]; then
    port=$(extract_port "$cmdline")
    [ "$port" = "$target_port" ] || continue
  fi

  kill "$pid" 2>/dev/null || true
done
`;

  output?.appendLine(
    sessionStartsAllDevServers(session)
      ? `Stopping remote monorepo dev servers on ${session.target.label}; waiting for preview port ${session.remotePort} to close.`
      : `Stopping remote dev server on ${session.target.label}:${session.remotePort}.`
  );
  await adapter.runCommand(script, session.workspacePath, output);
  await waitForRemotePortClosed(session);
}

async function attachRemoteDevServerTerminal(session, workspace, output) {
  const adapter = createTargetAdapter(session.target);
  await adapter.ensureCommandAvailable("tmux", workspace.workspacePath);

  const sessionExists = await hasRemoteTmuxSession(session);
  if (!sessionExists) {
    throw new Error(
      `Remote dev server tmux session ${session.remoteSessionName} was not found. Start the dev server again with the current Treehouse version.`
    );
  }

  const terminal = vscode.window.createTerminal({
    name: `Dev Server ${session.remotePort}`,
    cwd: workspace.workspaceUri,
    shellArgs: ["-lc", `tmux attach -t ${shellQuote(session.remoteSessionName)}`],
    shellPath: "/bin/sh",
    location: vscode.TerminalLocation.Panel,
    isTransient: true
  });
  terminal.show(false);
  output?.appendLine(`Attaching terminal to tmux session ${session.remoteSessionName}.`);
}

async function isPreviewServerRunning(session, workspace) {
  if (session.target?.type === "ssh") {
    return isRemotePortAcceptingConnections(workspace, session.remotePort);
  }

  return isPortAcceptingConnections(session.probePort);
}

async function executeBrowserOpenCommand(url) {
  const attempts = [
    () =>
      vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(url), {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false
      }),
    () => vscode.commands.executeCommand("simpleBrowser.show", url),
    () => vscode.commands.executeCommand("workbench.action.openBrowserEditor", { url, preserveFocus: false }),
    () => vscode.commands.executeCommand("workbench.action.browser.open", url)
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const suffix = lastError ? ` ${lastError instanceof Error ? lastError.message : String(lastError)}` : "";
  throw new Error(`No supported browser-open command is available in this editor build.${suffix}`.trim());
}

async function waitForShellIntegration(terminal) {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  return new Promise((resolve) => {
    const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal !== terminal) {
        return;
      }

      clearTimeout(timeout);
      disposable.dispose();
      resolve(event.shellIntegration);
    });

    const timeout = setTimeout(() => {
      disposable.dispose();
      resolve(undefined);
    }, SHELL_INTEGRATION_TIMEOUT_MS);
  });
}

async function waitForExecutionReady(execution, terminal, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBuffer = "";

    const cleanup = () => {
      clearTimeout(timeout);
      endDisposable.dispose();
    };

    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal !== terminal || event.execution !== execution) {
        return;
      }

      settleReject(
        new Error(
          typeof event.exitCode === "number"
            ? `Dev server exited before becoming ready (code ${event.exitCode}).`
            : "Dev server exited before becoming ready."
        )
      );
    });

    const timeout = setTimeout(() => {
      settleReject(new Error("Timed out waiting for the dev server to report Ready."));
    }, SERVER_READY_TIMEOUT_MS);

    (async () => {
      try {
        for await (const chunk of execution.read()) {
          outputBuffer = `${outputBuffer}${stripAnsi(chunk)}`.slice(-2000);
          if (!READY_PATTERN.test(outputBuffer)) {
            continue;
          }

          await waitForPortReady(port);
          settleResolve();
          return;
        }
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

async function waitForBrowserTab(previousActiveTab) {
  const currentActiveTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (currentActiveTab && currentActiveTab !== previousActiveTab) {
    return {
      activeTab: currentActiveTab,
      changed: true
    };
  }

  return new Promise((resolve) => {
    const disposable = vscode.window.tabGroups.onDidChangeTabs(() => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!activeTab || activeTab === previousActiveTab) {
        return;
      }

      clearTimeout(timeout);
      disposable.dispose();
      resolve({
        activeTab,
        changed: true
      });
    });

    const timeout = setTimeout(() => {
      disposable.dispose();
      resolve({
        activeTab: vscode.window.tabGroups.activeTabGroup.activeTab,
        changed: false
      });
    }, BROWSER_TAB_TIMEOUT_MS);
  });
}

async function waitForPortReady(port) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isPortAcceptingConnections(port)) {
      return;
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for the dev server port to accept connections.");
}

async function waitForRemotePortReady(session) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  const workspace = {
    location: {
      target: session.target
    },
    workspacePath: session.workspacePath
  };

  while (Date.now() < deadline) {
    if (await isRemotePortAcceptingConnections(workspace, session.remotePort)) {
      return;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for remote dev server port ${session.remotePort} to accept connections.`);
}

async function waitForPortClosed(port) {
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (!(await isPortAcceptingConnections(port))) {
      return;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for dev server port ${port} to stop accepting connections.`);
}

async function waitForRemotePortClosed(session) {
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
  const workspace = {
    location: {
      target: session.target
    },
    workspacePath: session.workspacePath
  };

  while (Date.now() < deadline) {
    if (!(await isRemotePortAcceptingConnections(workspace, session.remotePort))) {
      return;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for remote dev server port ${session.remotePort} to stop accepting connections.`);
}

async function getOrCreateSshPortForward(target, remotePort, output) {
  const existingTunnel = await findExistingSshPortForward(target, remotePort);
  if (existingTunnel) {
    output?.appendLine(`Reusing existing SSH port forward on local port ${existingTunnel.localPort}.`);
    return {
      localPort: existingTunnel.localPort,
      tunnelProcess: undefined
    };
  }

  const localPort = await findAvailablePort(remotePort);
  if (localPort !== remotePort) {
    output?.appendLine(
      `Local port ${remotePort} is already in use. Forwarding remote port ${remotePort} on local port ${localPort} instead.`
    );
  }

  return {
    localPort,
    tunnelProcess: await createSshPortForward(target, localPort, remotePort, output)
  };
}

async function findAvailablePort(preferredPort = MIN_PORT) {
  const startPort =
    Number.isInteger(preferredPort) && preferredPort >= MIN_PORT && preferredPort <= MAX_PORT ? preferredPort : MIN_PORT;

  for (let candidatePort = startPort; candidatePort <= MAX_PORT; candidatePort += 1) {
    if (await isPortAvailable(candidatePort)) {
      return candidatePort;
    }
  }

  for (let candidatePort = MIN_PORT; candidatePort < startPort; candidatePort += 1) {
    if (await isPortAvailable(candidatePort)) {
      return candidatePort;
    }
  }

  throw new Error(`Treehouse could not find an available port between ${MIN_PORT} and ${MAX_PORT}.`);
}

async function findPreviewPort(workspace) {
  if (workspace.location?.target?.type === "ssh") {
    return findAvailableRemotePort(workspace);
  }

  return findAvailablePort();
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, "127.0.0.1");
  });
}

async function isPortAcceptingConnections(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });

    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });

    socket.once("error", () => {
      resolve(false);
    });
  });
}

async function findAvailableRemotePort(workspace) {
  const adapter = createTargetAdapter(workspace.location.target);
  for (let candidatePort = MIN_PORT; candidatePort <= MAX_PORT; candidatePort += 1) {
    if (await isRemotePortAvailable(adapter, workspace.workspacePath, candidatePort)) {
      return candidatePort;
    }
  }

  throw new Error(
    `Treehouse could not find an available remote port between ${MIN_PORT} and ${MAX_PORT} on ${workspace.location.target.label}.`
  );
}

async function isRemotePortAvailable(adapter, cwd, port) {
  const script = `
const net = require("node:net");
const server = net.createServer();
server.once("error", () => process.exit(1));
server.once("listening", () => server.close(() => process.exit(0)));
server.listen(${Number(port)}, "127.0.0.1");
setTimeout(() => process.exit(1), 1000);
`;

  try {
    await adapter.runCommand(`node -e ${shellQuote(script)}`, cwd);
    return true;
  } catch {
    return false;
  }
}

async function isRemotePortAcceptingConnections(workspace, port) {
  const adapter = createTargetAdapter(workspace.location.target);
  const script = `
const net = require("node:net");
const socket = net.createConnection({ port: ${Number(port)}, host: "127.0.0.1" });
socket.once("connect", () => {
  socket.end();
  process.exit(0);
});
socket.once("error", () => process.exit(1));
setTimeout(() => process.exit(1), 1000);
`;

  try {
    await adapter.runCommand(`node -e ${shellQuote(script)}`, workspace.workspacePath);
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function focusEditorGroup(viewColumn) {
  const commandByColumn = new Map([
    [1, "workbench.action.focusFirstEditorGroup"],
    [2, "workbench.action.focusSecondEditorGroup"],
    [3, "workbench.action.focusThirdEditorGroup"],
    [4, "workbench.action.focusFourthEditorGroup"],
    [5, "workbench.action.focusFifthEditorGroup"],
    [6, "workbench.action.focusSixthEditorGroup"],
    [7, "workbench.action.focusSeventhEditorGroup"],
    [8, "workbench.action.focusEighthEditorGroup"]
  ]);

  const command = commandByColumn.get(viewColumn);
  if (!command) {
    throw new Error(`Treehouse cannot focus editor group for view column ${viewColumn}.`);
  }

  await vscode.commands.executeCommand(command);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getCurrentWorkspaceContext() {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceUri) {
    return null;
  }

  const location = tryGetCurrentWorkspaceLocation();
  return {
    location,
    sessionKey: workspaceUri.toString(),
    workspacePath: location?.workspacePath || workspaceUri.fsPath || workspaceUri.path,
    workspaceUri
  };
}

function hasTunnelExited(session) {
  return Boolean(session?.tunnelProcess && session.tunnelProcess.exitCode !== null);
}

async function getOrCreatePreviewSession(workspace, output) {
  const existingSession = getExistingSession(workspace.sessionKey);
  if (existingSession) {
    return existingSession;
  }

  const recoveredSession = await recoverRemotePreviewSession(workspace, output);
  if (recoveredSession) {
    return recoveredSession;
  }

  return createPreviewSession(workspace, output);
}

async function ensurePreviewSession(output) {
  const workspace = getCurrentWorkspaceContext();
  if (!workspace) {
    throw new Error("Treehouse needs an open workspace folder to start the dev server.");
  }

  await ensurePreviewPrerequisites(workspace);

  const hadExistingSession = Boolean(getExistingSession(workspace.sessionKey));
  const session = await getOrCreatePreviewSession(workspace, output);
  let startedServer = false;
  const serverRunning = await isPreviewServerRunning(session, workspace);
  if (!serverRunning) {
    updatePreviewSessionStatus(session, PREVIEW_STATUS_STARTING);
    try {
      await startDevServer(session, output);
      startedServer = true;
    } catch (error) {
      updatePreviewSessionStatus(session);
      throw error;
    }
  } else if (output) {
    output.appendLine(
      session.target?.type === "ssh"
        ? `Dev server is already running on remote port ${session.remotePort} (forwarded to local port ${session.probePort}).`
        : `Dev server is already running on port ${session.remotePort}.`
    );
  }

  updatePreviewSessionStatus(session, PREVIEW_STATUS_RUNNING);
  return {
    hadExistingSession,
    session,
    startedServer,
    workspace
  };
}

async function ensurePreviewPrerequisites(workspace) {
  const adapter = workspace.location?.target ? createTargetAdapter(workspace.location.target) : null;
  if (adapter) {
    await adapter.ensureCommandAvailable("pnpm", workspace.workspacePath);
  }
  if (workspace.location?.target?.type === "ssh") {
    await ensureLocalCommandAvailable("ssh", os.homedir());
  }
}

async function recoverCurrentRemotePreviewSession(output) {
  const workspace = getCurrentWorkspaceContext();
  if (!workspace || workspace.location?.target?.type !== "ssh") {
    refreshAppPreviewStatusBar();
    return undefined;
  }

  return recoverRemotePreviewSession(workspace, output, { suppressErrors: true });
}

async function recoverRemotePreviewSession(workspace, output, options = {}) {
  if (!workspace || workspace.location?.target?.type !== "ssh") {
    return undefined;
  }

  const existingSession = getExistingSession(workspace.sessionKey);
  if (existingSession) {
    return existingSession;
  }

  const activeRecovery = remotePreviewRecoveryPromises.get(workspace.sessionKey);
  if (activeRecovery) {
    return handleRemotePreviewRecoveryResult(activeRecovery, output, options);
  }

  const recoveryPromise = (async () => {
    const remotePort = await findRunningRemotePreviewPort(workspace);
    if (!remotePort) {
      return undefined;
    }

    if (!isCurrentWorkspace(workspace)) {
      return undefined;
    }

    const session = await createPreviewSessionWithOptions(workspace, output, {
      allowMissingTerminal: true,
      remotePort,
      recovered: true,
      skipTerminal: true,
      status: PREVIEW_STATUS_RUNNING
    });

    if (!isCurrentWorkspace(workspace)) {
      clearPreviewSession(workspace.sessionKey);
      return undefined;
    }

    updatePreviewSessionStatus(session, PREVIEW_STATUS_RUNNING);
    output?.appendLine(
      `Recovered remote dev server in ${workspace.workspacePath} on ${workspace.location.target.label}:${remotePort}.`
    );
    return session;
  })();

  const trackedRecoveryPromise = recoveryPromise.finally(() => {
    if (remotePreviewRecoveryPromises.get(workspace.sessionKey) === trackedRecoveryPromise) {
      remotePreviewRecoveryPromises.delete(workspace.sessionKey);
    }
    refreshAppPreviewStatusBar();
  });

  remotePreviewRecoveryPromises.set(workspace.sessionKey, trackedRecoveryPromise);
  return handleRemotePreviewRecoveryResult(trackedRecoveryPromise, output, options);
}

async function handleRemotePreviewRecoveryResult(recoveryPromise, output, options = {}) {
  try {
    return await recoveryPromise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output?.appendLine(`Failed to recover remote dev server: ${message}`);
    if (options.suppressErrors) {
      return undefined;
    }
    throw error;
  }
}

function createPreviewTerminal(workspaceUri, remotePort) {
  return vscode.window.createTerminal({
    name: getPreviewTerminalName(remotePort),
    cwd: workspaceUri,
    location: vscode.TerminalLocation.Panel,
    isTransient: true
  });
}

function findPreviewTerminal(remotePort) {
  const expectedName = getPreviewTerminalName(remotePort);
  return vscode.window.terminals.find((terminal) => terminal.name === expectedName);
}

function getPreviewTerminalName(remotePort) {
  return `App Preview :${remotePort}`;
}

function sessionStartsAllDevServers(session) {
  return Boolean(session?.previewTarget?.startsAllDevServers);
}

function ensurePreviewTerminal(session) {
  const activeTerminal = getSessionTerminal(session);
  if (activeTerminal) {
    return activeTerminal;
  }

  session.terminal = createPreviewTerminal(session.workspaceUri, session.remotePort);
  session.allowMissingTerminal = false;
  return session.terminal;
}

function getSessionTerminal(session) {
  if (!session?.terminal) {
    return undefined;
  }

  if (vscode.window.terminals.includes(session.terminal)) {
    return session.terminal;
  }

  session.terminal = undefined;
  return undefined;
}

function isPreviewSessionUsable(session) {
  if (!session || hasTunnelExited(session)) {
    return false;
  }

  if (getSessionTerminal(session)) {
    return true;
  }

  return Boolean(session.allowMissingTerminal);
}

function registerPreviewSession(session) {
  if (session.tunnelProcess) {
    session.tunnelProcess.on("close", () => {
      const activeSession = previewSessions.get(session.sessionKey);
      if (activeSession === session) {
        clearPreviewSession(session.sessionKey);
      }
    });
  }

  previewSessions.set(session.sessionKey, session);
}

function ensurePreviewSessionRegistered(session) {
  if (previewSessions.get(session.sessionKey) !== session) {
    previewSessions.set(session.sessionKey, session);
  }
}

function isCurrentWorkspace(workspace) {
  return getCurrentWorkspaceContext()?.sessionKey === workspace?.sessionKey;
}

function getRemotePreviewSessionName(workspace) {
  const hash = createHash("sha1").update(String(workspace.workspacePath || "")).digest("hex").slice(0, 10);
  return `treehouse-dev-${hash}`;
}

async function findExistingSshPortForward(target, remotePort, localPort) {
  let lsofOutput;
  try {
    const portFilter = Number.isInteger(localPort) ? `:${Number(localPort)}` : "";
    lsofOutput = await runLocalShellCommand(`lsof -nP -iTCP${portFilter} -sTCP:LISTEN -Fpn`);
  } catch {
    return undefined;
  }

  const listeningPortsByPid = parseListeningPortsByPid(lsofOutput);
  for (const [pid, listeningPorts] of listeningPortsByPid.entries()) {
    let command = "";
    try {
      command = (await runLocalShellCommand(`ps -p ${shellQuote(String(pid))} -o command=`)).trim();
    } catch {
      continue;
    }

    const parsedForward = parseSshPortForwardCommand(command, target.sshHost);
    if (!parsedForward) {
      continue;
    }

    if (parsedForward.remotePort !== Number(remotePort)) {
      continue;
    }

    if (Number.isInteger(localPort) && parsedForward.localPort !== Number(localPort)) {
      continue;
    }

    if (!listeningPorts.has(parsedForward.localPort)) {
      continue;
    }

    return {
      command,
      localPort: parsedForward.localPort,
      pid: Number(pid),
      remotePort: parsedForward.remotePort
    };
  }

  return undefined;
}

function parseListeningPortsByPid(lsofOutput) {
  const listeningPortsByPid = new Map();
  let currentPid;

  for (const line of String(lsofOutput || "").split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    if (line.startsWith("p")) {
      const pid = Number(line.slice(1).trim());
      currentPid = Number.isInteger(pid) ? pid : undefined;
      if (currentPid && !listeningPortsByPid.has(currentPid)) {
        listeningPortsByPid.set(currentPid, new Set());
      }
      continue;
    }

    if (!currentPid || !line.startsWith("n")) {
      continue;
    }

    const match = line.match(/:(\d+)(?:->.*)?$/);
    if (!match) {
      continue;
    }

    listeningPortsByPid.get(currentPid)?.add(Number(match[1]));
  }

  return listeningPortsByPid;
}

function parseSshPortForwardCommand(command, sshHost) {
  const normalizedCommand = ` ${String(command || "").trim()} `;
  if (!normalizedCommand.includes(" ssh ") || !normalizedCommand.includes(" -N ")) {
    return undefined;
  }

  if (!normalizedCommand.includes(` ${sshHost} `)) {
    return undefined;
  }

  const patterns = [
    /(?:^|\s)-L\s+127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)(?=\s|$)/,
    /(?:^|\s)-L127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)(?=\s|$)/
  ];

  for (const pattern of patterns) {
    const match = normalizedCommand.match(pattern);
    if (!match) {
      continue;
    }

    const localPort = Number(match[1]);
    const remotePort = Number(match[2]);
    if (!Number.isInteger(localPort) || !Number.isInteger(remotePort)) {
      return undefined;
    }

    return {
      localPort,
      remotePort
    };
  }

  return undefined;
}

async function findRunningRemotePreviewPort(workspace) {
  const commandPort = await findRemotePreviewPortFromCommandLine(workspace);
  if (commandPort && (await isRemotePortAcceptingConnections(workspace, commandPort))) {
    return commandPort;
  }

  return findRemotePreviewPortFromListeningSockets(workspace);
}

async function hasRemoteTmuxSession(session) {
  const adapter = createTargetAdapter(session.target);
  try {
    await adapter.runCommand(`tmux has-session -t ${shellQuote(session.remoteSessionName)}`, session.workspacePath);
    return true;
  } catch {
    return false;
  }
}

async function findRemotePreviewPortFromCommandLine(workspace) {
  const adapter = createTargetAdapter(workspace.location.target);
  const script = `
workspace_path=$(readlink -f ${shellQuote(workspace.workspacePath)} 2>/dev/null || printf '%s\\n' ${shellQuote(
    workspace.workspacePath
  )})
best_pid=0
best_port=

is_workspace_cwd() {
  case "$1" in
    "$workspace_path"|"$workspace_path"/*)
      return 0
      ;;
  esac
  return 1
}

matches_treehouse_dev_command() {
  case " $1 " in
    *" dev "*"-p "*|*" dev "*"--port "*|*" vite "*"--port "*|*" next dev "*|*" astro dev "*|*" nuxt dev "*)
      return 0
      ;;
  esac
  return 1
}

extract_port() {
  printf '%s\\n' "$1" | sed -nE 's/.*(^|[[:space:]])(--port|-p)(=|[[:space:]]+)([0-9]{4,5})([[:space:]].*)?$/\\4/p'
}

for proc_dir in /proc/[0-9]*; do
  [ -d "$proc_dir" ] || continue
  pid=\${proc_dir#/proc/}
  case "$pid" in
    ''|*[!0-9]*)
      continue
      ;;
  esac

  cwd=$(readlink -f "$proc_dir/cwd" 2>/dev/null || readlink "$proc_dir/cwd" 2>/dev/null || true)
  is_workspace_cwd "$cwd" || continue

  cmdline=$(tr '\\0' ' ' < "$proc_dir/cmdline" 2>/dev/null || true)
  [ -n "$cmdline" ] || continue
  matches_treehouse_dev_command "$cmdline" || continue

  port=$(extract_port "$cmdline")
  case "$port" in
    ''|*[!0-9]*)
      continue
      ;;
  esac

  if [ "$pid" -gt "$best_pid" ]; then
    best_pid=$pid
    best_port=$port
  fi
done

if [ -n "$best_port" ]; then
  printf '%s\\n' "$best_port"
fi
`;

  const rawPort = (await adapter.runCommand(script, workspace.workspacePath)).trim();
  if (!rawPort) {
    return undefined;
  }

  const remotePort = Number(rawPort);
  if (!Number.isInteger(remotePort) || remotePort < MIN_PORT || remotePort > 65535) {
    return undefined;
  }

  return remotePort;
}

async function findRemotePreviewPortFromListeningSockets(workspace) {
  const adapter = createTargetAdapter(workspace.location.target);
  const script = `
workspace_path=$(readlink -f ${shellQuote(workspace.workspacePath)} 2>/dev/null || printf '%s\\n' ${shellQuote(
    workspace.workspacePath
  )})

is_workspace_cwd() {
  case "$1" in
    "$workspace_path"|"$workspace_path"/*)
      return 0
      ;;
  esac
  return 1
}

matches_dev_server() {
  command_line=" $1 "
  case "$command_line" in
    *" pnpm dev "*|*" npm run dev "*|*" yarn dev "*|*" bun run dev "*|*" turbo run dev "*|*" vite "*|*" next dev "*|*" react-scripts start "*|*" astro dev "*|*" nuxt dev "*|*" remix dev "*|*" webpack serve "*)
      return 0
      ;;
  esac
  if printf '%s\\n' "$command_line" | grep -Eq ' pnpm .* dev '; then
    return 0
  fi
  return 1
}

check_ss() {
  command -v ss >/dev/null 2>&1 || return 1
  ss_output=$(ss -ltnpH 2>/dev/null || true)
  [ -n "$ss_output" ] || return 1

  best_port=
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    local_address=$(printf '%s\\n' "$line" | awk '{print $4}')
    [ -n "$local_address" ] || continue
    port=\${local_address##*:}
    case "$port" in
      ''|*[!0-9]*)
        continue
        ;;
    esac

    pids=$(printf '%s\\n' "$line" | grep -o 'pid=[0-9]\\+' | cut -d= -f2 | awk '!seen[$0]++')
    [ -n "$pids" ] || continue

    port_for_workspace=
    for pid in $pids; do
      cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || readlink "/proc/$pid/cwd" 2>/dev/null || true)
      is_workspace_cwd "$cwd" || continue

      cmdline=$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
      if matches_dev_server "$cmdline"; then
        printf '%s\\n' "$port"
        return 0
      fi

      if [ -z "$port_for_workspace" ]; then
        port_for_workspace=$port
      fi
    done

    if [ -n "$port_for_workspace" ] && [ -z "$best_port" ]; then
      best_port=$port_for_workspace
    fi
  done <<EOF_SS
$ss_output
EOF_SS

  [ -n "$best_port" ] || return 1
  printf '%s\\n' "$best_port"
}

check_lsof() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof_output=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$lsof_output" ] || return 1

  best_port=
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      COMMAND*)
        continue
        ;;
    esac

    pid=$(printf '%s\\n' "$line" | awk '{print $2}')
    case "$pid" in
      ''|*[!0-9]*)
        continue
        ;;
    esac

    local_address=$(printf '%s\\n' "$line" | awk '{print $(NF-1)}')
    [ -n "$local_address" ] || continue
    port=\${local_address##*:}
    case "$port" in
      ''|*[!0-9]*)
        continue
        ;;
    esac

    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || readlink "/proc/$pid/cwd" 2>/dev/null || true)
    is_workspace_cwd "$cwd" || continue

    cmdline=$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    if matches_dev_server "$cmdline"; then
      printf '%s\\n' "$port"
      return 0
    fi

    if [ -z "$best_port" ]; then
      best_port=$port
    fi
  done <<EOF_LSOF
$lsof_output
EOF_LSOF

  [ -n "$best_port" ] || return 1
  printf '%s\\n' "$best_port"
}

check_ss || check_lsof || true
`;

  const rawPort = (await adapter.runCommand(script, workspace.workspacePath)).trim();
  if (!rawPort) {
    return undefined;
  }

  const remotePort = Number(rawPort);
  if (!Number.isInteger(remotePort) || remotePort < MIN_PORT || remotePort > 65535) {
    return undefined;
  }

  return remotePort;
}

async function createSshPortForward(target, localPort, remotePort, output) {
  const args = [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    target.sshHost
  ];

  if (output) {
    output.appendLine(
      `[Local] $ ssh ${args.map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(" ")}`
    );
  }

  return new Promise((resolve, reject) => {
    const tunnelProcess = spawn("ssh", args, {
      cwd: os.homedir()
    });
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(readyTimeout);
      tunnelProcess.removeAllListeners("error");
      tunnelProcess.removeAllListeners("close");
    };

    const readyTimeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(tunnelProcess);
    }, 300);

    tunnelProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      output?.append(text);
    });

    tunnelProcess.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    });

    tunnelProcess.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(
        new Error(
          (stderr || `SSH port forward exited before it was ready (code ${code ?? "unknown"}).`).trim()
        )
      );
    });
  });
}

module.exports = {
  initializeAppPreviewStatusBar,
  onDidChangeAppPreviewState: appPreviewStateEmitter.event,
  getAppPreviewState,
  openAppPreview,
  openAppPreviewExternalBrowser,
  openAppPreviewInVsCodeBrowser,
  restartAppPreview,
  stopAppPreview,
  stopPreviewForWorkspace,
  openDevServerTerminal
};
