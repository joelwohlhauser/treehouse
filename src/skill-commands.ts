const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const { openCodingAgentInTerminal, runCodingAgentInBackground } = require("./agent");
const { getConfig } = require("./config");

const SKILL_EXECUTION_HISTORY_KEY = "skillExecutionHistory";

async function executeAgentSkill(context, output) {
  const skillsRoot = resolveSkillsRoot();
  const executionHistory = getSkillExecutionHistory(context);
  const skills = await listSkills(skillsRoot, executionHistory);

  if (!skills.length) {
    throw new Error(`No skills found in ${skillsRoot}`);
  }

  const selection = await vscode.window.showQuickPick(
    skills.map((skill) => ({
      label: skill.commandName,
      description: `/${skill.commandName}`,
      detail: skill.skillFile,
      commandName: skill.commandName
    })),
    {
      placeHolder: "Select an agent skill to execute"
    }
  );

  if (!selection) {
    return;
  }

  output.appendLine(`Executing agent skill /${selection.commandName}`);
  if (getConfig().executeSkillsInBackground) {
    const completed = await runCodingAgentInBackground(
      `/${selection.commandName}`,
      {
        name: "Agent Skill",
        progressTitle: "Running agent skill",
        progressMessage: `/${selection.commandName}`
      },
      output
    );
    if (!completed) {
      return;
    }
  } else {
    await openCodingAgentInTerminal(`/${selection.commandName}`, {
      name: "Agent Skill"
    }, output);
  }
  await updateSkillExecutionHistory(context, selection.commandName);
}

async function listSkills(skillsRoot, executionHistory = {}) {
  const skills = [];
  await collectSkills(skillsRoot, skillsRoot, skills);

  skills.sort((left, right) => compareSkills(left, right, executionHistory));
  return skills;
}

async function collectSkills(rootPath, currentPath, skills) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(currentPath, entry.name);
    const skillFile = path.join(entryPath, "SKILL.md");

    try {
      const stat = await fs.stat(skillFile);
      if (stat.isFile()) {
        const relativePath = path.relative(rootPath, entryPath);
        skills.push({
          name: relativePath,
          commandName: relativePath.split(path.sep).join("/"),
          skillFile
        });
        continue;
      }
    } catch {
      // Continue descending into grouping folders.
    }

    await collectSkills(rootPath, entryPath, skills);
  }
}

function resolveSkillsRoot() {
  const configuredPath = String(getConfig().skillsRoot || "skills").trim();

  if (configuredPath === "~") {
    return os.homedir();
  }

  if (configuredPath.startsWith("~/")) {
    return path.join(os.homedir(), configuredPath.slice(2));
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspacePath) {
    return path.join(workspacePath, configuredPath);
  }

  return path.join(os.homedir(), configuredPath);
}

function compareSkills(left, right, executionHistory) {
  const leftLastExecutedAt = Number(executionHistory[left.commandName] || 0);
  const rightLastExecutedAt = Number(executionHistory[right.commandName] || 0);

  if (leftLastExecutedAt !== rightLastExecutedAt) {
    return rightLastExecutedAt - leftLastExecutedAt;
  }

  return left.name.localeCompare(right.name);
}

function getSkillExecutionHistory(context) {
  const value = context.globalState.get(SKILL_EXECUTION_HISTORY_KEY);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

async function updateSkillExecutionHistory(context, commandName) {
  const history = {
    ...getSkillExecutionHistory(context),
    [commandName]: Date.now()
  };
  await context.globalState.update(SKILL_EXECUTION_HISTORY_KEY, history);
}

module.exports = {
  executeAgentSkill
};
