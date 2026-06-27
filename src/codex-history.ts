const fs = require("node:fs/promises");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const vscode = require("vscode");

const { getConfig } = require("./config");
const { createTargetAdapter } = require("./target-adapters");
const { getTargetLabel, getTargetPathModule, tryGetCurrentWorkspaceLocation } = require("./targets");
const { shellQuote } = require("./shell");

const OPENAI_CODEX_EXTENSION_ID = "openai.chatgpt";
const OPENAI_CODEX_CUSTOM_EDITOR_VIEW_TYPE = "chatgpt.conversationEditor";
const OPENAI_CODEX_URI_SCHEME = "openai-codex";
const OPENAI_CODEX_URI_AUTHORITY = "route";
const SESSION_META_SCAN_LINE_LIMIT = 40;

async function openLatestCodexChatForCurrentWorkspace(output, options: any = {}) {
  const location = tryGetCurrentWorkspaceLocation();
  if (!location) {
    if (options.showNoSessionMessage) {
      reportCodexHistoryMessage(output, "Open a workspace folder before opening the latest Codex chat.");
    }
    return false;
  }

  const config = getConfig();
  const session = await findLatestCodexSessionForWorkspace(location, config.codexSessionsRoot);
  if (!session) {
    if (options.showNoSessionMessage) {
      output?.appendLine(`No Codex session found for ${location.workspacePath} on ${getTargetLabel(location.target)}.`);
      reportCodexHistoryMessage(output, "No Codex chat history was found for this workspace.");
    }
    return false;
  }

  output?.appendLine(
    `Opening latest Codex chat ${session.id} for ${location.workspacePath} on ${getTargetLabel(location.target)}.`
  );
  return openCodexConversation(session.id, config.latestCodexChatOpenTarget, output, options);
}

async function findLatestCodexSessionForWorkspace(location, sessionsRoot) {
  if (location.target.type === "ssh") {
    const hostSession = await findLatestLocalCodexSession(location, sessionsRoot);
    if (hostSession) {
      return hostSession;
    }

    return findLatestRemoteCodexSession(location, sessionsRoot);
  }

  return findLatestLocalCodexSession(location, sessionsRoot);
}

async function findLatestLocalCodexSession(location, sessionsRoot) {
  const root = expandHome(sessionsRoot || "~/.codex/sessions");
  const files = await collectLocalCodexSessionFiles(root);
  const candidates = [];
  for (const fsPath of files) {
    const stat = await safeStat(fsPath);
    if (stat) {
      candidates.push({ fsPath, modifiedAt: stat.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);

  const workspacePaths = await getComparableLocalPaths(location.target, location.workspacePath);
  let fallback = null;

  for (const candidate of candidates) {
    const meta = await readLocalCodexSessionMeta(candidate.fsPath);
    if (!meta?.id || !meta.cwd) {
      continue;
    }

    const cwdPaths = await getComparableLocalPaths(location.target, meta.cwd);
    const matchKind = getBestWorkspacePathMatchKind(cwdPaths, workspacePaths);
    if (!matchKind) {
      continue;
    }

    const session = {
      id: meta.id,
      cwd: meta.cwd,
      fsPath: candidate.fsPath,
      modifiedAt: candidate.modifiedAt,
      matchKind
    };

    if (matchKind === "exact" || matchKind === "child") {
      return session;
    }

    if (!fallback) {
      fallback = session;
    }
  }

  return fallback;
}

async function collectLocalCodexSessionFiles(root) {
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

      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        results.push(entryPath);
      }
    }
  }

  return results;
}

async function readLocalCodexSessionMeta(fsPath) {
  const stream = nodeFs.createReadStream(fsPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let scanned = 0;

  try {
    for await (const line of lines) {
      if (!line) {
        continue;
      }

      scanned += 1;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        if (scanned >= SESSION_META_SCAN_LINE_LIMIT) {
          break;
        }
        continue;
      }

      if (obj?.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
        return {
          id: typeof obj.payload.id === "string" ? obj.payload.id : "",
          cwd: typeof obj.payload.cwd === "string" ? obj.payload.cwd : ""
        };
      }

      if (scanned >= SESSION_META_SCAN_LINE_LIMIT) {
        break;
      }
    }
  } finally {
    lines.close();
    stream.close();
  }

  return null;
}

async function safeStat(fsPath) {
  try {
    return await fs.stat(fsPath);
  } catch {
    return null;
  }
}

