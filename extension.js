const vscode = require("vscode");

const {
  initializeAppPreviewStatusBar,
  onDidChangeAppPreviewState,
  getAppPreviewState,
  openAppPreview,
  openAppPreviewExternalBrowser,
  openAppPreviewInVsCodeBrowser,
  restartAppPreview,
  stopAppPreview,
  openDevServerTerminal
} = require("./src/app-preview");
const { ensureTargetConfigurationMigrated, getConfig } = require("./src/config");
const { openLatestCodexChatForCurrentWorkspace } = require("./src/codex-history");
const { configureLinearApiKey } = require("./src/linear-auth");
const { implementLinearIssue, openLinearSidebarIssue } = require("./src/linear-commands");
const {
  LINEAR_ISSUE_DOCUMENT_SCHEME,
  LinearIssueDocumentProvider,
  openLinearIssueDetails
} = require("./src/linear-issue-details");
const { startCodexSessionWatcher } = require("./src/codex-session-watcher");
const { DevServersProvider } = require("./src/dev-server-sidebar");
const { createLinearIssue } = require("./src/linear-sidebar-commands");
const { LinearAssignedIssuesProvider } = require("./src/linear-sidebar");
const { executeAgentSkill } = require("./src/skill-commands");
const { TERMINAL_VIEW_ID, TreehouseTerminalProvider } = require("./src/terminal-panel");
const { registerTreehouseUriHandler } = require("./src/uri-handler");
const {
  setupWorkspace,
  killCurrentWorktree,
  renameCurrentWorktree
} = require("./src/worktree-commands");
const { commitAndPushCurrentWorkspace } = require("./src/commit-commands");
const { consumePendingActions } = require("./src/pending-actions");

