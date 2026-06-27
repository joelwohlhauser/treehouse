const vscode = require("vscode");

const { stopPreviewForWorkspace } = require("./app-preview");
const { openCodingAgentInTerminal } = require("./agent");
const { getConfig } = require("./config");
const { resolveWorktreePath, shouldOpenFolderInNewWindow } = require("./fs-utils");
const { enqueuePendingAction } = require("./pending-actions");
const { pickRepositoryOrClone, pickTarget, pickWorktreeOrBranch } = require("./pickers");
const { getRepositoryUsageHistory, recordRepositoryUsed } = require("./recent-usage");
const {
  branchExistsLocally,
  branchExistsOnOrigin,
  createTargetAdapter,
  createWorktreeFromBranch,
  ensureBranchTracksOrigin,
  findExistingWorktree,
  getCurrentBranchName,
  getMainWorktree,
  listBranches,
  listWorktrees,
  unsetBranchUpstream
} = require("./target-adapters");
const {
  buildWorkspaceIdentifier,
  getCurrentWorkspaceLocation,
  getPreferredCreateTarget,
  getTargetLabel,
  getTargetPathModule,
  isPathInsideRoot,
  isSameWorkspaceLocation,
  openWorkspaceFolder,
  rememberLastUsedTarget,
  tryGetCurrentWorkspaceLocation
} = require("./targets");

