const path = require("node:path");
const vscode = require("vscode");

const { resolveCommandForTarget } = require("./command-utils");
const { getConfig } = require("./config");
const { createTargetAdapter } = require("./target-adapters");
const { getCurrentWorkspaceLocation, getTargetLabel } = require("./targets");

const TERMINAL_VIEW_ID = "treehouse.terminal";

class TreehouseTerminalProvider {
  constructor(output) {
    this.output = output;
    this.terminal = null;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  refreshWorkspace() {
    this.terminal = null;
    this.refresh();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (element) {
      return [];
    }

    const terminal = this.getExistingTerminal();
    const location = tryGetWorkspaceLocation();
    const items = [];

    if (!location) {
      items.push(new InfoTreeItem("Open a workspace folder", "Treehouse needs a workspace before it can open a terminal.", "warning"));
      return items;
    }

    const targetLabel = getTargetLabel(location.target);
    const terminalName = getTerminalName(location);
    if (terminal) {
      items.push(new InfoTreeItem(terminalName, `Ready on ${targetLabel}`, "terminal"));
    } else {
      items.push(new InfoTreeItem("No Treehouse terminal", `Workspace on ${targetLabel}`, "circle-large-outline"));
    }

    items.push(
      new ActionTreeItem(
        terminal ? "Reveal terminal" : "Open terminal",
        terminal ? "Show the existing integrated terminal." : "Create a native integrated terminal.",
        "treehouse.openTerminal",
        "terminal"
      ),
      new ActionTreeItem(
        "Open latest Codex chat",
        "Open the newest Codex chat history for this workspace.",
        "treehouse.openLatestCodexChat",
        "comment-discussion"
      ),
      new ActionTreeItem("Start Codex", "Run the configured coding agent command.", "treehouse.startTerminalCodex", "play"),
      new ActionTreeItem("Send command", "Send a command to the terminal.", "treehouse.sendTerminalCommand", "terminal"),
      new ActionTreeItem("Clear", "Clear the terminal screen.", "treehouse.clearTerminal", "clear-all"),
      new ActionTreeItem("Restart", "Dispose the terminal and create a fresh one.", "treehouse.restartTerminal", "debug-restart")
    );

    return items;
  }

  async openTerminal() {
    const terminal = this.ensureTerminal();
    terminal.show(false);
    this.refresh();
  }

  async startCodex() {
    const command = String(getConfig().codingAgentCommand || "codex").trim();
    if (!command) {
      throw new Error("treehouse.codingAgentCommand cannot be empty.");
    }

    const location = getCurrentWorkspaceLocation();
    const adapter = createTargetAdapter(location.target);
    const resolvedCommand = await resolveCommandForTarget(adapter, command, location.workspacePath, {
      settingName: "treehouse.codingAgentCommand"
    });
    if (resolvedCommand.fallbackFrom) {
      this.output?.appendLine(
        `Using ${resolvedCommand.primaryCommand} on ${getTargetLabel(location.target)} instead of ${resolvedCommand.fallbackFrom}.`
      );
    }

    await this.sendText(resolvedCommand.command, true);
  }

  async promptAndSendCommand() {
    const command = await vscode.window.showInputBox({
      prompt: "Command to send to the Treehouse terminal",
      placeHolder: "codex"
    });
    if (command === undefined) {
      return;
    }

    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      return;
    }

    await this.sendText(trimmedCommand, true);
  }

  async restartTerminal() {
    const existingTerminal = this.getExistingTerminal();
    if (existingTerminal) {
      existingTerminal.dispose();
    }

    this.terminal = this.createTerminal(getCurrentWorkspaceLocation());
    const terminal = this.terminal;
    terminal.show(false);
    this.refresh();
  }

  async clearTerminal() {
    const terminal = this.ensureTerminal();
    terminal.show(false);
    terminal.sendText("\x0c", false);
    this.refresh();
  }

  async sendText(text, shouldExecute) {
    const terminal = this.ensureTerminal();
    terminal.show(false);
    terminal.sendText(text, shouldExecute);
    this.refresh();
  }

  ensureTerminal() {
    const activeTerminal = this.getExistingTerminal();
    if (activeTerminal) {
      return activeTerminal;
    }

    return this.createTerminal(getCurrentWorkspaceLocation());
  }

  createTerminal(location) {
    const terminal = vscode.window.createTerminal({
      name: getTerminalName(location),
      cwd: location.workspaceUri,
      location: vscode.TerminalLocation.Panel,
      isTransient: false
    });

    this.terminal = terminal;
    this.output?.appendLine(`Opened Treehouse integrated terminal for ${location.workspacePath} on ${getTargetLabel(location.target)}.`);
    return terminal;
  }

  getExistingTerminal() {
    if (this.terminal && vscode.window.terminals.includes(this.terminal)) {
      return this.terminal;
    }

    const location = tryGetWorkspaceLocation();
    if (!location) {
      this.terminal = null;
      return null;
    }

    const terminalName = getTerminalName(location);
    this.terminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName) || null;
    return this.terminal;
  }
}

class ActionTreeItem extends vscode.TreeItem {
  constructor(label, description, command, iconName) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = description;
    this.tooltip = description;
    this.contextValue = "treehouseTerminalAction";
    this.iconPath = new vscode.ThemeIcon(iconName);
    this.command = {
      command,
      title: label
    };
  }
}

class InfoTreeItem extends vscode.TreeItem {
  constructor(label, description, iconName) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = description;
    this.tooltip = description;
    this.contextValue = "treehouseTerminalStatus";
    this.iconPath = new vscode.ThemeIcon(iconName);
  }
}

function tryGetWorkspaceLocation() {
  try {
    return getCurrentWorkspaceLocation();
  } catch {
    return null;
  }
}

function getTerminalName(location) {
  const folderName = path.basename(location.workspacePath || "") || "Workspace";
  return `Treehouse: ${folderName}`;
}

module.exports = {
  TERMINAL_VIEW_ID,
  TreehouseTerminalProvider
};
