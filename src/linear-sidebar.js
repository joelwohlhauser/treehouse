const vscode = require("vscode");

const { getConfig } = require("./config");
const { loadAssignedLinearIssues } = require("./linear-commands");

class LinearAssignedIssuesProvider {
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
    if (element instanceof StatusGroupTreeItem) {
      return element.issues.map((issue) => new LinearIssueTreeItem(issue));
    }

    if (element) {
      return [];
    }

    const { linearApiKey, linearAssignedIssueFilters, linearAssignedIssuesGroupBy } = getConfig();
    if (!linearApiKey) {
      return [
        new ActionTreeItem(
          "Configure Linear API key",
          "Set treehouse.linearApiKey to load your assigned issues.",
          "treehouse.configureLinearApiKey",
          "key"
        )
      ];
    }

    try {
      const issues = await loadAssignedLinearIssues(linearApiKey);
      if (!issues.length) {
        return [
          new InfoTreeItem(
            "No assigned issues",
            linearAssignedIssueFilters.length
              ? `No issues matched: ${linearAssignedIssueFilters.join(", ")}`
              : "No Linear issues are currently assigned to you."
          )
        ];
      }

      return groupIssues(issues, linearAssignedIssuesGroupBy).map(({ label, description, issues: groupedIssues }) => {
        return new StatusGroupTreeItem(label, description, groupedIssues);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Failed to load Linear issues: ${message}`);
      return [new ActionTreeItem("Unable to load Linear issues", message, "treehouse.refreshLinearIssues", "warning")];
    }
  }
}

class StatusGroupTreeItem extends vscode.TreeItem {
  constructor(label, description, issues) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);

    this.issues = issues;
    this.description = description;
    this.tooltip = `${label}: ${description}`;
    this.contextValue = "linearIssueStatusGroup";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

class LinearIssueTreeItem extends vscode.TreeItem {
  constructor(issue) {
    super(issue.title, vscode.TreeItemCollapsibleState.None);

    this.issue = issue;
    this.description = issue.identifier;
    this.tooltip = buildIssueTooltip(issue);
    this.contextValue = "linearIssue";
    this.iconPath = new vscode.ThemeIcon(getIssueIconName(issue));
    this.command = {
      command: "treehouse.openLinearIssueDetails",
      title: "Open Linear Issue Details",
      arguments: [issue]
    };
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
  constructor(label, description) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = description;
    this.tooltip = description;
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

function buildIssueTooltip(issue) {
  const lines = [`**${issue.identifier}**`, issue.title];
  const metadata = [issue.teamKey || issue.teamName, issue.state?.name, issue.projectName].filter(Boolean);
  if (metadata.length) {
    lines.push("", metadata.join(" • "));
  }

  if (issue.labels.length) {
    lines.push("", `Labels: ${issue.labels.join(", ")}`);
  }

  return new vscode.MarkdownString(lines.join("  \n"));
}

function getIssueIconName(issue) {
  switch (issue.state?.type) {
    case "started":
      return "play-circle";
    case "completed":
      return "pass";
    case "canceled":
      return "circle-slash";
    case "backlog":
    case "unstarted":
      return "circle-large-outline";
    default:
      return "issues";
  }
}

function groupIssues(issues, groupBy) {
  if (groupBy === "project") {
    return groupIssuesByProject(issues);
  }

  return groupIssuesByStatus(issues);
}

function groupIssuesByStatus(issues) {
  const groups = new Map();

  for (const issue of issues) {
    const label = issue.state?.name || "No Status";
    const sortKey = getStatusSortKey(issue);
    if (!groups.has(label)) {
      groups.set(label, {
        label,
        description: "",
        issues: [],
        sortKey
      });
    }

    groups.get(label).issues.push(issue);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      description: `${group.issues.length} issue${group.issues.length === 1 ? "" : "s"}`
    }))
    .sort((left, right) => {
      if (left.sortKey !== right.sortKey) {
        return left.sortKey - right.sortKey;
      }

      return left.label.localeCompare(right.label);
    });
}

function groupIssuesByProject(issues) {
  const groups = new Map();

  for (const issue of issues) {
    const label = issue.projectName || "No Project";
    if (!groups.has(label)) {
      groups.set(label, {
        label,
        description: "",
        issues: [],
        sortKey: getProjectSortKey(issue)
      });
    }

    groups.get(label).issues.push(issue);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      description: `${group.issues.length} issue${group.issues.length === 1 ? "" : "s"}`
    }))
    .sort((left, right) => {
      if (left.sortKey !== right.sortKey) {
        return left.sortKey - right.sortKey;
      }

      return left.label.localeCompare(right.label);
    });
}

function getStatusSortKey(issue) {
  switch (issue.state?.type) {
    case "started":
      return 0;
    case "unstarted":
      return 1;
    case "backlog":
      return 2;
    case "completed":
      return 3;
    case "canceled":
      return 4;
    default:
      return 5;
  }
}

function getProjectSortKey(issue) {
  return issue.projectName ? 0 : 1;
}

module.exports = {
  LinearAssignedIssuesProvider
};