async function setupWorkspace(context, output) {
  const config = getConfig();
  const adapters = new Map(config.targets.map((target) => [target.id, createTargetAdapter(target)]));
  const usageHistory = getRepositoryUsageHistory(context);
  let targetFilter = null;

  if (config.alwaysPromptForTarget) {
    targetFilter = await pickTarget(config.targets, {
      placeholder: "Select where Treehouse should create or open the worktree",
      pickedTargetId: getPreferredCreateTarget(context, config)?.id
    });
    if (!targetFilter) {
      return;
    }
  }

  let availableRepositories = [];
  let pendingRepositories = [];

  if (targetFilter) {
    availableRepositories = await loadRepositoriesForTargets([targetFilter], adapters, output);
  } else {
    const localTarget = config.targets.find((target) => target.type === "local") || config.targets[0];
    const remoteTargets = config.targets.filter((target) => target.id !== localTarget?.id);

    availableRepositories = localTarget
      ? await loadRepositoriesForTargets([localTarget], adapters, output)
      : [];
    pendingRepositories = remoteTargets.map((target) =>
      loadRepositoriesForTargets([target], adapters, output)
    );
  }

  const defaultCloneTarget = targetFilter || getPreferredCreateTarget(context, config);
  const repoSelection = await pickRepositoryOrClone({
    repositories: availableRepositories,
    targets: targetFilter ? [targetFilter] : config.targets,
    cloneTarget: defaultCloneTarget,
    pendingRepositories,
    usageHistory
  });
  if (!repoSelection) {
    return;
  }

  let repository = repoSelection.repository;
  if (repoSelection.type === "clone") {
    const cloneTarget =
      repoSelection.target ||
      (await pickTarget(config.targets, {
        placeholder: "Select the target where Treehouse should clone this repository",
        pickedTargetId: defaultCloneTarget?.id
      }));
    if (!cloneTarget) {
      return;
    }

    const adapter = adapters.get(cloneTarget.id) || createTargetAdapter(cloneTarget);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Cloning repository on ${getTargetLabel(cloneTarget)}`,
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: repoSelection.cloneUrl });
        repository = await adapter.cloneRepository(repoSelection.cloneUrl, output);
      }
    );
  }

  const repositoryAdapter = adapters.get(repository.targetId) || createTargetAdapter(repository.target);
  const [worktrees, branches] = await Promise.all([
    listWorktrees(repositoryAdapter, repository.repoPath),
    listBranches(repositoryAdapter, repository.repoPath)
  ]);
  const selection = await pickWorktreeOrBranch({
    repository,
    worktrees,
    branches
  });
  if (!selection) {
    return;
  }

  if (selection.type === "existing") {
    output.appendLine(`Opening existing worktree on ${repository.targetLabel}: ${selection.path}`);
    await recordRepositoryUsed(context, repository);
    await rememberLastUsedTarget(context, repository.targetId);
    await openWorkspaceFolder(
      repository.target,
      selection.path,
      shouldOpenFolderInNewWindow(config.openInNewWindow),
      output
    );
    return;
  }

  await openOrCreateBranchWorktree(context, output, {
    repository,
    branchName: selection.branchName
  });
}

async function loadRepositoryDescriptors(output, targets = getConfig().targets) {
  const adapters = new Map(targets.map((target) => [target.id, createTargetAdapter(target)]));
  const repositories = await loadRepositoriesForTargets(targets, adapters, output);
  return { adapters, repositories };
}

async function loadRepositoriesForTargets(targets, adapters, output) {
  return (
    await Promise.all(
      targets.map(async (target) => {
        const adapter = adapters.get(target.id) || createTargetAdapter(target);
        try {
          return await adapter.listPrimaryRepos();
        } catch (error) {
          if (output) {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`Failed to load repositories on ${adapter.getTargetLabel()}: ${message}`);
          }
          return [];
        }
      })
    )
  )
    .flat()
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

const TERMINAL_CLOSE_TIMEOUT_MS = 5000;

async function closeWindowTerminals(output, options = {}) {
  const terminals = [...vscode.window.terminals];
  if (!terminals.length) {
    return;
  }

  const failOnTimeout = options.failOnTimeout !== false;
  output.appendLine(`Closing ${terminals.length} terminal(s) before removing worktree`);

  await new Promise((resolve, reject) => {
    const pending = new Set(terminals);
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      closeDisposable.dispose();

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    const closeDisposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
      pending.delete(closedTerminal);
      if (!pending.size) {
        finish();
      }
    });

    const timeoutHandle = setTimeout(() => {
      const remainingTerminalNames = [...pending].map((terminal) => terminal.name || "unnamed terminal");
      const message = `Timed out waiting for terminal(s) to close: ${remainingTerminalNames.join(", ")}`;
      if (failOnTimeout) {
        finish(new Error(message));
        return;
      }

      output.appendLine(`${message}. Continuing with remote worktree removal.`);
      finish();
    }, TERMINAL_CLOSE_TIMEOUT_MS);

    for (const terminal of terminals) {
      try {
        terminal.dispose();
      } catch (error) {
        finish(error);
        return;
      }
    }

    if (!pending.size) {
      finish();
    }
  });
}

async function killCurrentWorktree(output) {
  const config = getConfig();
  const location = getCurrentWorkspaceLocation(config);
  const adapter = createTargetAdapter(location.target);
  const currentWorktree = (
    await adapter.runGit(location.workspacePath, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
  ).trim();
  const gitDir = (
    await adapter.runGit(location.workspacePath, ["rev-parse", "--path-format=absolute", "--git-dir"])
  ).trim();
  const mainWorktree = await getMainWorktree(adapter, location.workspacePath);
  const currentBranch = await getCurrentBranchName(adapter, location.workspacePath);

  if (!/[\\/]worktrees[\\/]/.test(gitDir) || currentWorktree === mainWorktree) {
    throw new Error("Refusing to remove the main worktree.");
  }

  const statusOutput = await adapter.runGit(location.workspacePath, ["status", "--porcelain"]);
  const hasUncommittedChanges = Boolean(statusOutput.trim());

  if (hasUncommittedChanges) {
    const confirmation = await vscode.window.showWarningMessage(
      `This worktree on ${getTargetLabel(location.target)} has uncommitted changes. Remove it anyway?`,
      { modal: true },
      "Remove Worktree"
    );

    if (confirmation !== "Remove Worktree") {
      return;
    }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Removing worktree on ${getTargetLabel(location.target)}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Stopping dev server" });
      await stopPreviewForWorkspace(location, output);

      progress.report({ message: "Closing terminals" });
      await closeWindowTerminals(output, {
        failOnTimeout: location.target.type !== "ssh"
      });

      progress.report({ message: "Removing worktree files" });
      const removeArgs = ["worktree", "remove"];
      if (hasUncommittedChanges) {
        removeArgs.push("--force");
      }
      removeArgs.push(currentWorktree);
      await adapter.runGit(mainWorktree, removeArgs, output);

      if (
        currentBranch &&
        (await branchExistsLocally(adapter, mainWorktree, currentBranch)) &&
        !(await branchExistsOnOrigin(adapter, mainWorktree, currentBranch))
      ) {
        output.appendLine(`Deleting local-only branch ${currentBranch} on ${getTargetLabel(location.target)}`);
        await adapter.runGit(mainWorktree, ["branch", "-D", currentBranch], output);
      }

      if (isPathInsideRoot(location.target, currentWorktree, location.target.worktreesRoot)) {
        await adapter.pruneEmptyParentDirectories(currentWorktree, location.target.worktreesRoot);
      }
    }
  );

  await vscode.commands.executeCommand("workbench.action.closeWindow");
}

async function renameCurrentWorktree(output) {
  const config = getConfig();
  const location = getCurrentWorkspaceLocation(config);
  const adapter = createTargetAdapter(location.target);
  const currentWorktree = (
    await adapter.runGit(location.workspacePath, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
  ).trim();
  const gitDir = (
    await adapter.runGit(location.workspacePath, ["rev-parse", "--path-format=absolute", "--git-dir"])
  ).trim();
  const mainWorktree = await getMainWorktree(adapter, location.workspacePath);
  const currentBranch = await getCurrentBranchName(adapter, location.workspacePath);
  const pathModule = getTargetPathModule(location.target);
  const repoName = pathModule.basename(mainWorktree);

  if (!/[\\/]worktrees[\\/]/.test(gitDir) || currentWorktree === mainWorktree) {
    throw new Error("Refusing to rename the main worktree.");
  }

  if (!currentBranch) {
    throw new Error("Current worktree is in detached HEAD state and cannot be renamed.");
  }

  const newBranchName = await vscode.window.showInputBox({
    prompt: `Enter the new worktree and branch name for ${getTargetLabel(location.target)}`,
    value: currentBranch,
    validateInput(value) {
      if (!value.trim()) {
        return "Branch name cannot be empty.";
      }

      if (value.trim() === currentBranch) {
        return "Enter a different branch name.";
      }

      return null;
    }
  });

  if (!newBranchName) {
    return;
  }

  const trimmedBranchName = newBranchName.trim();
  const newWorktreePath = resolveWorktreePath(
    location.target.worktreesRoot,
    config.worktreePathTemplate,
    repoName,
    trimmedBranchName,
    pathModule
  );

  if (await branchExistsLocally(adapter, mainWorktree, trimmedBranchName)) {
    throw new Error(`A local branch named '${trimmedBranchName}' already exists.`);
  }

  if (newWorktreePath !== currentWorktree && (await adapter.pathExists(newWorktreePath))) {
    throw new Error(`Target worktree path already exists: ${newWorktreePath}`);
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Renaming worktree on ${getTargetLabel(location.target)}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Renaming branch" });
      await adapter.runGit(location.workspacePath, ["branch", "-m", currentBranch, trimmedBranchName], output);

      if (await branchExistsOnOrigin(adapter, mainWorktree, trimmedBranchName)) {
        progress.report({ message: "Updating upstream tracking" });
        await ensureBranchTracksOrigin(adapter, mainWorktree, trimmedBranchName, output);
      } else {
        await unsetBranchUpstream(adapter, mainWorktree, trimmedBranchName);
      }

      if (newWorktreePath !== currentWorktree) {
        progress.report({ message: "Moving worktree" });
        await adapter.ensureDirectoryExists(pathModule.dirname(newWorktreePath));
        await adapter.runGit(mainWorktree, ["worktree", "move", currentWorktree, newWorktreePath], output);
        if (isPathInsideRoot(location.target, currentWorktree, location.target.worktreesRoot)) {
          await adapter.pruneEmptyParentDirectories(currentWorktree, location.target.worktreesRoot);
        }
      }
    }
  );

  if (newWorktreePath !== currentWorktree) {
    await openWorkspaceFolder(location.target, newWorktreePath, false, output);
  }
}

async function openOrCreateBranchWorktree(context, output, options) {
  const config = getConfig();
  const repository = options.repository;
  const adapter = createTargetAdapter(repository.target);
  const pathModule = getTargetPathModule(repository.target);
  const branchName = String(options.branchName || "").trim();
  const targetOpenInNewWindow = shouldOpenFolderInNewWindow(
    options.forceNewWindow ?? config.openInNewWindow
  );
  const worktreePath = resolveWorktreePath(
    repository.target.worktreesRoot,
    config.worktreePathTemplate,
    repository.repoName,
    branchName,
    pathModule
  );
  const existingWorktree = await findExistingWorktree(adapter, repository.repoPath, branchName);
  const currentWorkspaceLocation = tryGetCurrentWorkspaceLocation(config);

  if (existingWorktree) {
    output.appendLine(`Opening existing worktree on ${repository.targetLabel}: ${existingWorktree}`);
    await adapter.linkOrCopyEnv(repository.repoPath, existingWorktree, config.envFileMode, output);
    await recordRepositoryUsed(context, repository);

    if (isSameWorkspaceLocation(repository.target, existingWorktree, currentWorkspaceLocation)) {
      if (options.agentPrompt) {
        await openCodingAgentInTerminal(
          options.agentPrompt,
          {
            cwd: existingWorktree,
            cwdUri: currentWorkspaceLocation.workspaceUri,
            target: repository.target
          },
          output
        );
      }
      await rememberLastUsedTarget(context, repository.targetId);
      return;
    }

    await enqueuePostOpenActions(context, repository.target, existingWorktree, {
      agentPrompt: options.agentPrompt
    });
    await rememberLastUsedTarget(context, repository.targetId);
    await openWorkspaceFolder(repository.target, existingWorktree, targetOpenInNewWindow, output);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Setting up worktree on ${repository.targetLabel}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Preparing worktree" });
      await createWorktreeFromBranch(adapter, repository.repoPath, branchName, worktreePath, output);

      progress.report({ message: "Linking environment" });
      await adapter.linkOrCopyEnv(repository.repoPath, worktreePath, config.envFileMode, output);

      progress.report({ message: "Preparing workspace" });
      await adapter.ensureDirectoryExists(pathModule.join(worktreePath, "node_modules"));

      await enqueuePostOpenActions(context, repository.target, worktreePath, {
        installDependencies: config.installDependencies,
        agentPrompt: options.agentPrompt
      });
    }
  );

  await rememberLastUsedTarget(context, repository.targetId);
  await recordRepositoryUsed(context, repository);
  await openWorkspaceFolder(repository.target, worktreePath, targetOpenInNewWindow, output);
}

async function findExistingWorktreeMatches(repositories, branchName) {
  const matches = [];

  for (const repository of repositories) {
    const adapter = createTargetAdapter(repository.target);
    const worktreePath = await findExistingWorktree(adapter, repository.repoPath, branchName);
    if (!worktreePath) {
      continue;
    }

    matches.push({
      repository,
      branchName,
      worktreePath
    });
  }

  return matches;
}

async function enqueuePostOpenActions(context, target, targetPath, options) {
  const targetWorkspaceUri = buildWorkspaceIdentifier(target, targetPath);

  if (options.installDependencies) {
    await enqueuePendingAction(context, {
      type: "installDependencies",
      targetId: target.id,
      targetPath,
      targetWorkspaceUri,
      command: "pnpm i"
    });
  }

  if (options.agentPrompt) {
    await enqueuePendingAction(context, {
      type: "openCodingAgentPrompt",
      targetId: target.id,
      targetPath,
      targetWorkspaceUri,
      prompt: options.agentPrompt
    });
  }
}

module.exports = {
  findExistingWorktreeMatches,
  killCurrentWorktree,
  loadRepositoryDescriptors,
  openOrCreateBranchWorktree,
  renameCurrentWorktree,
  setupWorkspace
};
