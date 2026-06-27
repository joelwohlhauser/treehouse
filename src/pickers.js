const vscode = require("vscode");

const { sortRepositoriesByUsage } = require("./recent-usage");
const { inferRepoNameFromCloneUrl, isLikelyCloneUrl } = require("./target-adapters");
const { getTargetLabel } = require("./targets");

async function pickTarget(targets, options = {}) {
  if (!Array.isArray(targets) || !targets.length) {
    return null;
  }

  if (targets.length === 1) {
    return targets[0];
  }

  const items = targets.map((target) => ({
    label: getTargetLabel(target),
    description: target.type === "ssh" ? `SSH: ${target.sshHost}` : "Local machine",
    detail: `${target.repositoriesRoot} -> ${target.worktreesRoot}`,
    target,
    picked: target.id === options.pickedTargetId
  }));
  const selection = await vscode.window.showQuickPick(items, {
    title: "Treehouse",
    placeHolder: options.placeholder || "Select a Treehouse target"
  });

  return selection?.target || null;
}

async function pickRepositoryOrClone({
  repositories,
  targets,
  cloneTarget,
  pendingRepositories = [],
  usageHistory = {}
}) {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    let settled = false;
    let repositoryItems = buildRepositoryItems(repositories, usageHistory);
    let pendingLoads = pendingRepositories.length;

    quickPick.title = "Treehouse";
    quickPick.placeholder = "Select a repository or paste a Git clone URL";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.busy = pendingLoads > 0;

    const finish = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      quickPick.hide();
      quickPick.dispose();
      resolve(value);
    };

    const buildCloneItem = (typedValue) => {
      if (!typedValue || !isLikelyCloneUrl(typedValue)) {
        return null;
      }

      const repoName = inferRepoNameFromCloneUrl(typedValue);
      if (cloneTarget) {
        return {
          type: "clone",
          label: `$(repo-clone) Clone repository "${typedValue}"`,
          description: `clone on ${getTargetLabel(cloneTarget)}`,
          detail: cloneTarget.type === "ssh" ? cloneTarget.sshHost : cloneTarget.repositoriesRoot,
          cloneUrl: typedValue,
          repoName,
          target: cloneTarget
        };
      }

      return {
        type: "clone",
        label: `$(repo-clone) Clone repository "${typedValue}"`,
        description: targets.length === 1 ? `clone on ${getTargetLabel(targets[0])}` : "choose target after selection",
        detail: targets.length === 1 ? targets[0].repositoriesRoot : "",
        cloneUrl: typedValue,
        repoName,
        target: targets.length === 1 ? targets[0] : null
      };
    };

    const updateItems = () => {
      const typedValue = quickPick.value.trim();
      const cloneItem = buildCloneItem(typedValue);
      quickPick.items = cloneItem ? [cloneItem, ...repositoryItems] : repositoryItems;
    };

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      const typedValue = quickPick.value.trim();

      if (selected) {
        finish(selected);
        return;
      }

      const cloneItem = buildCloneItem(typedValue);
      if (cloneItem) {
        finish(cloneItem);
      }
    });

    quickPick.onDidChangeValue(updateItems);
    quickPick.onDidHide(() => {
      finish(null);
    });

    for (const pendingRepositoryLoad of pendingRepositories) {
      Promise.resolve(pendingRepositoryLoad)
        .then((loadedRepositories) => {
          if (!settled && loadedRepositories?.length) {
            repositoryItems = buildRepositoryItems([
              ...repositories,
              ...loadedRepositories
            ], usageHistory);
            repositories = [...repositories, ...loadedRepositories];
            updateItems();
          }
        })
        .catch(() => {
          // Ignore individual background load failures here. The caller logs them.
        })
        .finally(() => {
          pendingLoads -= 1;
          if (!settled) {
            quickPick.busy = pendingLoads > 0;
          }
        });
    }

    updateItems();
    quickPick.show();
  });
}

function buildRepositoryItems(repositories, usageHistory = {}) {
  return sortRepositoriesByUsage(repositories, usageHistory)
    .map((repository) => ({
      type: "existing",
      label: repository.repoName,
      description: repository.targetLabel,
      detail: repository.repoPath,
      repository
    }));
}

