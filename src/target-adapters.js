const fs = require("node:fs/promises");
const path = require("node:path");

const {
  buildGitCommand,
  ensureLocalCommandAvailable,
  ensureRemoteCommandAvailable,
  runLocalShellCommand,
  runSshShellCommand,
  shellQuote
} = require("./shell");
const { getTargetLabel, getTargetPathModule, isRunningOnCurrentSshTarget } = require("./targets");

const ENV_SEARCH_SKIP_ENTRIES = new Set([".git", ".next", ".turbo", "dist", "build", "coverage", "node_modules"]);

class BaseTargetAdapter {
  constructor(target) {
    this.target = target;
    this.path = getTargetPathModule(target);
  }

  getTargetLabel() {
    return getTargetLabel(this.target);
  }

  async ensureCommandAvailable(commandName, cwd, options = {}) {
    if (this.target.type === "ssh") {
      return ensureRemoteCommandAvailable(this.target.sshHost, commandName, cwd, options);
    }

    return ensureLocalCommandAvailable(commandName, cwd, options);
  }

  async runGit(cwd, args, output, options = {}) {
    return this.runCommand(buildGitCommand(args), cwd, output, options);
  }

  async getRepoOrigin(repoPath) {
    try {
      return (await this.runGit(repoPath, ["config", "--get", "remote.origin.url"])).trim();
    } catch {
      return "";
    }
  }

  buildRepoDescriptor(repoName, repoPath, modifiedAt, originUrl) {
    return {
      target: this.target,
      targetId: this.target.id,
      targetType: this.target.type,
      targetLabel: this.getTargetLabel(),
      repoName,
      repoPath,
      originUrl,
      normalizedOrigin: normalizeRepositoryOrigin(originUrl),
      modifiedAt: Number(modifiedAt || 0)
    };
  }
}

class LocalTargetAdapter extends BaseTargetAdapter {
  async ensureRoots() {
    await fs.mkdir(this.target.repositoriesRoot, { recursive: true });
    await fs.mkdir(this.target.worktreesRoot, { recursive: true });
  }

