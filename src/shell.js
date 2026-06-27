const path = require("node:path");
const { spawn } = require("node:child_process");
const vscode = require("vscode");

function resolveShellCommand() {
  const configuredShell = String(
    vscode.workspace.getConfiguration("treehouse").get("shellCommand") || ""
  ).trim();
  if (configuredShell) {
    return configuredShell;
  }

  const envShell = String(process.env.SHELL || "").trim();
  if (envShell) {
    return envShell;
  }

  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }

  return "/bin/sh";
}

function getShellInvocation(command) {
  const shellCommand = resolveShellCommand();
  const shellName = path.basename(shellCommand).toLowerCase();

  if (process.platform === "win32" && (shellName === "cmd" || shellName === "cmd.exe")) {
    return {
      executable: shellCommand,
      args: ["/d", "/s", "/c", command]
    };
  }

  return {
    executable: shellCommand,
    args: ["-lc", command]
  };
}

async function runLocalShellCommand(command, cwd, output, options = {}) {
  const commandPrefix = options.label ? `[${options.label}] ` : "";
  if (output) {
    output.appendLine(`${commandPrefix}$ ${command}`);
  }

  return new Promise((resolve, reject) => {
    const shellInvocation = getShellInvocation(command);
    const child = spawn(shellInvocation.executable, shellInvocation.args, {
      cwd,
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let settled = false;

    const cleanupSignalListener = attachAbortHandler(options.signal, () => {
      cancelled = true;
      tryTerminateChildProcess(child);
    });

    const finish = (handler, value) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupSignalListener();
      handler(value);
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (output) {
        output.append(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (output) {
        output.append(text);
      }
    });

    child.on("error", (error) => {
      finish(reject, cancelled ? createCancellationError("Command cancelled.") : error);
    });
    child.on("close", (code) => {
      if (cancelled) {
        finish(reject, createCancellationError("Command cancelled."));
        return;
      }

      if (code === 0) {
        finish(resolve, stdout);
        return;
      }

      finish(reject, new Error((stderr || stdout || `Command failed with exit code ${code}: ${command}`).trim()));
    });
  });
}

function buildSshCommand(sshHost, command, cwd) {
  const remoteCommand = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
  return `ssh ${shellQuote(sshHost)} ${shellQuote(remoteCommand)}`;
}

async function runSshShellCommand(sshHost, command, cwd, output, options = {}) {
  return runLocalShellCommand(buildSshCommand(sshHost, command, cwd), undefined, output, {
    ...options,
    label: options.label || sshHost
  });
}

function buildGitCommand(args) {
  return ["git", ...args.map(shellQuote)].join(" ");
}

async function runGit(cwd, args, output, options = {}) {
  return runLocalShellCommand(buildGitCommand(args), cwd, output, options);
}

async function ensureLocalCommandAvailable(commandName, cwd, options = {}) {
  try {
    await runLocalShellCommand(`command -v ${shellQuote(commandName)}`, cwd, undefined, options);
  } catch {
    throw new Error(`Required command not found on PATH: ${commandName}`);
  }
}

async function ensureRemoteCommandAvailable(sshHost, commandName, cwd, options = {}) {
  try {
    await runSshShellCommand(sshHost, `command -v ${shellQuote(commandName)}`, cwd, undefined, options);
  } catch {
    throw new Error(`Required command not found on ${sshHost}: ${commandName}`);
  }
}

async function ensureCommandAvailable(commandName, cwd, options = {}) {
  return ensureLocalCommandAvailable(commandName, cwd, options);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function attachAbortHandler(signal, onAbort) {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted || signal.isCancellationRequested) {
    onAbort();
    return () => {};
  }

  const handleAbort = () => {
    onAbort();
  };

  if (typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", handleAbort, { once: true });
    return () => {
      signal.removeEventListener("abort", handleAbort);
    };
  }

  if (typeof signal.onCancellationRequested === "function") {
    const disposable = signal.onCancellationRequested(handleAbort);
    return () => {
      disposable?.dispose?.();
    };
  }

  return () => {};
}

function tryTerminateChildProcess(child) {
  if (!child) {
    return;
  }

  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function createCancellationError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

module.exports = {
  buildGitCommand,
  ensureCommandAvailable,
  ensureLocalCommandAvailable,
  ensureRemoteCommandAvailable,
  getShellInvocation,
  runGit,
  runLocalShellCommand,
  runShellCommand: runLocalShellCommand,
  runSshShellCommand,
  shellQuote
};
