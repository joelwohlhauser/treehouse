const vscode = require("vscode");

const { openUrlInEditor } = require("./browser");
const { getOrConfigureLinearApiKey } = require("./linear-auth");
const { fetchLinearIssue, fetchLinearIssueUrl } = require("./linear");

const LINEAR_ISSUE_DOCUMENT_SCHEME = "treehouse-linear-issue";

class LinearIssueDocumentProvider {
  [key: string]: any;

  constructor() {
    this.documents = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  provideTextDocumentContent(uri) {
    return this.documents.get(uri.toString()) || "# Linear issue unavailable";
  }

  updateDocument(uri, content) {
    this.documents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }
}

async function openLinearIssueDetails(documentProvider, issue) {
  if (!issue?.identifier) {
    throw new Error("Select a Linear issue from the Treehouse sidebar first.");
  }

  const apiKey = await getOrConfigureLinearApiKey();
  if (!apiKey) {
    return;
  }

  const fullIssue = await fetchLinearIssue(issue.identifier, apiKey);
  const browserOpened = await tryOpenLinearIssueWebsite(fullIssue.identifier, apiKey);
  if (browserOpened) {
    return;
  }

  const uri = vscode.Uri.parse(`${LINEAR_ISSUE_DOCUMENT_SCHEME}:/${fullIssue.identifier}.md`);
  documentProvider.updateDocument(uri, formatIssueDetailsDocument(fullIssue));
  await vscode.workspace.openTextDocument(uri);
  await vscode.commands.executeCommand("markdown.showPreview", uri);
}

async function tryOpenLinearIssueWebsite(issueIdentifier, apiKey) {
  let url = "";

  try {
    url = await fetchLinearIssueUrl(issueIdentifier, apiKey);
  } catch {
    return false;
  }

  if (!url) {
    return false;
  }

  try {
    await openUrlInEditor(url);
    return true;
  } catch {
    return false;
  }
}

function formatIssueDetailsDocument(issue) {
  const metadata = [
    ["Status", issue.state?.name || "Unknown"],
    ["Team", issue.teamKey || issue.teamName || "Unknown"],
    ["Project", issue.projectName || "None"],
    ["Labels", issue.labels.length ? issue.labels.join(", ") : "None"],
    ["Branch", issue.branchName || "None"],
    ["Updated", formatDate(issue.updatedAt)]
  ];

  const lines = [`# ${issue.identifier}: ${issue.title}`, ""];
  for (const [label, value] of metadata) {
    lines.push(`- ${label}: ${value}`);
  }

  lines.push("", "## Description", "");
  lines.push(issue.description ? issue.description.trim() : "_No description._");
  lines.push("");

  return lines.join("\n");
}

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

module.exports = {
  LINEAR_ISSUE_DOCUMENT_SCHEME,
  LinearIssueDocumentProvider,
  openLinearIssueDetails
};