async function findLatestRemoteCodexSession(location, sessionsRoot) {
  const adapter = createTargetAdapter(location.target);
  const result = await adapter.runCommand(
    buildRemoteLatestCodexSessionCommand(sessionsRoot || "~/.codex/sessions", location.workspacePath),
    location.workspacePath,
    undefined
  );
  const line = result.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  if (!line) {
    return null;
  }

  const [, modifiedAtRaw, id, cwd, fsPath, matchKind] = line.split("\t");
  if (!id || !cwd || !fsPath) {
    return null;
  }

  return {
    id,
    cwd,
    fsPath,
    modifiedAt: Number(modifiedAtRaw || 0) * 1000,
    matchKind: matchKind || ""
  };
}

function buildRemoteLatestCodexSessionCommand(sessionsRoot, workspacePath) {
  return `
sessions_root=${shellQuote(sessionsRoot)}
workspace_path=${shellQuote(workspacePath)}

case "$sessions_root" in
  "~")
    sessions_root="$HOME"
    ;;
  "~/"*)
    sessions_root="$HOME/\${sessions_root#\\~/}"
    ;;
esac

trim_trailing_slashes() {
  value=$1
  while [ "$value" != "/" ] && [ "\${value%/}" != "$value" ]; do
    value=\${value%/}
  done
  printf '%s' "$value"
}

canonical_path() {
  value=$1
  if [ -d "$value" ]; then
    (cd "$value" 2>/dev/null && pwd -P) || printf '%s' "$value"
    return
  fi
  printf '%s' "$value"
}

workspace_norm=$(trim_trailing_slashes "$workspace_path")
workspace_real=$(trim_trailing_slashes "$(canonical_path "$workspace_path")")

path_match_kind() {
  candidate=$(trim_trailing_slashes "$1")
  base=$(trim_trailing_slashes "$2")
  if [ "$candidate" = "$base" ]; then
    printf '%s' exact
    return
  fi
  case "$candidate" in
    "$base"/*)
      printf '%s' child
      return
      ;;
  esac
  case "$base" in
    "$candidate"/*)
      printf '%s' parent
      return
      ;;
  esac
}

if [ ! -d "$sessions_root" ]; then
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  python3 - "$sessions_root" "$workspace_path" <<'PY'
import json
import os
import sys

root = sys.argv[1]
workspace = sys.argv[2]

def normalize(value):
    path = os.path.normpath(str(value or ""))
    if path != os.path.sep:
        path = path.rstrip(os.path.sep)
    return path

def canonical(value):
    path = str(value or "")
    if os.path.isdir(path):
        try:
            return normalize(os.path.realpath(path))
        except OSError:
            return normalize(path)
    return normalize(path)

def match_kind(candidate, base):
    candidate = normalize(candidate)
    base = normalize(base)
    if not candidate or not base:
        return ""
    if candidate == base:
        return "exact"
    if candidate.startswith(base.rstrip(os.path.sep) + os.path.sep):
        return "child"
    if base.startswith(candidate.rstrip(os.path.sep) + os.path.sep):
        return "parent"
    return ""

def best_match_kind(cwd, workspace):
    pairs = [
        (normalize(cwd), normalize(workspace)),
        (canonical(cwd), canonical(workspace)),
    ]
    fallback = ""
    for candidate, base in pairs:
        kind = match_kind(candidate, base)
        if kind in ("exact", "child"):
            return kind
        if kind and not fallback:
            fallback = kind
    return fallback

best = None
for dirpath, _, filenames in os.walk(root):
    for filename in filenames:
        if not filename.startswith("rollout-") or not filename.endswith(".jsonl"):
            continue

        file_path = os.path.join(dirpath, filename)
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                meta = None
                for line in handle:
                    if '"session_meta"' not in line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("type") == "session_meta":
                        meta = entry.get("payload") or {}
                        break
        except OSError:
            continue

        if not isinstance(meta, dict):
            continue
        session_id = meta.get("id")
        cwd = meta.get("cwd")
        if not isinstance(session_id, str) or not isinstance(cwd, str):
            continue

        kind = best_match_kind(cwd, workspace)
        if not kind:
            continue

        try:
            mtime = int(os.path.getmtime(file_path))
        except OSError:
            mtime = 0
        rank = 2 if kind in ("exact", "child") else 1
        candidate = (rank, mtime, session_id, cwd, file_path, kind)
        if best is None or candidate[:2] > best[:2]:
            best = candidate

if best is not None:
    print("%s\\t%s\\t%s\\t%s\\t%s\\t%s" % best)
PY
  exit 0
fi

find "$sessions_root" -type f -name 'rollout-*.jsonl' 2>/dev/null | while IFS= read -r file; do
  meta=$(grep -m 1 '"type"[[:space:]]*:[[:space:]]*"session_meta"' "$file" 2>/dev/null || true)
  if [ -z "$meta" ]; then
    continue
  fi

  id=$(printf '%s\\n' "$meta" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
  cwd=$(printf '%s\\n' "$meta" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
  if [ -z "$id" ] || [ -z "$cwd" ]; then
    continue
  fi

  cwd_norm=$(trim_trailing_slashes "$cwd")
  cwd_real=$(trim_trailing_slashes "$(canonical_path "$cwd")")
  match_kind=$(path_match_kind "$cwd_norm" "$workspace_norm")
  if [ -z "$match_kind" ]; then
    match_kind=$(path_match_kind "$cwd_real" "$workspace_real")
  fi
  if [ -z "$match_kind" ]; then
    continue
  fi

  mtime=$(stat -c '%Y' "$file" 2>/dev/null || stat -f '%m' "$file" 2>/dev/null || printf '0')
  case "$match_kind" in
    exact) rank=2 ;;
    child) rank=2 ;;
    *) rank=1 ;;
  esac
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$rank" "$mtime" "$id" "$cwd" "$file" "$match_kind"
done | sort -k1,1nr -k2,2nr | head -n 1
`;
}