async function pickWorktreeOrBranch({ repository, worktrees, branches }) {
  const worktreeItems = worktrees
    .filter((worktree) => worktree.branch)
    .map((worktree) => ({
      type: "existing",
      label: worktree.branch,
      description: `${repository.targetLabel} • ${worktree.isMain ? "main checkout" : "existing worktree"}`,
      detail: worktree.path,
      path: worktree.path
    }));
  const worktreeBranchNames = new Set(worktreeItems.map((item) => item.label));
  const branchItems = branches
    .filter((branch) => !worktreeBranchNames.has(branch.name))
    .map((branch) => ({
      type: "branch",
      label: branch.name,
      description: `${repository.targetLabel} • ${branch.scope}`,
      detail: branch.remoteName ? `tracks ${branch.remoteName}` : "",
      branchName: branch.name
    }));

  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    let settled = false;
    const staticItems = [];

    quickPick.title = "Treehouse";
    quickPick.placeholder = `Open an existing worktree or create a branch on ${repository.targetLabel}`;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    if (worktreeItems.length > 0) {
      staticItems.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: "Existing Worktrees"
      });
      staticItems.push(...worktreeItems);
    }

    if (branchItems.length > 0) {
      staticItems.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: "Branches"
      });
      staticItems.push(...branchItems);
    }

    const finish = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      quickPick.hide();
      quickPick.dispose();
      resolve(value);
    };

    const updateItems = () => {
      const typedValue = quickPick.value.trim();
      const items = [];

      if (typedValue && !staticItems.some((item) => item.label === typedValue)) {
        items.push({
          type: "new",
          label: `$(add) Create new branch "${typedValue}"`,
          description: `new branch on ${repository.targetLabel}`,
          branchName: typedValue
        });
      }

      quickPick.items = [...items, ...staticItems];
    };

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      const typedValue = quickPick.value.trim();

      if (selected) {
        if (selected.type === "existing") {
          finish(selected);
          return;
        }

        if (selected.type === "branch" || selected.type === "new") {
          finish({
            type: "branch",
            branchName: selected.branchName
          });
          return;
        }
      }

      if (typedValue) {
        finish({
          type: "branch",
          branchName: typedValue
        });
      }
    });

    quickPick.onDidChangeValue(updateItems);
    quickPick.onDidHide(() => {
      finish(null);
    });

    updateItems();
    quickPick.show();
  });
}

async function pickLinearIssue(issues) {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    let settled = false;
    const issueItems = issues.map((issue) => ({
      type: "existing",
      label: issue.identifier,
      description: [issue.teamKey, issue.state?.name].filter(Boolean).join(" • "),
      detail: issue.title,
      issue
    }));

    quickPick.title = "Treehouse";
    quickPick.placeholder = "Select one of your assigned Linear issues or type another issue identifier";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    const finish = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      quickPick.hide();
      quickPick.dispose();
      resolve(value);
    };

    const updateItems = () => {
      const typedValue = quickPick.value.trim().toUpperCase();
      const items = [];

      if (typedValue && !issueItems.some((item) => item.label.toUpperCase() === typedValue)) {
        items.push({
          type: "typed",
          label: `$(search) Use "${typedValue}"`,
          description: "fetch issue by identifier",
          issueId: typedValue
        });
      }

      quickPick.items = [...items, ...issueItems];
    };

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      const typedValue = quickPick.value.trim().toUpperCase();

      if (selected?.type === "existing") {
        finish({
          issueId: selected.issue.identifier,
          issue: selected.issue
        });
        return;
      }

      if (selected?.type === "typed") {
        finish({
          issueId: selected.issueId
        });
        return;
      }

      if (typedValue) {
        finish({
          issueId: typedValue
        });
      }
    });

    quickPick.onDidChangeValue(updateItems);
    quickPick.onDidHide(() => {
      finish(null);
    });

    updateItems();
    quickPick.show();
  });
}

module.exports = {
  pickLinearIssue,
  pickRepositoryOrClone,
  pickTarget,
  pickWorktreeOrBranch
};
