const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const DEFAULT_LOCAL_TARGET = Object.freeze({
  id: "local",
  type: "local",
  label: "Local",
  repositoriesRoot: "~/Repositories",
  worktreesRoot: "~/Repositories/.worktrees"
});
const DEFAULT_CREATE_TARGET = "last-used";
const DEFAULT_COMMIT_MESSAGE_PROMPT = [
  "Generate the final git commit title for the current working tree.",
  "Return only the final title.",
  "",
  "Rules:",
  "- Treat the current working tree as the candidate commit. Both staged and unstaged changes will be committed together.",
  "- Write the shortest accurate title that explains why the change exists.",
  "- Prefer the user-visible or system-level outcome over implementation detail.",
  "- Use lowercase, no trailing period, and no filler words.",
  "- If the branch name includes an issue id matching [A-Za-z]+-[0-9]+, prefix the title with that issue id in lowercase followed by \": \".",
  "- Otherwise use the narrowest accurate semantic prefix: feat:, fix:, refactor:, docs:, test:, or chore:.",
  "",
  "Context:",
  "- Repository root: ${repoPath}",
  "- Branch name: ${branchName}",
  "- Branch issue id: ${branchIssueId}",
  "- Target: ${targetLabel}",
  "",
  "git status --short",
  "${gitStatus}",
  "",
  "git diff --stat",
  "${gitDiffStat}",
  "",
  "git diff",
  "${gitDiff}",
  "",
  "git diff --cached --stat",
  "${gitCachedDiffStat}",
  "",
  "git diff --cached",
  "${gitCachedDiff}",
  "",
  "untracked file diffs",
  "${untrackedDiffs}"
].join("\n");

function getConfig() {
  const config = vscode.workspace.getConfiguration("treehouse");
  const targets = normalizeTargets(config.get("targets"), {
    repositoriesRoot: config.get("repositoriesRoot") || DEFAULT_LOCAL_TARGET.repositoriesRoot,
    worktreesRoot: config.get("worktreesRoot") || DEFAULT_LOCAL_TARGET.worktreesRoot
  });

  return {
    alwaysPromptForTarget: config.get("alwaysPromptForTarget") === true,
    defaultCreateTarget: normalizeDefaultCreateTarget(config.get("defaultCreateTarget")),
    targets,
    worktreePathTemplate:
      config.get("worktreePathTemplate") || "${repo}/${branch}",
    envFileMode: config.get("envFileMode") || "link",
    installDependencies: config.get("installDependencies") !== false,
    appPreviewOpenTarget: normalizeAppPreviewOpenTarget(config.get("appPreviewOpenTarget")),
    openInNewWindow: config.get("openInNewWindow") !== false,
    codingAgentCommand: String(config.get("codingAgentCommand") || "codex").trim() || "codex",
    codexSessionsRoot: String(config.get("codexSessionsRoot") || "~/.codex/sessions").trim() || "~/.codex/sessions",
    codexSessionPollIntervalMs: normalizePositiveInteger(config.get("codexSessionPollIntervalMs"), 2500),
    openLatestCodexChatOnStartup: config.get("openLatestCodexChatOnStartup") === true,
    latestCodexChatOpenTarget: normalizeLatestCodexChatOpenTarget(config.get("latestCodexChatOpenTarget")),
    commitMessageCodexCommand:
      String(config.get("commitMessageCodexCommand") || "codex").trim() || "codex",
    commitMessagePrompt:
      String(config.get("commitMessagePrompt") || DEFAULT_COMMIT_MESSAGE_PROMPT).trim() ||
      DEFAULT_COMMIT_MESSAGE_PROMPT,
    commitMessageRequireApproval: config.get("commitMessageRequireApproval") === true,
    commitAndPushPullRequestMode: normalizeCommitAndPushPullRequestMode(
      config.get("commitAndPushPullRequestMode")
    ),
    commitAndPushRunCheckoutPullRequestByNumber:
      config.get("commitAndPushRunCheckoutPullRequestByNumber") !== false,
    skillsRoot: String(config.get("skillsRoot") || "skills").trim() || "skills",
    executeSkillsInBackground: config.get("executeSkillsInBackground") !== false,
    shellCommand: String(config.get("shellCommand") || "").trim(),
    linearApiKey: String(config.get("linearApiKey") || "").trim(),
    linearAssignedIssueFilters: normalizeStringList(config.get("linearAssignedIssueFilters")),
    linearAssignedIssuesGroupBy: normalizeAssignedIssuesGroupBy(config.get("linearAssignedIssuesGroupBy")),
    linearTeamRepositoryMap: normalizeStringMap(config.get("linearTeamRepositoryMap")),
    linearSetIssueInProgress: config.get("linearSetIssueInProgress") !== false,
    linearStartCodingAgent: config.get("linearStartCodingAgent") === true
  };
}

function normalizeLatestCodexChatOpenTarget(value) {
  const normalized = String(value || "sidebar").trim().toLowerCase();
  return normalized === "panel" ? "panel" : "sidebar";
}

function normalizeAppPreviewOpenTarget(value) {
  const normalized = String(value || "externalBrowser").trim();
  return normalized === "vscodeBrowser" ? "vscodeBrowser" : "externalBrowser";
}