  async listPrimaryRepos() {
    let entries = [];
    try {
      entries = await fs.readdir(this.target.repositoriesRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const repos = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const repoPath = path.join(this.target.repositoriesRoot, entry.name);
      const gitPath = path.join(repoPath, ".git");
      try {
        await fs.lstat(gitPath);
      } catch {
        continue;
      }

      const modifiedAt = await getLocalRepoModifiedAt(repoPath, gitPath);
      repos.push(this.buildRepoDescriptor(entry.name, repoPath, modifiedAt, ""));
    }

    repos.sort((left, right) => right.modifiedAt - left.modifiedAt);
    return repos;
  }

  async cloneRepository(cloneUrl, output) {
    await this.ensureRoots();
    await this.ensureCommandAvailable("git", this.target.repositoriesRoot);

    const repoName = inferRepoNameFromCloneUrl(cloneUrl);
    if (!repoName) {
      throw new Error(`Unable to determine repository name from clone URL: ${cloneUrl}`);
    }

    const repoPath = this.path.join(this.target.repositoriesRoot, repoName);
    if (await this.pathExists(repoPath)) {
      await this.runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
      const originUrl = await this.getRepoOrigin(repoPath);
      return this.buildRepoDescriptor(repoName, repoPath, Date.now(), originUrl);
    }

    await this.runCommand(`git clone ${shellQuote(cloneUrl)}`, this.target.repositoriesRoot, output);
    const originUrl = await this.getRepoOrigin(repoPath);
    return this.buildRepoDescriptor(repoName, repoPath, Date.now(), originUrl);
  }

  async runCommand(command, cwd, output, options = {}) {
    return runLocalShellCommand(command, cwd, output, {
      ...options,
      label: this.getTargetLabel()
    });
  }

  async ensureDirectoryExists(targetPath) {
    await fs.mkdir(targetPath, { recursive: true });
  }

  async pathExists(targetPath) {
    try {
      await fs.stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async pruneEmptyParentDirectories(startPath, stopPath) {
    let currentPath = path.dirname(startPath);

    while (currentPath !== stopPath && currentPath !== path.parse(currentPath).root) {
      try {
        await fs.rmdir(currentPath);
      } catch {
        break;
      }

      currentPath = path.dirname(currentPath);
    }
  }

  async linkOrCopyEnv(repoPath, worktreePath, envFileMode, output) {
    if (envFileMode === "off") {
      return;
    }

    const envFiles = await collectLocalEnvFiles(repoPath);
    if (envFiles.length === 0) {
      output?.appendLine(`No .env files found in base repo on ${this.getTargetLabel()}, skipping link.`);
      return;
    }

    for (const sourceEnv of envFiles) {
      const relativeEnvPath = path.relative(repoPath, sourceEnv);
      if (!relativeEnvPath || relativeEnvPath.startsWith("..") || path.isAbsolute(relativeEnvPath)) {
        continue;
      }

      const worktreeEnv = path.join(worktreePath, relativeEnvPath);
      try {
        await fs.lstat(worktreeEnv);
        output?.appendLine(`Worktree already has ${relativeEnvPath}, skipping link.`);
        continue;
      } catch {}

      await fs.mkdir(path.dirname(worktreeEnv), { recursive: true });
      const sourceStat = await fs.lstat(sourceEnv);
      if (envFileMode === "copy" && sourceStat.isFile()) {
        output?.appendLine(`Copying ${relativeEnvPath} from ${sourceEnv}`);
        await fs.copyFile(sourceEnv, worktreeEnv);
        continue;
      }

      output?.appendLine(`Linking ${relativeEnvPath} from ${sourceEnv}`);
      await fs.symlink(sourceEnv, worktreeEnv);
    }
  }
}

class SshTargetAdapter extends BaseTargetAdapter {
  constructor(target) {
    super(target);
    this.resolvedTargetPromise = null;
  }

  async ensureResolvedTarget() {
    if (!this.resolvedTargetPromise) {
      this.resolvedTargetPromise = this.resolveTargetRoots();
    }

    return this.resolvedTargetPromise;
  }

  async resolveTargetRoots() {
    const [repositoriesRoot, worktreesRoot] = await this.resolveRemotePaths([
      this.target.repositoriesRoot,
      this.target.worktreesRoot
    ]);
    this.target = {
      ...this.target,
      repositoriesRoot,
      worktreesRoot
    };
    this.path = getTargetPathModule(this.target);
    return this.target;
  }

  async resolveRemotePaths(targetPaths) {
    const output = await this.runCommand(buildRemoteResolvePathsCommand(targetPaths));
    const lines = output.replace(/\r/g, "").split("\n");
    return targetPaths.map((_, index) => normalizeResolvedRemotePath(lines[index] || ""));
  }

  async ensureRoots() {
    const target = await this.ensureResolvedTarget();
    await this.runCommand(
      `mkdir -p ${shellQuote(target.repositoriesRoot)} ${shellQuote(target.worktreesRoot)}`
    );
  }

  async listPrimaryRepos() {
    const target = await this.ensureResolvedTarget();
    const output = await this.runCommand(buildRemoteListReposCommand(target.repositoriesRoot));
    const repos = [];

    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const [repoName, repoPath, modifiedAt] = line.split("\t");
      if (!repoName || !repoPath) {
        continue;
      }

      repos.push(this.buildRepoDescriptor(repoName, repoPath, Number(modifiedAt || 0), ""));
    }

    repos.sort((left, right) => right.modifiedAt - left.modifiedAt);
    return repos;
  }

  async cloneRepository(cloneUrl, output) {
    const target = await this.ensureResolvedTarget();
    await this.ensureRoots();
    await this.ensureCommandAvailable("git", target.repositoriesRoot);

    const repoName = inferRepoNameFromCloneUrl(cloneUrl);
    if (!repoName) {
      throw new Error(`Unable to determine repository name from clone URL: ${cloneUrl}`);
    }

    const repoPath = this.path.join(target.repositoriesRoot, repoName);
    if (await this.pathExists(repoPath)) {
      await this.runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
      const originUrl = await this.getRepoOrigin(repoPath);
      return this.buildRepoDescriptor(repoName, repoPath, Date.now(), originUrl);
    }

    await this.runCommand(
      `git clone ${shellQuote(cloneUrl)} ${shellQuote(repoPath)}`,
      undefined,
      output
    );
    const originUrl = await this.getRepoOrigin(repoPath);
    return this.buildRepoDescriptor(repoName, repoPath, Date.now(), originUrl);
  }

  async runCommand(command, cwd, output, options = {}) {
    if (isRunningOnCurrentSshTarget(this.target)) {
      return runLocalShellCommand(command, cwd, output, {
        ...options,
        label: options.label || this.getTargetLabel()
      });
    }

    return runSshShellCommand(this.target.sshHost, command, cwd, output, {
      ...options,
      label: this.getTargetLabel()
    });
  }

  async ensureCommandAvailable(commandName, cwd, options = {}) {
    if (isRunningOnCurrentSshTarget(this.target)) {
      return ensureLocalCommandAvailable(commandName, cwd, options);
    }

    return ensureRemoteCommandAvailable(this.target.sshHost, commandName, cwd, options);
  }

  async ensureDirectoryExists(targetPath) {
    await this.runCommand(`mkdir -p ${shellQuote(targetPath)}`);
  }

  async pathExists(targetPath) {
    try {
      await this.runCommand(`test -e ${shellQuote(targetPath)}`);
      return true;
    } catch {
      return false;
    }
  }

  async pruneEmptyParentDirectories(startPath, stopPath) {
    const command = `
current_path=${shellQuote(this.path.dirname(startPath))}
stop_path=${shellQuote(stopPath)}
root_path=/
while [ "$current_path" != "$stop_path" ] && [ "$current_path" != "$root_path" ]; do
  rmdir "$current_path" 2>/dev/null || break
  current_path=$(dirname "$current_path")
done
`;
    await this.runCommand(command);
  }

  async linkOrCopyEnv(repoPath, worktreePath, envFileMode, output) {
    if (envFileMode === "off") {
      return;
    }

    const command = buildRemoteLinkOrCopyEnvCommand(repoPath, worktreePath, envFileMode, this.getTargetLabel());
    await this.runCommand(command, undefined, output);
  }
}

function createTargetAdapter(target) {
  if (target.type === "ssh") {
    return new SshTargetAdapter(target);
  }

  return new LocalTargetAdapter(target);
}

async function collectLocalEnvFiles(repoPath) {
  const envFiles = new Set();
  await collectLocalEnvFilesInTree(repoPath, 0, envFiles);

  for (const workspaceRoot of ["apps", "packages"]) {
    await collectLocalEnvFilesInTree(path.join(repoPath, workspaceRoot), 4, envFiles);
  }

  return Array.from(envFiles).sort((left, right) => {
    return path.relative(repoPath, left).localeCompare(path.relative(repoPath, right));
  });
}

async function collectLocalEnvFilesInTree(currentPath, depthRemaining, envFiles) {
  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (shouldSkipEnvSearchEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(currentPath, entry.name);
    if (!entry.isDirectory() && isEnvironmentFileName(entry.name)) {
      envFiles.add(entryPath);
      continue;
    }

    if (entry.isDirectory() && depthRemaining > 0) {
      await collectLocalEnvFilesInTree(entryPath, depthRemaining - 1, envFiles);
    }
  }
}

function shouldSkipEnvSearchEntry(entryName) {
  return ENV_SEARCH_SKIP_ENTRIES.has(entryName);
}

function isEnvironmentFileName(fileName) {
  return (fileName === ".env" || fileName.startsWith(".env.")) && !fileName.endsWith(".example");
}

async function resolveTargetRootPaths(target) {
  if (target?.type !== "ssh") {
    return target;
  }

  const adapter = new SshTargetAdapter(target);
  return adapter.ensureResolvedTarget();
}

async function resolveTargetPath(target, targetPath) {
  if (target?.type !== "ssh") {
    return targetPath;
  }

  const adapter = new SshTargetAdapter(target);
  const [resolvedPath] = await adapter.resolveRemotePaths([targetPath]);
  return resolvedPath;
}

async function listBranches(adapter, repoPath) {
  const output = await adapter.runGit(repoPath, [
    "for-each-ref",
    "--format=%(refname)|%(upstream:short)|%(committerdate:unix)",
    "--sort=-committerdate",
    "refs/heads",
    "refs/remotes/origin"
  ]);
  const seen = new Set();
  const branches = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const [refName, upstreamName] = line.split("|");
    if (refName === "refs/remotes/origin/HEAD") {
      continue;
    }

    const isRemote = refName.startsWith("refs/remotes/origin/");
    const name = isRemote
      ? refName.slice("refs/remotes/origin/".length)
      : refName.slice("refs/heads/".length);

    if (seen.has(name)) {
      continue;
    }

    seen.add(name);
    branches.push({
      name,
      scope: isRemote ? "remote" : "local",
      remoteName: upstreamName || (isRemote ? `origin/${name}` : "")
    });
  }

  return branches;
}

async function listWorktrees(adapter, repoPath) {
  const output = await adapter.runGit(repoPath, ["worktree", "list", "--porcelain"]);
  const lines = output.split(/\r?\n/);
  const worktrees = [];
  let currentWorktree = null;

  for (const line of lines) {
    if (!line) {
      if (currentWorktree) {
        worktrees.push(currentWorktree);
        currentWorktree = null;
      }
      continue;
    }

    if (line.startsWith("worktree ")) {
      currentWorktree = {
        path: line.slice("worktree ".length),
        branch: "",
        isMain: worktrees.length === 0
      };
      continue;
    }

    if (currentWorktree && line.startsWith("branch refs/heads/")) {
      currentWorktree.branch = line.slice("branch refs/heads/".length);
    }
  }

  if (currentWorktree) {
    worktrees.push(currentWorktree);
  }

  return worktrees;
}

async function findExistingWorktree(adapter, repoPath, branchName) {
  const worktrees = await listWorktrees(adapter, repoPath);

  for (const worktree of worktrees) {
    if (worktree.branch === branchName) {
      return worktree.path;
    }
  }

  return "";
}

async function createWorktreeFromBranch(adapter, repoPath, branchName, worktreePath, output) {
  await adapter.ensureDirectoryExists(adapter.path.dirname(worktreePath));

  const remoteBranchExists = await branchExistsOnOrigin(adapter, repoPath, branchName);
  if (remoteBranchExists) {
    output?.appendLine(`Fetching latest origin/${branchName} on ${adapter.getTargetLabel()}`);
    await fetchBranchFromOrigin(adapter, repoPath, branchName, output);
  }

  if (await branchExistsLocally(adapter, repoPath, branchName)) {
    if (remoteBranchExists) {
      await ensureBranchTracksOrigin(adapter, repoPath, branchName, output);
      await fastForwardLocalBranchIfPossible(adapter, repoPath, branchName, output);
    }

    await adapter.runGit(repoPath, ["worktree", "add", worktreePath, branchName], output);
    return;
  }

  if (remoteBranchExists) {
    output?.appendLine(`Fetching latest origin/${branchName} on ${adapter.getTargetLabel()}`);
    const remoteBranchHead = await fetchBranchHeadFromOrigin(adapter, repoPath, branchName, output);
    await adapter.runGit(repoPath, ["branch", branchName, remoteBranchHead], output);
    await ensureBranchTracksOrigin(adapter, repoPath, branchName, output);
    await adapter.runGit(repoPath, ["worktree", "add", worktreePath, branchName], output);
    return;
  }

  const originDefaultBranch = await getOriginDefaultBranchName(adapter, repoPath);
  output?.appendLine(`Fetching latest origin/${originDefaultBranch} on ${adapter.getTargetLabel()}`);
  const defaultBranchHead = await fetchBranchHeadFromOrigin(adapter, repoPath, originDefaultBranch, output);
  await adapter.runGit(
    repoPath,
    ["worktree", "add", "-b", branchName, worktreePath, defaultBranchHead],
    output
  );
}

async function branchExistsLocally(adapter, repoPath, branchName) {
  try {
    await adapter.runGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

async function branchExistsOnOrigin(adapter, repoPath, branchName, options = {}) {
  try {
    await adapter.runGit(repoPath, ["ls-remote", "--exit-code", "--heads", "origin", branchName], undefined, options);
    return true;
  } catch {
    return false;
  }
}

async function fetchBranchFromOrigin(adapter, repoPath, branchName, output) {
  await adapter.runGit(
    repoPath,
    ["fetch", "origin", `refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
    output
  );
}

async function fetchBranchHeadFromOrigin(adapter, repoPath, branchName, output) {
  await adapter.runGit(repoPath, ["fetch", "--no-tags", "origin", `refs/heads/${branchName}`], output);
  return (await adapter.runGit(repoPath, ["rev-parse", "FETCH_HEAD"])).trim();
}

async function getOriginDefaultBranchName(adapter, repoPath) {
  try {
    const output = await adapter.runGit(repoPath, ["ls-remote", "--symref", "origin", "HEAD"]);
    const match = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match?.[1]) {
      return match[1];
    }
  } catch {}

  for (const candidate of ["main", "master"]) {
    if (await branchExistsOnOrigin(adapter, repoPath, candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to determine the default branch on origin.");
}

async function ensureBranchTracksOrigin(adapter, repoPath, branchName, output) {
  await adapter.runGit(
    repoPath,
    ["branch", "--set-upstream-to", `origin/${branchName}`, branchName],
    output
  );
}

async function unsetBranchUpstream(adapter, repoPath, branchName) {
  try {
    await adapter.runGit(repoPath, ["branch", "--unset-upstream", branchName]);
  } catch {}
}

async function fastForwardLocalBranchIfPossible(adapter, repoPath, branchName, output) {
  const localSha = (await adapter.runGit(repoPath, ["rev-parse", `refs/heads/${branchName}`])).trim();
  const remoteSha = (await adapter.runGit(repoPath, ["rev-parse", `refs/remotes/origin/${branchName}`])).trim();

  if (localSha === remoteSha) {
    return;
  }

  try {
    await adapter.runGit(repoPath, ["merge-base", "--is-ancestor", localSha, remoteSha]);
    output?.appendLine(`Fast-forwarding local ${branchName} to origin/${branchName}`);
    await adapter.runGit(repoPath, ["update-ref", `refs/heads/${branchName}`, remoteSha, localSha], output);
  } catch {
    output?.appendLine(
      `Local branch ${branchName} has diverged from origin/${branchName}. Leaving it as-is.`
    );
  }
}

async function getMainWorktree(adapter, repoPath) {
  const output = await adapter.runGit(repoPath, ["worktree", "list", "--porcelain"]);
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("worktree "));
  if (!line) {
    throw new Error("Unable to resolve the main worktree.");
  }

  return line.slice("worktree ".length);
}

async function getCurrentBranchName(adapter, repoPath, options = {}) {
  try {
    return (await adapter.runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], undefined, options)).trim();
  } catch {
    return "";
  }
}

function inferRepoNameFromCloneUrl(cloneUrl) {
  const trimmed = String(cloneUrl || "").trim().replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const lastColon = trimmed.lastIndexOf(":");
  const splitIndex = Math.max(lastSlash, lastColon);
  const rawName = splitIndex >= 0 ? trimmed.slice(splitIndex + 1) : trimmed;
  return rawName.replace(/\.git$/i, "");
}

function isLikelyCloneUrl(value) {
  const trimmed = String(value || "").trim();
  return (
    /^https?:\/\//i.test(trimmed) ||
    /^ssh:\/\//i.test(trimmed) ||
    /^git@[^:]+:.+/i.test(trimmed) ||
    /^git:\/\/.+/i.test(trimmed)
  );
}

function normalizeRepositoryOrigin(originUrl) {
  const trimmed = String(originUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  const gitSshMatch = /^([^@]+@)?([^:\/]+):(.+)$/.exec(trimmed);
  if (gitSshMatch && !trimmed.includes("://")) {
    return `${gitSshMatch[2].toLowerCase()}/${gitSshMatch[3].replace(/\.git$/i, "").toLowerCase()}`;
  }

  try {
    const parsedUrl = new URL(trimmed);
    const pathname = parsedUrl.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
    const portSuffix = parsedUrl.port ? `:${parsedUrl.port}` : "";
    return `${parsedUrl.hostname.toLowerCase()}${portSuffix}/${pathname.toLowerCase()}`;
  } catch {
    return trimmed.replace(/\.git$/i, "").toLowerCase();
  }
}

function buildRemoteListReposCommand(repositoriesRoot) {
  return `
repo_root=${shellQuote(repositoriesRoot)}
if [ ! -d "$repo_root" ]; then
  exit 0
fi
find "$repo_root" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r repo_dir; do
  if [ ! -e "$repo_dir/.git" ]; then
    continue
  fi
  repo_name=$(basename "$repo_dir")
  latest_modified=0
  for candidate in "$repo_dir" "$repo_dir/.git" "$repo_dir/.git/index" "$repo_dir/.git/FETCH_HEAD"; do
    if [ ! -e "$candidate" ]; then
      continue
    fi
    modified_at=$(stat -c %Y "$candidate" 2>/dev/null || echo 0)
    if [ "$modified_at" -gt "$latest_modified" ]; then
      latest_modified="$modified_at"
    fi
  done
  printf '%s\\t%s\\t%s\\n' "$repo_name" "$repo_dir" "$latest_modified"
done
`;
}

function buildRemoteLinkOrCopyEnvCommand(repoPath, worktreePath, envFileMode, targetLabel) {
  const actionScript =
    envFileMode === "copy"
      ? `if [ -f "$source_env" ] && [ ! -L "$source_env" ]; then
  printf '%s\\n' "Copying $relative_env_path from $source_env"
  cp "$source_env" "$worktree_env"
else
  printf '%s\\n' "Linking $relative_env_path from $source_env"
  ln -s "$source_env" "$worktree_env"
fi`
      : `printf '%s\\n' "Linking $relative_env_path from $source_env"
ln -s "$source_env" "$worktree_env"`;

  return `
repo_path=${shellQuote(repoPath)}
worktree_path=${shellQuote(worktreePath)}

find_env_files() {
  if [ -d "$repo_path" ]; then
    find "$repo_path" -maxdepth 1 \\( -name '.env' -o -name '.env.*' \\) ! -name '*.example' ! -type d 2>/dev/null
  fi
  for workspace_root in "$repo_path/apps" "$repo_path/packages"; do
    [ -d "$workspace_root" ] || continue
    find "$workspace_root" -maxdepth 4 \\( -name '.env' -o -name '.env.*' \\) ! -name '*.example' ! -type d 2>/dev/null
  done
}

env_files=$(find_env_files | sort -u)
if [ -z "$env_files" ]; then
  printf '%s\\n' ${shellQuote(`No .env files found in base repo on ${targetLabel}, skipping link.`)}
  exit 0
fi

printf '%s\\n' "$env_files" | while IFS= read -r source_env; do
  [ -n "$source_env" ] || continue
  relative_env_path=\${source_env#"$repo_path"/}
  if [ "$relative_env_path" = "$source_env" ] || [ -z "$relative_env_path" ]; then
    continue
  fi

  worktree_env="$worktree_path/$relative_env_path"
  if [ -e "$worktree_env" ] || [ -L "$worktree_env" ]; then
    printf '%s\\n' "Worktree already has $relative_env_path, skipping link."
    continue
  fi

  mkdir -p "$(dirname "$worktree_env")"
  ${actionScript}
done
`;
}

function buildRemoteResolvePathsCommand(targetPaths) {
  const resolveCalls = targetPaths
    .map((targetPath) => `resolve_path ${shellQuote(targetPath)}`)
    .join("\n");

  return `
resolve_path() {
  raw_path=$1
  case "$raw_path" in
    "")
      resolved_path=
      ;;
    "~")
      resolved_path=$HOME
      ;;
    "~/"*)
      resolved_path=$HOME/\${raw_path#\\~/}
      ;;
    *)
      resolved_path=$raw_path
      ;;
  esac

  case "$resolved_path" in
    "")
      printf '\\n'
      ;;
    /*)
      printf '%s\\n' "$resolved_path"
      ;;
    *)
      printf '%s/%s\\n' "$PWD" "$resolved_path"
      ;;
  esac
}
${resolveCalls}
`;
}

function normalizeResolvedRemotePath(targetPath) {
  const value = String(targetPath || "").trim();
  return value ? path.posix.normalize(value) : "";
}

async function getLocalRepoModifiedAt(repoPath, gitPath) {
  const candidatePaths = [
    repoPath,
    gitPath,
    path.join(gitPath, "index"),
    path.join(gitPath, "FETCH_HEAD")
  ];
  let latestModifiedAt = 0;

  for (const candidatePath of candidatePaths) {
    try {
      const stat = await fs.stat(candidatePath);
      latestModifiedAt = Math.max(latestModifiedAt, stat.mtimeMs);
    } catch {
      continue;
    }
  }

  return latestModifiedAt;
}

module.exports = {
  branchExistsLocally,
  branchExistsOnOrigin,
  createTargetAdapter,
  createWorktreeFromBranch,
  ensureBranchTracksOrigin,
  findExistingWorktree,
  getCurrentBranchName,
  getMainWorktree,
  inferRepoNameFromCloneUrl,
  isLikelyCloneUrl,
  listBranches,
  listWorktrees,
  normalizeRepositoryOrigin,
  resolveTargetPath,
  resolveTargetRootPaths,
  unsetBranchUpstream
};
