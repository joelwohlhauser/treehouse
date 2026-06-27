const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const { getConfig, getLocalTarget } = require("./config");
const { createTargetAdapter } = require("./target-adapters");
const { getTargetLabel, tryGetCurrentWorkspaceLocation } = require("./targets");
const { runLocalShellCommand } = require("./shell");

async function listRunningDevServers() {
  const scanTarget = getCurrentDevServerScanTarget();
  const rawOutput =
    scanTarget.target.type === "ssh"
      ? await scanRemoteDevServers(scanTarget)
      : await scanLocalDevServers(scanTarget);

  return {
    target: scanTarget,
    servers: parseDevServerRows(rawOutput, scanTarget)
  };
}

function getCurrentDevServerScanTarget(config = getConfig()) {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri || null;
  const location = tryGetCurrentWorkspaceLocation(config);
  if (location?.target) {
    return {
      cwd: location.workspacePath,
      label: getTargetLabel(location.target),
      target: location.target,
      workspaceUri: location.workspaceUri
    };
  }

  if (workspaceUri?.scheme === "vscode-remote") {
    const sshHost = getSshHostFromRemoteWorkspaceUri(workspaceUri);
    if (!sshHost) {
      throw new Error("Treehouse could not determine the SSH host for the current remote workspace.");
    }

    const target = {
      id: sshHost,
      label: sshHost,
      repositoriesRoot: "",
      sshHost,
      type: "ssh",
      worktreesRoot: ""
    };
    return {
      cwd: workspaceUri.path || os.homedir(),
      label: getTargetLabel(target),
      target,
      workspaceUri
    };
  }

  if (!workspaceUri || workspaceUri.scheme === "file") {
    const localTarget = getLocalTarget(config);
    if (!localTarget) {
      throw new Error("No local Treehouse target is configured.");
    }

    return {
      cwd: workspaceUri?.fsPath || os.homedir(),
      label: getTargetLabel(localTarget),
      target: localTarget,
      workspaceUri
    };
  }

  throw new Error(`Treehouse does not support dev-server scanning for ${workspaceUri.scheme} workspaces.`);
}

async function scanLocalDevServers(scanTarget) {
  return runLocalShellCommand(buildDevServerScanScript(), scanTarget.cwd);
}

async function scanRemoteDevServers(scanTarget) {
  const adapter = createTargetAdapter(scanTarget.target);
  return adapter.runCommand(buildDevServerScanScript(), scanTarget.cwd);
}

function parseDevServerRows(rawOutput, scanTarget) {
  const serversByKey = new Map();

  for (const line of String(rawOutput || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const [portValue, pidValue, cwd = "", command = ""] = line.split("\t");
    const port = Number(portValue);
    const pid = Number(pidValue);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      continue;
    }

    const key = `${port}:${Number.isInteger(pid) ? pid : "unknown"}:${command}`;
    if (serversByKey.has(key)) {
      continue;
    }

    serversByKey.set(key, {
      command: command.trim(),
      cwd: cwd.trim(),
      pid: Number.isInteger(pid) ? pid : undefined,
      port,
      processName: getProcessName(command),
      target: scanTarget.target,
      targetLabel: scanTarget.label,
      targetType: scanTarget.target.type
    });
  }

  return Array.from(serversByKey.values()).sort((left, right) => {
    if (left.port !== right.port) {
      return left.port - right.port;
    }

    return (left.pid || 0) - (right.pid || 0);
  });
}

function getProcessName(command) {
  const firstToken = String(command || "").trim().split(/\s+/)[0] || "";
  if (!firstToken) {
    return "";
  }

  return path.basename(firstToken);
}

function getSshHostFromRemoteWorkspaceUri(workspaceUri) {
  const match = /^ssh-remote\+(.+)$/.exec(workspaceUri.authority || "");
  return match?.[1] || "";
}

