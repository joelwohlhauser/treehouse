const vscode = require("vscode");

const { getConfig } = require("./config");
const { getOrConfigureLinearApiKey } = require("./linear-auth");
const { ensureIssueInProgress, fetchLinearIssue, listAssignedIssues } = require("./linear");
const { pickLinearIssue } = require("./pickers");
const {
  createTargetAdapter,
  getMainWorktree,
  normalizeRepositoryOrigin
} = require("./target-adapters");
const { tryGetCurrentWorkspaceLocation } = require("./targets");
const {
  findExistingWorktreeMatches,
  loadRepositoryDescriptors,
  openOrCreateBranchWorktree
} = require("./worktree-commands");

async function implementLinearIssue(context, output) {
  const apiKey = await getOrConfigureLinearApiKey();
  if (!apiKey) {
    return;
  }

  const assignedIssues = await loadAssignedLinearIssues(apiKey);
  const issueSelection = await pickLinearIssue(assignedIssues);
  if (!issueSelection?.issueId) {
    return;
  }

  await openLinearIssueWorktree(context, output, {
    apiKey,
    issueId: issueSelection.issueId,
    issue: issueSelection.issue
  });
}

async function openLinearSidebarIssue(context, output, issue) {
  const resolvedIssue = normalizeLinearIssueArgument(issue);
  const apiKey = await getOrConfigureLinearApiKey();
  if (!apiKey || !resolvedIssue?.identifier) {
    return;
  }

  await openLinearIssueWorktree(context, output, {
    apiKey,
    issueId: resolvedIssue.identifier,
    issue: resolvedIssue,
    promptForRepository: true
  });
}

async function openLinearIssueWorktree(context, output, { apiKey, issueId, issue: existingIssue, promptForRepository = false }) {
  const config = getConfig();
  const issue = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Preparing Linear issue",
      cancellable: false
    },
    async (progress) => {
      const normalizedIssueId = String(issueId || "").trim().toUpperCase();
      progress.report({ message: `Fetching ${normalizedIssueId}` });
      const fetchedIssue = existingIssue || (await fetchLinearIssue(normalizedIssueId, apiKey));

      if (!config.linearSetIssueInProgress) {
        return fetchedIssue;
      }

      progress.report({ message: "Setting issue status" });
      return ensureIssueInProgress(fetchedIssue.identifier, apiKey);
    }
  );

  const statusMessage = config.linearSetIssueInProgress
    ? `set status to ${issue.state?.name || "In Progress"}`
    : `left Linear status as ${issue.state?.name || "unchanged"}`;
  output.appendLine(`Resolved ${issue.identifier} to branch ${issue.branchName} and ${statusMessage}`);

  const { repositories } = await loadRepositoryDescriptors(undefined, config.targets);
  const agentPrompt = config.linearStartCodingAgent ? `Implement Linear issue ${issue.identifier}` : "";
  const forceNewWindow = config.openInNewWindow;
  if (promptForRepository) {
    const repository = await pickTargetRepositoryForIssue(repositories, issue, {
      forcePrompt: true
    });
    if (!repository) {
      return;
    }

    const existingWorktreePath = await findExistingWorktreeMatches([repository], issue.branchName);
    if (existingWorktreePath.length === 1) {
      output.appendLine(
        `Opening existing worktree for ${issue.identifier} on ${existingWorktreePath[0].repository.targetLabel}: ${existingWorktreePath[0].worktreePath}`
      );
    }

    await openOrCreateBranchWorktree(context, output, {
      repository,
      branchName: issue.branchName,
      agentPrompt,
      forceNewWindow
    });
    return;
  }

  const existingMatches = await findExistingWorktreeMatches(repositories, issue.branchName);

  if (existingMatches.length === 1) {
    output.appendLine(
      `Opening existing worktree for ${issue.identifier} on ${existingMatches[0].repository.targetLabel}: ${existingMatches[0].worktreePath}`
    );
    await openOrCreateBranchWorktree(context, output, {
      repository: existingMatches[0].repository,
      branchName: issue.branchName,
      agentPrompt,
      forceNewWindow
    });
    return;
  }

  if (existingMatches.length > 1) {
    const match = await pickExistingIssueWorktree(issue, existingMatches);
    if (!match) {
      return;
    }

    await openOrCreateBranchWorktree(context, output, {
      repository: match.repository,
      branchName: issue.branchName,
      agentPrompt,
      forceNewWindow
    });
    return;
  }

  const repository = await pickTargetRepositoryForIssue(repositories, issue);
  if (!repository) {
    return;
  }

  await openOrCreateBranchWorktree(context, output, {
    repository,
    branchName: issue.branchName,
    agentPrompt,
    forceNewWindow
  });
}