function activate(context) {
  const output = vscode.window.createOutputChannel("Treehouse");
  context.subscriptions.push(output);

  const linearIssueDocumentProvider = new LinearIssueDocumentProvider();
  const linearAssignedIssuesProvider = new LinearAssignedIssuesProvider(output);
  const devServersProvider = new DevServersProvider(output);
  const terminalProvider = new TreehouseTerminalProvider(output);
  const codexSessionWatcher = startCodexSessionWatcher(context, output);

  initializeAppPreviewStatusBar(context, output);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      LINEAR_ISSUE_DOCUMENT_SCHEME,
      linearIssueDocumentProvider
    )
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("treehouse.linearAssignedIssues", linearAssignedIssuesProvider)
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("treehouse.devServers", devServersProvider)
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(TERMINAL_VIEW_ID, terminalProvider)
  );
  context.subscriptions.push(
    registerCommand(
      "treehouse.openLinearIssueDetails",
      (issue) => openLinearIssueDetails(linearIssueDocumentProvider, issue),
      output
    )
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("treehouse.linearApiKey") ||
        event.affectsConfiguration("treehouse.linearAssignedIssueFilters") ||
        event.affectsConfiguration("treehouse.linearAssignedIssuesGroupBy")
      ) {
        linearAssignedIssuesProvider.refresh();
      }
      if (event.affectsConfiguration("treehouse.targets")) {
        devServersProvider.refresh();
      }
    })
  );
  context.subscriptions.push(
    onDidChangeAppPreviewState(() => {
      refreshDevServerControls(devServersProvider);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshDevServerControls(devServersProvider);
      terminalProvider.refreshWorkspace();
    }),
    vscode.window.onDidOpenTerminal(() => {
      devServersProvider.refresh();
      terminalProvider.refresh();
    }),
    vscode.window.onDidCloseTerminal(() => {
      devServersProvider.refresh();
      terminalProvider.refresh();
    })
  );
  context.subscriptions.push(registerTreehouseUriHandler(context, output, handleError));
  refreshDevServerControls(devServersProvider);
  ensureTargetConfigurationMigrated(output).catch((error) => {
    handleError(error, output);
  });
  consumePendingActions(context, output).catch((error) => {
    handleError(error, output);
  });
  scheduleStartupCodexChatOpen(context, output);
  context.subscriptions.push(
    registerCommand(
      "treehouse.openAppPreview",
      async () => {
        await openAppPreview(output);
        devServersProvider.refresh();
      },
      output
    ),
    registerCommand(
      "treehouse.openAppPreviewExternalBrowser",
      async () => {
        await openAppPreviewExternalBrowser(output);
        devServersProvider.refresh();
      },
      output
    ),
    registerCommand(
      "treehouse.openAppPreviewInVsCodeBrowser",
      async () => {
        await openAppPreviewInVsCodeBrowser(output);
        devServersProvider.refresh();
      },
      output
    ),
    registerCommand(
      "treehouse.restartAppPreview",
      async () => {
        await restartAppPreview(output);
        devServersProvider.refresh();
      },
      output
    ),
    registerCommand(
      "treehouse.stopAppPreview",
      async () => {
        await stopAppPreview(output);
        devServersProvider.refresh();
      },
      output
    ),
    registerCommand(
      "treehouse.openDevServerTerminal",
      async () => {
        await openDevServerTerminal(output);
        devServersProvider.refresh();
      },
      output
    ),
    registerCommand("treehouse.openTerminal", () => terminalProvider.openTerminal(), output),
    registerCommand(
      "treehouse.openLatestCodexChat",
      () => openLatestCodexChatForCurrentWorkspace(output, { showNoSessionMessage: true }),
      output
    ),
    registerCommand("treehouse.showCodexSessionStatus", () => codexSessionWatcher.showStatus(), output),
    registerCommand("treehouse.startTerminalCodex", () => terminalProvider.startCodex(), output),
    registerCommand("treehouse.sendTerminalCommand", () => terminalProvider.promptAndSendCommand(), output),
    registerCommand("treehouse.restartTerminal", () => terminalProvider.restartTerminal(), output),
    registerCommand("treehouse.clearTerminal", () => terminalProvider.clearTerminal(), output),
    registerCommand("treehouse.setupWorkspace", () => setupWorkspace(context, output), output),
    registerCommand(
      "treehouse.implementLinearIssue",
      async () => {
        await implementLinearIssue(context, output);
        linearAssignedIssuesProvider.refresh();
      },
      output
    ),
    registerCommand(
      "treehouse.openLinearSidebarIssue",
      async (issue) => {
        await openLinearSidebarIssue(context, output, issue);
        linearAssignedIssuesProvider.refresh();
      },
      output
    ),
    registerCommand("treehouse.refreshDevServers", () => devServersProvider.refresh(), output),
    registerCommand("treehouse.refreshLinearIssues", () => linearAssignedIssuesProvider.refresh(), output),
    registerCommand("treehouse.createLinearIssue", () => createLinearIssue(), output),
    registerCommand(
      "treehouse.configureLinearApiKey",
      async () => {
        await configureLinearApiKey();
        linearAssignedIssuesProvider.refresh();
      },
      output
    ),
    registerCommand("treehouse.executeAgentSkill", () => executeAgentSkill(context, output), output),
    registerCommand("treehouse.commitAndPushCurrentWorkspace", () => commitAndPushCurrentWorkspace(output), output),
    registerCommand("treehouse.killCurrentWorktree", () => killCurrentWorktree(output), output),
    registerCommand("treehouse.renameCurrentWorktree", () => renameCurrentWorktree(output), output)
  );
}

function scheduleStartupCodexChatOpen(context, output) {
  if (!getConfig().openLatestCodexChatOnStartup) {
    return;
  }

  const timer = setTimeout(() => {
    openLatestCodexChatForCurrentWorkspace(output).catch((error) => {
      output.appendLine(`Failed to open latest Codex chat: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 1000);

  context.subscriptions.push({
    dispose: () => clearTimeout(timer)
  });
}

function refreshDevServerControls(devServersProvider) {
  const state = getAppPreviewState();
  const hasWorkspace = Boolean(state.hasWorkspace);
  const isBusy = isBusyAppPreviewState(state.status);
  const isRunning = state.status === "running";

  void vscode.commands.executeCommand("setContext", "treehouse.appPreviewHasWorkspace", hasWorkspace);
  void vscode.commands.executeCommand("setContext", "treehouse.appPreviewBusy", isBusy);
  void vscode.commands.executeCommand("setContext", "treehouse.appPreviewRunning", isRunning);
  devServersProvider.refresh();
}

function isBusyAppPreviewState(status) {
  return ["checking", "starting", "restarting", "stopping", "opening-preview", "opening-terminal"].includes(status);
}

function deactivate() {}

function handleError(error, output) {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(message);
  vscode.window.showErrorMessage(message);
}

function registerCommand(command, handler, output) {
  return vscode.commands.registerCommand(command, async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      handleError(error, output);
    }
  });
}

module.exports = {
  activate,
  deactivate
};
