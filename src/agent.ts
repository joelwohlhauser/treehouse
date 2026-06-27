const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const { getExecutableToken, resolveCommandForTarget } = require("./command-utils");
const { getConfig } = require("./config");
const { getShellInvocation, shellQuote } = require("./shell");
const { createTargetAdapter } = require("./target-adapters");
const { getTargetLabel, tryGetCurrentWorkspaceLocation } = require("./targets");

async function openCodingAgentInTerminal(prompt, options: any = {}, output) {
  const execution = await resolveCodingAgentExecution(prompt, options);
  const { command, cwd } = execution;

  const terminal = vscode.window.createTerminal({
    name: options.name || "Coding Agent",
    cwd: options.cwdUri || cwd,
    location: {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false
    },
    isTransient: true
  });

  if (output) {
    if (execution.fallbackFrom) {
      output.appendLine(
        `Using ${execution.primaryCommand} on ${getTargetLabel(execution.target)} instead of ${execution.fallbackFrom}.`
      );
    }
    output.appendLine(
      `Opening coding agent in a terminal editor for ${cwd} on ${getTargetLabel(execution.target)}`
    );
  }

  terminal.show(true);
  terminal.sendText(command, true);
}

async function runCodingAgentInBackground(prompt, options: any = {}, output) {
  const execution = await resolveCodingAgentExecution(prompt, options);
  const { command, cwd, trimmedPrompt } = execution;
  const progressTitle = String(options.progressTitle || "Running coding agent").trim();
  const progressMessage = String(options.progressMessage || trimmedPrompt).trim();

  if (output) {
    if (execution.fallbackFrom) {
      output.appendLine(
        `Using ${execution.primaryCommand} on ${getTargetLabel(execution.target)} instead of ${execution.fallbackFrom}.`
      );
    }
    output.appendLine(`Running coding agent in the background for ${cwd}`);
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: true
    },
    async (progress, token) => {
      if (progressMessage) {
        progress.report({ message: progressMessage });
      }

      if (execution.target.type === "local" && isCodexCommand(execution.primaryCommand)) {
        return runProcessCommandInBackground(
          buildCodexExecCommand(execution.agentCommand, trimmedPrompt),
          cwd,
          token,
          output
        );
      }

      const terminal = vscode.window.createTerminal({
        name: options.name || "Coding Agent",
        cwd: options.cwdUri || cwd,
        location: vscode.TerminalLocation.Panel,
        isTransient: true
      });

      return runTerminalCommandInBackground(terminal, `${command}; exit`, token, output);
    }
  );
}

async function runTerminalCommandInBackground(terminal, command, token, output) {
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal !== terminal) {
        return;
      }

      disposable.dispose();
      cancellationDisposable.dispose();

      if (cancelled) {
        resolve(false);
        return;
      }

      const exitCode = closedTerminal.exitStatus?.code;
      if (typeof exitCode === "number" && exitCode !== 0) {
        reject(new Error(`Coding agent exited with code ${exitCode}.`));
        return;
      }

      resolve(true);
    });
    const cancellationDisposable = token.onCancellationRequested(() => {
      cancelled = true;
      if (output) {
        output.appendLine("Cancelled running coding agent.");
      }
      terminal.dispose();
    });

    terminal.sendText(command, true);
  });
}

async function resolveCodingAgentExecution(prompt, options: any = {}) {
  const trimmedPrompt = String(prompt || "").trim();
  if (!trimmedPrompt) {
    throw new Error("Coding agent prompt cannot be empty.");
  }

  const agentCommand = String(options.agentCommand || getConfig().codingAgentCommand || "codex").trim();
  if (!agentCommand) {
    throw new Error("treehouse.codingAgentCommand cannot be empty.");
  }

  const workspaceLocation = tryGetCurrentWorkspaceLocation();
  const executionTarget = options.target || workspaceLocation?.target || { type: "local", label: "Local" };
  const cwd = options.cwd || workspaceLocation?.workspacePath || os.homedir();
  const adapter = createTargetAdapter(executionTarget);
  const resolvedAgentCommand = await resolveCommandForTarget(adapter, agentCommand, cwd, {
    settingName: "treehouse.codingAgentCommand"
  });

  return {
    agentCommand: resolvedAgentCommand.command,
    cwd,
    fallbackFrom: resolvedAgentCommand.fallbackFrom,
    target: executionTarget,
    primaryCommand: resolvedAgentCommand.primaryCommand,
    trimmedPrompt,
    command: `${resolvedAgentCommand.command} ${shellQuote(trimmedPrompt)}`
  };
}

function isCodexCommand(commandName) {
  const normalizedCommand = path.basename(String(commandName || "").trim()).toLowerCase();
  return normalizedCommand === "codex";
}

function buildCodexExecCommand(agentCommand, prompt) {
  const executableToken = getExecutableToken(agentCommand);
  const trailingArgs = String(agentCommand || "").trim().slice(executableToken.length).trim();
  const parts = [executableToken, "exec"];

  if (trailingArgs) {
    parts.push(trailingArgs);
  }

  parts.push("--skip-git-repo-check", shellQuote(prompt));
  return parts.join(" ");
}

async function runProcessCommandInBackground(command, cwd, token, output) {
  return new Promise((resolve, reject) => {
    const shellInvocation = getShellInvocation(command);
    const child = spawn(shellInvocation.executable, shellInvocation.args, {
      cwd,
      detached: true
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    const cancellationDisposable = token.onCancellationRequested(() => {
      cancelled = true;
      if (output) {
        output.appendLine("Cancelled running coding agent.");
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    });

    const appendOutput = (chunk) => {
      const text = chunk.toString();
      if (output) {
        output.append(text);
      }
      return text;
    };

    child.stdout.on("data", (chunk) => {
      stdout += appendOutput(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += appendOutput(chunk);
    });

    child.on("error", (error) => {
      cancellationDisposable.dispose();
      reject(error);
    });

    child.on("close", (code) => {
      cancellationDisposable.dispose();

      if (cancelled) {
        resolve(false);
        return;
      }

      if (code === 0) {
        resolve(true);
        return;
      }

      reject(new Error((stderr || stdout || `Command failed with exit code ${code}: ${command}`).trim()));
    });
  });
}

module.exports = {
  openCodingAgentInTerminal,
  runCodingAgentInBackground
};