async function ensureTargetConfigurationMigrated(output) {
  const config = vscode.workspace.getConfiguration("treehouse");
  const targetsInspection = config.inspect("targets");

  if (hasConfiguredValue(targetsInspection)) {
    return false;
  }

  const repositoriesRoot = config.get("repositoriesRoot") || DEFAULT_LOCAL_TARGET.repositoriesRoot;
  const worktreesRoot = config.get("worktreesRoot") || DEFAULT_LOCAL_TARGET.worktreesRoot;
  const migratedTargets = [
    {
      ...DEFAULT_LOCAL_TARGET,
      repositoriesRoot: expandHome(repositoriesRoot),
      worktreesRoot: expandHome(worktreesRoot)
    }
  ];

  await config.update("targets", migratedTargets, vscode.ConfigurationTarget.Global);

  if (output) {
    output.appendLine("Migrated Treehouse repository roots into treehouse.targets.");
  }

  await clearLegacyRootSetting(config, "repositoriesRoot");
  await clearLegacyRootSetting(config, "worktreesRoot");

  return true;
}

function getTargetById(targetId, config = getConfig()) {
  return config.targets.find((target) => target.id === targetId) || null;
}

function getTargetForSshHost(sshHost, config = getConfig()) {
  return (
    config.targets.find(
      (target) =>
        target.type === "ssh" &&
        (target.sshHost === sshHost || target.id === sshHost)
    ) || null
  );
}

function getLocalTarget(config = getConfig()) {
  return config.targets.find((target) => target.type === "local") || null;
}

function normalizeTargets(value, legacyRoots = {}) {
  const explicitTargets = Array.isArray(value) ? value : [];
  const normalizedTargets = [];
  let localTarget = null;

  for (const entry of explicitTargets) {
    const normalizedEntry = normalizeTarget(entry);
    if (!normalizedEntry) {
      continue;
    }

    if (normalizedEntry.type === "local") {
      if (!localTarget) {
        localTarget = {
          ...normalizedEntry,
          id: DEFAULT_LOCAL_TARGET.id
        };
      }
      continue;
    }

    if (normalizedTargets.some((target) => target.id === normalizedEntry.id)) {
      continue;
    }

    normalizedTargets.push(normalizedEntry);
  }

  const localRoots = {
    repositoriesRoot: expandHome(legacyRoots.repositoriesRoot || DEFAULT_LOCAL_TARGET.repositoriesRoot),
    worktreesRoot: expandHome(legacyRoots.worktreesRoot || DEFAULT_LOCAL_TARGET.worktreesRoot)
  };
  const mergedLocalTarget = {
    ...DEFAULT_LOCAL_TARGET,
    ...localRoots,
    ...(localTarget || {})
  };

  return [mergedLocalTarget, ...normalizedTargets];
}

function normalizeTarget(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const type = String(entry.type || "").trim().toLowerCase();
  if (type !== "local" && type !== "ssh") {
    return null;
  }

  const normalizedId = String(
    entry.id || (type === "local" ? DEFAULT_LOCAL_TARGET.id : entry.sshHost || entry.label || "")
  ).trim();
  if (!normalizedId) {
    return null;
  }

  const repositoriesRoot = normalizeTargetRoot(entry.repositoriesRoot, type);
  const worktreesRoot = normalizeTargetRoot(entry.worktreesRoot, type);
  if (!repositoriesRoot || !worktreesRoot) {
    return null;
  }

  const normalizedTarget = {
    id: type === "local" ? DEFAULT_LOCAL_TARGET.id : normalizedId,
    type,
    label: String(entry.label || (type === "local" ? DEFAULT_LOCAL_TARGET.label : normalizedId)).trim(),
    repositoriesRoot,
    worktreesRoot
  };

  if (type === "ssh") {
    const sshHost = String(entry.sshHost || normalizedId).trim();
    if (!sshHost) {
      return null;
    }

    normalizedTarget.sshHost = sshHost;
  }

  return normalizedTarget;
}

function normalizeDefaultCreateTarget(value) {
  const normalizedValue = String(value || DEFAULT_CREATE_TARGET).trim();
  return normalizedValue || DEFAULT_CREATE_TARGET;
}

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }

  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function normalizeTargetRoot(inputPath, targetType) {
  const value = String(inputPath || "").trim();
  if (!value) {
    return "";
  }

  return targetType === "ssh" ? value : expandHome(value);
}

function hasConfiguredValue(inspection) {
  return Boolean(
    inspection &&
      (inspection.globalValue !== undefined ||
        inspection.workspaceValue !== undefined ||
        inspection.workspaceFolderValue !== undefined)
  );
}

async function clearLegacyRootSetting(configuration, key) {
  const inspection = configuration.inspect(key);
  if (!inspection) {
    return;
  }

  if (inspection.globalValue !== undefined) {
    await configuration.update(key, undefined, vscode.ConfigurationTarget.Global);
  }

  if (inspection.workspaceValue !== undefined) {
    await configuration.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }

  if (inspection.workspaceFolderValue !== undefined && vscode.workspace.workspaceFolders?.length) {
    await configuration.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entryValue]) => key && typeof entryValue === "string" && entryValue.trim())
      .map(([key, entryValue]) => [String(key).trim(), entryValue.trim()])
  );
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeAssignedIssuesGroupBy(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (normalizedValue === "project") {
    return "project";
  }

  return "status";
}

function normalizeCommitAndPushPullRequestMode(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  if (normalizedValue === "draft") {
    return "draft";
  }

  return "ready";
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

module.exports = {
  DEFAULT_COMMIT_MESSAGE_PROMPT,
  DEFAULT_CREATE_TARGET,
  DEFAULT_LOCAL_TARGET,
  ensureTargetConfigurationMigrated,
  getConfig,
  getLocalTarget,
  getTargetById,
  getTargetForSshHost
};
