const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

async function ensureDirectoryExists(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function pruneEmptyParentDirectories(startPath, stopPath) {
  let currentPath = path.dirname(startPath);

  while (currentPath !== stopPath && currentPath !== path.parse(currentPath).root) {
    try {
      await fs.rmdir(currentPath);
    } catch {
      break;
    }

    currentPath = path.dirname(currentPath);
  }
}

function getCurrentWorkspacePath() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Open a workspace folder before using Treehouse.");
  }

  return folder.uri.fsPath;
}

function shouldOpenFolderInNewWindow(preferNewWindow = false) {
  return Boolean(vscode.workspace.workspaceFolders?.length) || preferNewWindow;
}

async function openFolder(folderPath, forceNewWindow = false) {
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folderPath), forceNewWindow);
}

function resolveWorktreePath(worktreesRoot, template, repoName, branchName, pathModule = path) {
  const relativePath = String(template)
    .replaceAll("${repo}", repoName)
    .replaceAll("${branch}", branchName)
    .replaceAll("${sanitizedBranch}", sanitizeBranchName(branchName))
    .trim();

  if (!relativePath) {
    throw new Error("treehouse.worktreePathTemplate cannot be empty.");
  }

  const normalizedPath = pathModule.normalize(relativePath);
  if (
    pathModule.isAbsolute(normalizedPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith(`..${pathModule.sep}`)
  ) {
    throw new Error("treehouse.worktreePathTemplate must resolve inside treehouse.worktreesRoot.");
  }

  return pathModule.join(worktreesRoot, ...normalizedPath.split(/[\\/]+/));
}

function sanitizeBranchName(branchName) {
  return branchName.replace(/[\\/]/g, "-");
}

module.exports = {
  ensureDirectoryExists,
  getCurrentWorkspacePath,
  openFolder,
  pruneEmptyParentDirectories,
  resolveWorktreePath,
  sanitizeBranchName,
  shouldOpenFolderInNewWindow
};
