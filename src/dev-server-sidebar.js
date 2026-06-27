const vscode = require("vscode");

const { getAppPreviewState } = require("./app-preview");
const { listRunningDevServers } = require("./dev-servers");

class DevServersProvider {
  constructor(output) {
    this.output = output;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element instanceof AppPreviewTreeItem) {
      return getAppPreviewControlItems(element.state);
    }

    if (element instanceof DevServerTargetTreeItem) {
      return element.servers.map((server) => new DevServerTreeItem(server));
    }

    if (element) {
      return [];
    }

    const appPreviewItem = new AppPreviewTreeItem(getAppPreviewState());
    try {
      const { target, servers } = await listRunningDevServers();
      if (!servers.length) {
        return [
          appPreviewItem,
          new InfoTreeItem(
            "No dev servers found",
            `No matching dev-server ports are listening on ${target.label}.`
          )
        ];
      }

      return [
        appPreviewItem,
        new DevServerTargetTreeItem(
          target.label,
          `${servers.length} dev server${servers.length === 1 ? "" : "s"}`,
          servers
        )
      ];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Failed to scan dev servers: ${message}`);
      return [appPreviewItem, new ActionTreeItem("Unable to scan dev servers", message, "treehouse.refreshDevServers", "warning")];
    }
  }
}

class AppPreviewTreeItem extends vscode.TreeItem {
  constructor(state) {
    super("App Preview", vscode.TreeItemCollapsibleState.Expanded);

    this.state = state;
    this.description = state.title;
    this.tooltip = buildAppPreviewTooltip(state);
    this.contextValue = "appPreview";
    this.iconPath = new vscode.ThemeIcon(getAppPreviewIcon(state));
  }
}

class DevServerTargetTreeItem extends vscode.TreeItem {
  constructor(label, description, servers) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);

    this.servers = servers;
    this.description = description;
    this.tooltip = `${label}: ${description}`;
    this.contextValue = "devServerTarget";
    this.iconPath = new vscode.ThemeIcon("server");
  }
}

class DevServerTreeItem extends vscode.TreeItem {
  constructor(server) {
    super(`Port ${server.port}`, vscode.TreeItemCollapsibleState.None);

    this.server = server;
    this.description = getServerDescription(server);
    this.tooltip = buildServerTooltip(server);
    this.contextValue = "devServer";
    this.iconPath = new vscode.ThemeIcon("radio-tower");
  }
}

class ActionTreeItem extends vscode.TreeItem {
  constructor(label, description, command, iconName) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = description;
    this.tooltip = description;
    this.iconPath = new vscode.ThemeIcon(iconName);
    this.command = {
      command,
      title: label
    };
  }
}

class InfoTreeItem extends vscode.TreeItem {
  constructor(label, description, iconName = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = description;
    this.tooltip = description;
    this.iconPath = new vscode.ThemeIcon(iconName);
  }
}

function getAppPreviewControlItems(state) {
  if (!state.hasWorkspace) {
    return [new InfoTreeItem("Open a workspace folder", "Treehouse needs a workspace before it can start a dev server.", "warning")];
  }

  if (isBusyAppPreviewState(state.status)) {
    return [new InfoTreeItem(state.title, state.description, getAppPreviewIcon(state))];
  }

  if (state.status === "running") {
    return [
      new ActionTreeItem("Open in Default Browser", state.url || "Open the app preview in your default browser.", "treehouse.openAppPreviewExternalBrowser", "globe"),
      new ActionTreeItem("Open in VS Code", state.url || "Open the app preview in VS Code.", "treehouse.openAppPreviewInVsCodeBrowser", "browser"),
      new ActionTreeItem("Open Terminal", "Reveal the dev server terminal.", "treehouse.openDevServerTerminal", "terminal"),
      new ActionTreeItem("Restart", "Restart the tracked dev server.", "treehouse.restartAppPreview", "debug-restart"),
      new ActionTreeItem("Stop", "Stop the tracked dev server.", "treehouse.stopAppPreview", "stop-circle")
    ];
  }

  return [
    new ActionTreeItem("Start Dev Server", "Start the workspace dev server and open the preview.", "treehouse.openAppPreview", "play")
  ];
}

function isBusyAppPreviewState(status) {
  return ["checking", "starting", "restarting", "stopping", "opening-preview", "opening-terminal"].includes(status);
}

function getAppPreviewIcon(state) {
  switch (state.status) {
    case "running":
      return "radio-tower";
    case "checking":
    case "starting":
    case "restarting":
    case "stopping":
    case "opening-preview":
    case "opening-terminal":
      return "sync";
    case "no-workspace":
      return "warning";
    case "stopped":
    default:
      return "circle-slash";
  }
}

function buildAppPreviewTooltip(state) {
  const lines = ["Treehouse App Preview", state.description];
  if (state.targetLabel) {
    lines.push(`Target: ${state.targetLabel}`);
  }
  if (state.port) {
    lines.push(`Port: ${state.port}`);
  }
  if (state.workspacePath) {
    lines.push(`Workspace: ${state.workspacePath}`);
  }

  return lines.filter(Boolean).join("\n");
}

function getServerDescription(server) {
  const parts = [];
  if (server.processName) {
    parts.push(server.processName);
  }
  if (server.pid) {
    parts.push(`pid ${server.pid}`);
  }

  return parts.join(" ");
}

function buildServerTooltip(server) {
  const lines = [`**Port ${server.port}**`, `Target: ${server.targetLabel}`];
  if (server.pid) {
    lines.push(`PID: ${server.pid}`);
  }
  if (server.cwd) {
    lines.push(`CWD: ${server.cwd}`);
  }
  if (server.command) {
    lines.push("", "Command:", `\`${truncate(server.command, 500)}\``);
  }

  return new vscode.MarkdownString(lines.join("  \n"));
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

module.exports = {
  DevServersProvider
};