async function openCodexConversation(conversationId, target, output, options: any = {}) {
  const safeConversationId = normalizeCodexConversationId(conversationId);
  if (!safeConversationId) {
    throw new Error("Latest Codex session does not have a valid conversation id.");
  }

  if (target === "panel") {
    const conversationUri = vscode.Uri.from({
      scheme: OPENAI_CODEX_URI_SCHEME,
      authority: OPENAI_CODEX_URI_AUTHORITY,
      path: `/local/${safeConversationId}`
    });
    try {
      const codexExtension = vscode.extensions.getExtension(OPENAI_CODEX_EXTENSION_ID);
      await codexExtension?.activate?.();
      await vscode.commands.executeCommand("vscode.openWith", conversationUri, OPENAI_CODEX_CUSTOM_EDITOR_VIEW_TYPE, {
        preview: false,
        preserveFocus: false
      });
      return true;
    } catch (error) {
      output?.appendLine(
        `Could not open Codex chat in panel; falling back to sidebar route: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const deepLink = vscode.Uri.parse(
    `${vscode.env.uriScheme}://${OPENAI_CODEX_EXTENSION_ID}/local/${encodeURIComponent(safeConversationId)}`
  );
  return vscode.env.openExternal(deepLink);
}

function normalizeCodexConversationId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : "";
}

function reportCodexHistoryMessage(output, message) {
  output?.appendLine(message);
  output?.show?.(true);
}

function normalizePathForComparison(target, targetPath) {
  const pathModule = getTargetPathModule(target);
  const normalized = pathModule.normalize(String(targetPath || ""));
  if (normalized === pathModule.sep) {
    return normalized;
  }

  return normalized.endsWith(pathModule.sep) ? normalized.slice(0, -1) : normalized;
}

async function getComparableLocalPaths(target, targetPath) {
  const normalizedPath = normalizePathForComparison(target, targetPath);
  const paths = [normalizedPath];

  try {
    const realPath = await fs.realpath(targetPath);
    const normalizedRealPath = normalizePathForComparison(target, realPath);
    if (normalizedRealPath && normalizedRealPath !== normalizedPath) {
      paths.push(normalizedRealPath);
    }
  } catch {
    // Keep the lexical path when the session CWD no longer exists.
  }

  return paths;
}

function getBestWorkspacePathMatchKind(candidatePaths, workspacePaths) {
  let fallback = "";
  for (const candidatePath of candidatePaths) {
    for (const workspacePath of workspacePaths) {
      const matchKind = getWorkspacePathMatchKind(candidatePath, workspacePath);
      if (matchKind === "exact" || matchKind === "child") {
        return matchKind;
      }
      if (matchKind && !fallback) {
        fallback = matchKind;
      }
    }
  }

  return fallback;
}

function getWorkspacePathMatchKind(candidatePath, workspacePath) {
  if (!candidatePath || !workspacePath) {
    return "";
  }

  if (candidatePath === workspacePath) {
    return "exact";
  }

  if (isSameOrDescendantPath(candidatePath, workspacePath)) {
    return "child";
  }

  if (isSameOrDescendantPath(workspacePath, candidatePath)) {
    return "parent";
  }

  return "";
}

function isSameOrDescendantPath(candidatePath, basePath) {
  if (candidatePath === basePath) {
    return true;
  }

  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return candidatePath.startsWith(base);
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

module.exports = {
  findLatestCodexSessionForWorkspace,
  openLatestCodexChatForCurrentWorkspace
};