async function loadAssignedLinearIssues(apiKey) {
  return listAssignedIssues(apiKey, {
    limit: 100,
    filters: getConfig().linearAssignedIssueFilters
  });
}

async function pickExistingIssueWorktree(issue, matches) {
  const pick = await vscode.window.showQuickPick(
    matches.map((entry) => ({
      label: entry.branchName,
      description: `${entry.repository.repoName} • ${entry.repository.targetLabel}`,
      detail: entry.worktreePath,
      entry
    })),
    {
      placeHolder: `Multiple worktrees already exist for ${issue.identifier}. Select one to open.`
    }
  );

  return pick?.entry || null;
}

async function pickTargetRepositoryForIssue(repositories, issue, options: any = {}) {
  const mappedRepoName = getMappedRepositoryNameForIssue(issue);
  if (mappedRepoName) {
    const mappedRepositories = repositories.filter((repository) => repository.repoName === mappedRepoName);
    if (mappedRepositories.length === 1) {
      return mappedRepositories[0];
    }

    if (!mappedRepositories.length) {
      throw new Error(
        `Treehouse repository mapping for team ${issue.teamKey || issue.teamName} points to missing repo: ${mappedRepoName}`
      );
    }

    return pickRepositoryDescriptor(
      mappedRepositories,
      `Select the target for ${mappedRepoName} (${issue.identifier})`
    );
  }

  const currentRepository = options.forcePrompt ? null : await tryGetCurrentRepositoryDescriptor(repositories);
  if (currentRepository) {
    return currentRepository;
  }

  return pickRepositoryDescriptor(
    repositories,
    options.forcePrompt
      ? `Where do you want to implement ${issue.identifier}?`
      : `Select the repository for ${issue.identifier} (${issue.title})`
  );
}

function getMappedRepositoryNameForIssue(issue) {
  const mapping = getConfig().linearTeamRepositoryMap;
  if (!mapping || typeof mapping !== "object") {
    return "";
  }

  return (
    mapping[issue.teamKey] ||
    mapping[String(issue.teamKey || "").toUpperCase()] ||
    mapping[issue.teamName] ||
    ""
  );
}

async function tryGetCurrentRepositoryDescriptor(repositories) {
  const config = getConfig();
  const location = tryGetCurrentWorkspaceLocation(config);
  if (!location) {
    return null;
  }

  const adapter = createTargetAdapter(location.target);
  let repoPath = "";

  try {
    repoPath = await getMainWorktree(adapter, location.workspacePath);
  } catch {
    try {
      repoPath = (
        await adapter.runGit(location.workspacePath, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
      ).trim();
    } catch {
      return null;
    }
  }

  const originUrl = await adapter.getRepoOrigin(repoPath);
  const normalizedOrigin = normalizeRepositoryOrigin(originUrl);
  if (normalizedOrigin) {
    const sameTargetOriginMatches = repositories.filter(
      (repository) =>
        repository.targetId === location.target.id && repository.normalizedOrigin === normalizedOrigin
    );
    if (sameTargetOriginMatches.length === 1) {
      return sameTargetOriginMatches[0];
    }

    const crossTargetOriginMatches = repositories.filter(
      (repository) => repository.normalizedOrigin === normalizedOrigin
    );
    if (crossTargetOriginMatches.length === 1) {
      return crossTargetOriginMatches[0];
    }
  }

  const currentRepoName = getTargetRepositoryName(location.target, repoPath);
  const sameTargetNameMatches = repositories.filter(
    (repository) => repository.targetId === location.target.id && repository.repoName === currentRepoName
  );
  if (sameTargetNameMatches.length === 1) {
    return sameTargetNameMatches[0];
  }

  const crossTargetNameMatches = repositories.filter(
    (repository) => repository.repoName === currentRepoName
  );
  if (crossTargetNameMatches.length === 1) {
    return crossTargetNameMatches[0];
  }

  return null;
}

function getTargetRepositoryName(target, repoPath) {
  return (target.type === "ssh" ? require("node:path").posix : require("node:path")).basename(repoPath);
}

async function pickRepositoryDescriptor(repositories, placeHolder) {
  if (!repositories.length) {
    return null;
  }

  if (repositories.length === 1) {
    return repositories[0];
  }

  const selection = await vscode.window.showQuickPick(
    repositories.map((repository) => ({
      label: repository.repoName,
      description: repository.targetLabel,
      detail: repository.repoPath,
      repository
    })),
    {
      placeHolder
    }
  );

  return selection?.repository || null;
}

function normalizeLinearIssueArgument(value) {
  if (value?.identifier) {
    return value;
  }

  if (value?.issue?.identifier) {
    return value.issue;
  }

  return null;
}

module.exports = {
  implementLinearIssue,
  loadAssignedLinearIssues,
  openLinearSidebarIssue
};
