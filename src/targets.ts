const path = require("node:path");
const vscode = require("vscode");

const { getConfig, getLocalTarget, getTargetForSshHost } = require("./config");

const LAST_USED_TARGET_KEY = "treehouse.lastUsedTargetId";

function getTargetPathModule(target) {
  return target?.type === "ssh" ? path.posix : path;
}

function getTargetLabel(target) {
  return target?.label || target?.id || "Unknown";
}

function buildWorkspaceUri(target, folderPath) {
  if (!target) {
    throw new Error("Cannot build a workspace URI without a target.");
  }

  if (target.type === "ssh") {
    return vscode.Uri.from({
      scheme: "vscode-remote",
      authority: `ssh-remote+${target.sshHost}`,
      path: ensureRemotePath(folderPath)
    });
  }

  return vscode.Uri.file(folderPath);
}

function buildWorkspaceIdentifier(target, folderPath) {
  return buildWorkspaceUri(target, folderPath).toString();
}

function getCurrentWorkspaceUri() {
  return vscode.workspace.workspaceFolders?.[0]?.uri || null;
}

function tryGetCurrentWorkspaceLocation(config = getConfig()) {
  const workspaceUri = getCurrentWorkspaceUri();
  if (!workspaceUri) {
    return null;
  }

  return resolveWorkspaceLocation(workspaceUri, config.targets);
}

function getCurrentWorkspaceLocation(config = getConfig()) {
  const workspaceUri = getCurrentWorkspaceUri();
  if (!workspaceUri) {
    throw new Error("Open a workspace folder before using Treehouse.");
  }

  const location = resolveWorkspaceLocation(workspaceUri, config.targets);
  if (!location && workspaceUri.scheme === "vscode-remote") {
    const match = /^ssh-remote\+(.+)$/.exec(workspaceUri.authority || "");
    if (match?.[1]) {
      throw new Error(`Current SSH workspace is not configured in treehouse.targets: ${match[1]}`);
    }
  }

  if (!location) {
    throw new Error("Treehouse does not support this workspace type.");
  }

  return location;
}

function resolveWorkspaceLocation(workspaceUri, targets) {
  if (!workspaceUri) {
    return null;
  }

  if (workspaceUri.scheme === "file") {
    const target = getLocalTarget({ targets });
    return target
      ? {
          target,
          workspacePath: workspaceUri.fsPath,
          workspaceUri
        }
      : null;
  }

  if (workspaceUri.scheme === "vscode-remote") {
    const match = /^ssh-remote\+(.+)$/.exec(workspaceUri.authority || "");
    if (!match?.[1]) {
      return null;
    }

    const target = getTargetForSshHost(match[1], { targets });
    return target
      ? {
          target,
          workspacePath: workspaceUri.path,
          workspaceUri
        }
      : null;
  }

  return null;
}

function getCurrentSshHost() {
  const workspaceUri = getCurrentWorkspaceUri();
  if (workspaceUri?.scheme !== "vscode-remote") {
    return "";
  }

  const match = /^ssh-remote\+(.+)$/.exec(workspaceUri.authority || "");
  return match?.[1] || "";
}

function isRunningOnCurrentSshTarget(target) {
  if (target?.type !== "ssh" || !isRunningInRemoteExtensionHost()) {
    return false;
  }

  const currentSshHost = getCurrentSshHost();
  return Boolean(currentSshHost && (target.sshHost === currentSshHost || target.id === currentSshHost));
}

function isSameWorkspaceLocation(leftTarget, leftPath, rightLocation) {
  if (!leftTarget || !rightLocation?.target) {
    return false;
  }

  if (leftTarget.id !== rightLocation.target.id) {
    return false;
  }

  return normalizeTargetPath(leftTarget, leftPath) === normalizeTargetPath(rightLocation.target, rightLocation.workspacePath);
}

function isPathInsideRoot(target, candidatePath, rootPath) {
  const pathModule = getTargetPathModule(target);
  const normalizedRoot = ensureTrailingSeparator(pathModule.normalize(rootPath), pathModule.sep);
  const normalizedCandidate = ensureTrailingSeparator(pathModule.normalize(candidatePath), pathModule.sep);
  return normalizedCandidate.startsWith(normalizedRoot);
}

async function openWorkspaceFolder(target, folderPath, forceNewWindow = false, output) {
  const folderUri = buildWorkspaceUri(target, folderPath);
  if (output) {
    output.appendLine(
      `Opening ${target.type === "ssh" ? "remote" : "local"} workspace in ${
        forceNewWindow ? "a new" : "the current"
      } window: ${folderUri.toString()}`
    );
  }

  await vscode.commands.executeCommand("vscode.openFolder", folderUri, {
    forceNewWindow,
    forceReuseWindow: !forceNewWindow
  });
}

function getPreferredCreateTarget(context, config = getConfig()) {
  const configuredTarget = String(config.defaultCreateTarget || "").trim();
  if (configuredTarget && configuredTarget !== "last-used") {
    const matchingTarget = config.targets.find((target) => target.id === configuredTarget);
    if (matchingTarget) {
      return matchingTarget;
    }
  }

  const lastUsedTargetId = String(context.globalState.get(LAST_USED_TARGET_KEY) || "").trim();
  if (lastUsedTargetId) {
    const lastUsedTarget = config.targets.find((target) => target.id === lastUsedTargetId);
    if (lastUsedTarget) {
      return lastUsedTarget;
    }
  }

  return getLocalTarget(config) || config.targets[0] || null;
}

async function rememberLastUsedTarget(context, targetId) {
  if (!targetId) {
    return;
  }

  await context.globalState.update(LAST_USED_TARGET_KEY, targetId);
}

function normalizeTargetPath(target, targetPath) {
  return getTargetPathModule(target).normalize(targetPath);
}

function ensureRemotePath(folderPath) {
  const normalizedPath = path.posix.normalize(folderPath || "/");
  return normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
}

function ensureTrailingSeparator(inputPath, separator) {
  return inputPath.endsWith(separator) ? inputPath : `${inputPath}${separator}`;
}

function isRunningInRemoteExtensionHost() {
  return Boolean(process.env.VSCODE_AGENT_FOLDER || process.env.SSH_CONNECTION);
}

module.exports = {
  buildWorkspaceIdentifier,
  buildWorkspaceUri,
  getCurrentWorkspaceLocation,
  getCurrentWorkspaceUri,
  getPreferredCreateTarget,
  getTargetLabel,
  getTargetPathModule,
  isRunningOnCurrentSshTarget,
  isPathInsideRoot,
  isSameWorkspaceLocation,
  openWorkspaceFolder,
  rememberLastUsedTarget,
  resolveWorkspaceLocation,
  tryGetCurrentWorkspaceLocation
};