function buildDevServerScanScript() {
  return `
sanitize_field() {
  printf '%s' "$1" | tr '\\t\\r\\n' '   '
}

extract_port() {
  printf '%s\\n' "$1" | sed -nE 's/.*:([0-9]+)([^0-9].*)?$/\\1/p' | head -n 1
}

get_process_command() {
  ps -ww -p "$1" -o command= 2>/dev/null || ps -p "$1" -o command= 2>/dev/null || true
}

get_process_cwd() {
  if [ -e "/proc/$1/cwd" ]; then
    readlink -f "/proc/$1/cwd" 2>/dev/null || readlink "/proc/$1/cwd" 2>/dev/null || true
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
  fi
}

matches_dev_server_command() {
  command_line=" $1 "
  case "$command_line" in
    *" pnpm dev "*|*" pnpm run dev "*|*" npm run dev "*|*" yarn dev "*|*" yarn run dev "*|*" bun dev "*|*" bun run dev "*)
      return 0
      ;;
    *" vite "*|*" next dev "*|*" astro dev "*|*" nuxt dev "*|*" remix dev "*|*" webpack serve "*|*" react-scripts start "*)
      return 0
      ;;
    *" svelte-kit dev "*|*" ng serve "*|*" vue-cli-service serve "*|*" fastapi dev "*|*" flask run "*)
      return 0
      ;;
    *" django-admin runserver "*|*" manage.py runserver "*|*" rails server "*|*" rails s "*|*" bin/rails server "*)
      return 0
      ;;
    *"/node_modules/.bin/vite "*|*"/node_modules/vite/"*|*"/node_modules/.bin/next "*|*"/node_modules/next/"*)
      return 0
      ;;
    *"/node_modules/.bin/astro "*|*"/node_modules/astro/"*|*"/node_modules/.bin/nuxt "*|*"/node_modules/nuxt/"*)
      return 0
      ;;
    *"/node_modules/.bin/remix "*|*"/node_modules/@remix-run/"*|*"/node_modules/.bin/webpack-dev-server "*)
      return 0
      ;;
  esac

  return 1
}

is_runtime_process() {
  command_line=" $1 "
  case "$command_line" in
    *" node "*|*"/node "*|*" nodejs "*|*"/nodejs "*|*" bun "*|*"/bun "*|*" deno "*|*"/deno "*)
      return 0
      ;;
    *" tsx "*|*"/tsx "*|*" ruby "*|*"/ruby "*|*" python "*|*"/python "*|*" python3 "*|*"/python3 "*)
      return 0
      ;;
    *" go run "*|*"/go run "*|*" cargo run "*|*"/cargo run "*)
      return 0
      ;;
  esac

  return 1
}

is_dev_port() {
  case "$1" in
    3???|4???|5???|6???|7???|8???|9???)
      return 0
      ;;
  esac

  return 1
}

print_if_dev_server() {
  pid="$1"
  port="$2"

  case "$pid" in
    ''|*[!0-9]*)
      return
      ;;
  esac
  case "$port" in
    ''|*[!0-9]*)
      return
      ;;
  esac

  command_line=$(get_process_command "$pid")
  [ -n "$command_line" ] || return

  if ! matches_dev_server_command "$command_line"; then
    if ! is_dev_port "$port" || ! is_runtime_process "$command_line"; then
      return
    fi
  fi

  cwd=$(get_process_cwd "$pid")
  printf '%s\\t%s\\t%s\\t%s\\n' "$port" "$pid" "$(sanitize_field "$cwd")" "$(sanitize_field "$command_line")"
}

scan_lsof() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof_output=$(lsof -nP -iTCP -sTCP:LISTEN -Fpn 2>/dev/null || true)
  [ -n "$lsof_output" ] || return 1

  current_pid=
  printf '%s\\n' "$lsof_output" | while IFS= read -r line; do
    case "$line" in
      p*)
        current_pid=\${line#p}
        ;;
      n*)
        port=$(extract_port "\${line#n}")
        print_if_dev_server "$current_pid" "$port"
        ;;
    esac
  done
}

scan_ss() {
  command -v ss >/dev/null 2>&1 || return 1
  ss_output=$(ss -ltnpH 2>/dev/null || true)
  [ -n "$ss_output" ] || return 1

  printf '%s\\n' "$ss_output" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    local_address=$(printf '%s\\n' "$line" | awk '{print $4}')
    port=$(extract_port "$local_address")
    [ -n "$port" ] || continue

    pids=$(printf '%s\\n' "$line" | grep -o 'pid=[0-9]\\+' | cut -d= -f2 | awk '!seen[$0]++')
    [ -n "$pids" ] || continue

    for pid in $pids; do
      print_if_dev_server "$pid" "$port"
    done
  done
}

if command -v lsof >/dev/null 2>&1 || command -v ss >/dev/null 2>&1; then
  scan_lsof || scan_ss || true
else
  printf '%s\\n' 'Treehouse needs lsof or ss to scan dev servers on this machine.' >&2
  exit 1
fi
`;
}

module.exports = {
  getCurrentDevServerScanTarget,
  listRunningDevServers
};
