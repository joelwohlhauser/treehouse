const vscode = require("vscode");

const { getConfig, getLocalTarget, getTargetById, getTargetForSshHost } = require("./config");
const { openWorkspaceFolder } = require("./targets");
const { resolveTargetPath, resolveTargetRootPaths } = require("./target-adapters");
const { loadRepositoryDescriptors, openOrCreateBranchWorktree } = require("./worktree-commands");

function registerTreehouseUriHandler(context, output, handleError) {
  return vscode.window.registerUriHandler({
    async handleUri(uri) {
      try {
        await handleTreehouseUri(context, output, uri);
      } catch (error) {
        handleError(error, output);
      }
    }
  });
}

async function handleTreehouseUri(context, output, uri) {
  const request = parseTreehouseUri(uri);

  if (!request.action) {
    throw new Error(`Unsupported Treehouse link: ${uri.toString()}`);
  }

  if (request.action !== "open-worktree" && request.action !== "open-workspace" && request.action !== "open-repo") {
    throw new Error(`Unknown Treehouse link action: ${request.action}`);
  }

  const config = getConfig();
  const target = resolveTarget(request, config);
  const forceNewWindow = request.forceNewWindow;

  if (request.path) {
    const workspacePath = await resolveTargetPath(target, request.path);
    output?.appendLine(`Opening workspace from Treehouse link on ${target.label || target.id}: ${workspacePath}`);
    await openWorkspaceFolder(target, workspacePath, forceNewWindow, output);
    return;
  }

  if (!request.repo) {
    throw new Error("Treehouse link must include either 'path' or 'repo'.");
  }

  const repository = await resolveRepository(await resolveTargetRootPaths(target), request.repo, output);

  if (!request.branch || request.action === "open-repo") {
    output?.appendLine(`Opening repository from Treehouse link on ${repository.targetLabel}: ${repository.repoPath}`);
    await openWorkspaceFolder(repository.target, repository.repoPath, forceNewWindow, output);
    return;
  }

  output?.appendLine(
    `Opening worktree from Treehouse link on ${repository.targetLabel}: ${repository.repoName}#${request.branch}`
  );
  await openOrCreateBranchWorktree(context, output, {
    repository,
    branchName: request.branch,
    forceNewWindow
  });
}

function parseTreehouseUri(uri) {
  const params = new URLSearchParams(uri.query || "");

  return {
    action: normalizeAction(uri.path),
    targetId: readQueryValue(params, ["target", "targetId"]),
    sshHost: readQueryValue(params, ["sshHost", "host"]),
    repo: readQueryValue(params, ["repo", "repository"]),
    branch: readQueryValue(params, ["branch"]),
    path: readQueryValue(params, ["path"]),
    forceNewWindow: parseBoolean(readQueryValue(params, ["newWindow", "forceNewWindow"]), true)
  };
}

function normalizeAction(uriPath) {
  const trimmed = String(uriPath || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  return trimmed || "open-worktree";
}

function readQueryValue(params, keys) {
  for (const key of keys) {
    const value = String(params.get(key) || "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function parseBoolean(value, fallback) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (!normalizedValue) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  return fallback;
}

function resolveTarget(request, config) {
  if (request.targetId) {
    const target = getTargetById(request.targetId, config);
    if (target) {
      return target;
    }
  }

  if (request.sshHost) {
    const target = getTargetForSshHost(request.sshHost, config);
    if (target) {
      return target;
    }
  }

  if (request.targetId || request.sshHost) {
    throw new Error(`No Treehouse target matches '${request.targetId || request.sshHost}'.`);
  }

  const localTarget = getLocalTarget(config);
  if (localTarget) {
    return localTarget;
  }

  throw new Error("No Treehouse target is configured.");
}

async function resolveRepository(target, requestedRepo, output) {
  const { repositories } = await loadRepositoryDescriptors(output, [target]);
  const repoCandidates = buildRepoCandidates(requestedRepo);
  const repository = repositories.find((entry) =>
    repoCandidates.includes(String(entry.repoName || "").trim().toLowerCase()) ||
    repoCandidates.includes(String(entry.repoPath || "").trim().toLowerCase())
  );

  if (repository) {
    return repository;
  }

  throw new Error(`Repository '${requestedRepo}' was not found on ${target.label || target.id}.`);
}

function buildRepoCandidates(requestedRepo) {
  const trimmed = String(requestedRepo || "").trim();
  if (!trimmed) {
    return [];
  }

  const normalized = trimmed.toLowerCase().replace(/\/+$/, "");
  const lastSlashIndex = normalized.lastIndexOf("/");
  const lastColonIndex = normalized.lastIndexOf(":");
  const splitIndex = Math.max(lastSlashIndex, lastColonIndex);
  const lastSegment = splitIndex >= 0 ? normalized.slice(splitIndex + 1) : normalized;
  const repoName = lastSegment.replace(/\.git$/i, "");

  return [...new Set([normalized, repoName])];
}

module.exports = {
  handleTreehouseUri,
  registerTreehouseUriHandler
};
