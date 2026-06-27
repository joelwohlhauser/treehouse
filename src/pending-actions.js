const crypto = require("node:crypto");
const vscode = require("vscode");

const { openCodingAgentInTerminal } = require("./agent");
const { getConfig, getTargetById } = require("./config");
const { createTargetAdapter } = require("./target-adapters");
const { getCurrentWorkspaceUri, resolveWorkspaceLocation } = require("./targets");

const PENDING_ACTIONS_KEY = "treehouse.pendingActions";
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

async function consumePendingActions(context, output) {
  const currentWorkspaceUri = getCurrentWorkspaceUri();
  const currentWorkspaceUriString = currentWorkspaceUri?.toString();
  const now = Date.now();
  const actions = await getPendingActions(context);
  const freshActions = actions.filter((action) => now - action.createdAt <= PENDING_ACTION_TTL_MS);
  const matchingActions = currentWorkspaceUriString
    ? freshActions
        .filter((action) => action.targetWorkspaceUri === currentWorkspaceUriString)
        .sort((left, right) => left.createdAt - right.createdAt)
    : null;

  if (freshActions.length !== actions.length || matchingActions?.length) {
    const remainingActions = freshActions.filter(
      (action) => action.targetWorkspaceUri !== currentWorkspaceUriString
    );
    await context.globalState.update(PENDING_ACTIONS_KEY, remainingActions);
  }

  if (!matchingActions?.length) {
    return;
  }

  for (const action of matchingActions) {
    if (action.type === "installDependencies") {
      await runPendingDependencyInstall(action, output);
      continue;
    }

    if (action.type === "openCodingAgentPrompt") {
      await runPendingCodingAgentPrompt(action, output);
    }
  }
}

async function enqueuePendingAction(context, action) {
  const pendingActions = await getPendingActions(context);
  pendingActions.push({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...action
  });
  await context.globalState.update(PENDING_ACTIONS_KEY, pendingActions);
}

async function getPendingActions(context) {
  return context.globalState.get(PENDING_ACTIONS_KEY, []);
}

async function runPendingDependencyInstall(action, output) {
  if (!action?.targetId || !action?.targetPath) {
    return;
  }

  const target = getTargetById(action.targetId);
  if (!target) {
    return;
  }

  const adapter = createTargetAdapter(target);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing dependencies on ${target.label}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: action.command });
      await adapter.ensureCommandAvailable("pnpm", action.targetPath);
      await adapter.runCommand(action.command, action.targetPath, output);
    }
  );
}

async function runPendingCodingAgentPrompt(action, output) {
  if (!action?.targetId || !action?.targetPath) {
    return;
  }

  const config = getConfig();
  const target = getTargetById(action.targetId, config);
  if (!target) {
    return;
  }

  const workspaceUri = getCurrentWorkspaceUri();
  const location = workspaceUri ? resolveWorkspaceLocation(workspaceUri, config.targets) : null;
  await openCodingAgentInTerminal(
    action.prompt,
    {
      cwd: action.targetPath,
      cwdUri: location?.workspaceUri,
      target
    },
    output
  );
}

module.exports = {
  consumePendingActions,
  enqueuePendingAction
};
