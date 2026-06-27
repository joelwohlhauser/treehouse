const path = require("node:path");

function parseCommandPrefix(commandPrefix, settingName = "command") {
  const trimmed = String(commandPrefix || "").trim();
  const firstToken = trimmed.match(/^"([^"]+)"|'([^']+)'|(\S+)/);
  const executable = firstToken?.[1] || firstToken?.[2] || firstToken?.[3] || "";
  const token = firstToken?.[0] || "";

  if (!executable) {
    throw new Error(`${settingName} must start with an executable command.`);
  }

  return {
    command: trimmed,
    executable,
    token,
    trailingArgs: trimmed.slice(token.length).trim()
  };
}

function getExecutableToken(commandPrefix, settingName = "command") {
  return parseCommandPrefix(commandPrefix, settingName).token;
}

async function resolveCommandForTarget(adapter, commandPrefix, cwd, options = {}) {
  const settingName = options.settingName || "command";
  const parsed = parseCommandPrefix(commandPrefix, settingName);
  const commandOptions = { ...options };
  delete commandOptions.settingName;

  try {
    await adapter.ensureCommandAvailable(parsed.executable, cwd, commandOptions);
    return {
      command: parsed.command,
      primaryCommand: parsed.executable
    };
  } catch (error) {
    if (isCancellationError(error) || isSignalCancelled(commandOptions.signal)) {
      throw error;
    }

    const fallbackExecutable = getPathFallbackExecutable(parsed.executable);
    if (!fallbackExecutable) {
      throw error;
    }

    try {
      await adapter.ensureCommandAvailable(fallbackExecutable, cwd, commandOptions);
      return {
        command: buildCommandPrefix(fallbackExecutable, parsed.trailingArgs),
        fallbackFrom: parsed.executable,
        primaryCommand: fallbackExecutable
      };
    } catch {
      throw error;
    }
  }
}

function getPathFallbackExecutable(executable) {
  if (!looksLikePath(executable)) {
    return "";
  }

  const normalizedExecutable = String(executable || "").replace(/\\/g, "/");
  const basename = path.posix.basename(normalizedExecutable);
  return basename && basename !== executable ? basename : "";
}

function looksLikePath(value) {
  return /[\\/]/.test(String(value || ""));
}

function buildCommandPrefix(executable, trailingArgs) {
  return [quoteCommandToken(executable), String(trailingArgs || "").trim()].filter(Boolean).join(" ");
}

function quoteCommandToken(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) {
    return text;
  }

  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function isCancellationError(error) {
  return error?.name === "AbortError";
}

function isSignalCancelled(signal) {
  return Boolean(signal?.aborted || signal?.isCancellationRequested);
}

module.exports = {
  getExecutableToken,
  resolveCommandForTarget
};
