# Treehouse

[![Install from VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=joelwohlhauser.treehouse)
[![Install for Cursor](https://img.shields.io/badge/Cursor-Install-111111)](https://open-vsx.org/extension/joelwohlhauser/treehouse)

Treehouse exists to make parallel development practical.

With coding agents, it is normal to have multiple pieces of work moving at the same time: a feature branch, a bugfix, a review follow-up, and sometimes an urgent issue that interrupts everything else. Doing that in a single checkout is painful. You end up stashing, switching branches, restarting dev servers, and losing context.

Treehouse solves that by making Git worktrees the default workflow inside VS Code. It helps you create or reopen isolated workspaces quickly, start previews, and move the heavier work onto a remote server when your local machine starts to struggle.

## Recommended VS Code Setup

On macOS, enable `Window: Native Tabs` so the worktree windows Treehouse opens can live as tabs in one native window.

```json
{
  "window.nativeTabs": true
}
```

Restart VS Code after changing this setting. Native tabs can disable VS Code's custom title bar style if you have one configured.

## Core Capabilities

### Worktree setup and reopening

- Create or reopen worktrees from a unified repository picker that can include local and remote targets.
- Load local repositories immediately and load remote repositories into the same picker in the background.
- Sort repositories by recent Treehouse usage first, then by repository activity.
- Keep duplicate repository names as separate entries by showing the target label.
- Paste a Git clone URL directly into the repository picker to clone first, then continue into the worktree flow.
- Reuse an existing primary clone if the selected repository already exists on the target.
- Remember the last target used for creation flows with `treehouse.defaultCreateTarget: "last-used"`.

### Branch and worktree selection

- Show existing worktrees for the selected repository before showing branches.
- Show the remaining branches from both local refs and `origin/*`, sorted by most recent commit activity.
- Exclude branches that are already checked out in a worktree from the branch list.
- Type any new branch name directly in the picker to create a fresh worktree.
- Reopen an existing worktree immediately if that branch is already checked out.

### Worktree creation behavior

1. Pick a repository, or paste a clone URL if you need Treehouse to clone it first.
2. Choose an existing worktree, choose an existing branch, or type a new branch name directly.
3. Treehouse handles the Git work in the background: it reuses existing worktrees when possible, fetches remote branches when needed, configures tracking, and creates the new worktree path from `treehouse.worktreePathTemplate`.
4. Treehouse prepares the workspace for you by applying the configured `.env` behavior, optionally queueing `pnpm i`, and optionally queueing a coding-agent prompt after the folder opens.
5. Treehouse opens the worktree in VS Code, locally or on a remote target.

### Using a remote server

Working on many branches in parallel is one of the main reasons to move development off the laptop and onto a remote server.

If you have several worktrees open at once and also run several dev servers, especially heavier ones like Next.js, the local machine can get slow and laggy quickly. Treehouse supports the same workflow on remote targets so that cloning, worktree creation, dependency installs, dev servers, and coding-agent runs can happen on a more powerful machine instead.

Treehouse relies on VS Code's `Remote - SSH` extension to open remote worktrees in the editor. Install that extension, configure your SSH host alias, and Treehouse can open the target folder using the same remote connection model.

### Remote SSH setup

- Install Microsoft's `Remote - SSH` extension if you want to use Treehouse with a remote server.

### Worktree removal

`Treehouse: Delete Current Worktree`:

- Only works from a linked worktree and refuses to touch the main checkout.
- Prompts before removing a dirty worktree.
- Removes the worktree, cleans up the Treehouse-managed session around it, and closes the current VS Code window when finished.

### Worktree rename

`Treehouse: Rename Current Worktree`:

- Only works from a linked worktree and refuses to rename the main checkout or a detached `HEAD`.
- Renames the current branch and moves the worktree folder to match `treehouse.worktreePathTemplate`.
- Reopens the renamed worktree when the move is complete.

### Commit and push

`Treehouse: Commit and Push`:

- Inspects the current workspace's staged and unstaged changes, plus untracked file diffs, before generating a commit title.
- Runs `codex exec` in read-only, ephemeral mode to generate a structured commit title from a configurable prompt template.
- Shows a single progress notification immediately and updates it through the full workflow with a cancel button.
- Uses the generated title directly by default, with optional manual review through `treehouse.commitMessageRequireApproval`.
- Stages all current changes with `git add -A`, creates the commit, and pushes to `origin`.
- Sets upstream automatically when the current branch is not already tracking `origin/<branch>`.
- Creates a ready GitHub pull request on the first push by default when `origin` is a GitHub repository and `gh` is available.
- Supports switching first-push PR creation between `ready` and `draft` with `treehouse.commitAndPushPullRequestMode`.
- Silently runs `gh pr checkout` after creating a new PR on the branch's first push when `treehouse.commitAndPushRunCheckoutPullRequestByNumber` is enabled, so the GitHub Pull Requests extension can detect the active PR without showing its checkout picker.
- Works for local workspaces and Treehouse-managed SSH workspaces through the same target adapter flow.

## Linear Integration

Treehouse has a built-in Linear workflow for turning issues into worktrees.

### Implement Linear Issue

`Treehouse: Implement Linear Issue`:

- Prompts for a Linear API key the first time it is needed.
- Starts from your assigned Linear issues, sorted by most recently updated.
- Still lets you type any issue identifier manually, such as `AI-859`.
- Uses Linear's branch name when present and otherwise derives one from the issue identifier and title.
- Can move the issue into a started or in-progress state with `treehouse.linearSetIssueInProgress`.
- Reopens an existing matching worktree when one already exists, or creates a new one in the inferred, mapped, or selected repository.
- Optionally starts the configured coding agent after the issue worktree opens with `treehouse.linearStartCodingAgent`.

### Treehouse sidebar

Treehouse contributes an activity-bar view named `My Linear Issues`.

That sidebar:

- Shows a `Configure Linear API key` action when the API key is missing.
- Loads your assigned issues from Linear.
- Applies `treehouse.linearAssignedIssueFilters` to both the sidebar and the issue picker.
- Groups issues by status or project with `treehouse.linearAssignedIssuesGroupBy`.
- Sorts status groups with started issues first, then unstarted, backlog, completed, canceled, and everything else.
- Shows issue icons based on Linear state type.
- Shows issue metadata in tooltips, including team, status, project, and labels.
- Provides a `New Issue` title action that opens `https://linear.app/new` in VS Code's browser.
- Provides a refresh title action.
- Provides an inline `Implement` action for each issue.
- Opens the real Linear issue page in the editor when possible.
- Falls back to a generated Markdown issue preview when the browser open fails.

### Linear filters

`treehouse.linearAssignedIssueFilters` supports:

- Free-text search such as `"preview"`.
- Field filters such as `label:"Today"`, `state:"In Progress"`, `team:"AI"`, `project:"Roadmap"`, `id:"AI-123"`, and `title:"preview"`.
- Synonyms `identifier`, `labels`, `status`, `query`, and `text`.
- Negation with `!` or `-`, for example `!label:"Today"`.
- `AND` semantics across all configured filters.

### Linear API key storage

- `treehouse.linearApiKey` is stored in local VS Code settings as plain text.
- `Treehouse: Configure Linear API Key` lets you set or replace it from the editor.

## Privacy and Local Data

Treehouse does not include telemetry. It stores local extension state in VS Code, including recent repository usage, pending setup actions, and the Linear API key in plain-text settings. It reads Codex session history from the configured local or SSH path when Codex features are used, and it sends requests to Linear only for Linear commands and sidebar data.

## App Preview

Treehouse can manage a workspace dev server and open the preview in your browser.

### What it does

`Treehouse: Open App Preview`:

- Starts `pnpm dev -p <random-port>` in the current workspace.
- Chooses the first available port starting at `3000`.
- Opens `https://localhost:<port>/app` in the system browser by default.
- Can open previews in VS Code's integrated browser when `treehouse.appPreviewOpenTarget` is set to `vscodeBrowser`.
- Shows separate running-preview controls for opening the same port in the system browser or VS Code's integrated browser.
- Reuses the same VS Code browser tab when the integrated browser target is enabled.
- Pins a newly opened VS Code browser tab when the editor supports it.
- Reuses the existing Treehouse preview terminal, port, and browser session for the same workspace when possible.

`Treehouse: Restart Dev Server`:

- Restarts the tracked dev server if it is already running.
- Starts it if Treehouse has a preview session but the server is currently down.

`Treehouse: Open Dev Server Terminal`:

- Reveals the local preview terminal.
- For remote targets, opens a terminal attached to the remote `tmux` session that owns the dev server.

### Local preview behavior

For local workspaces, Treehouse:

- Starts a transient integrated terminal named `App Preview :<port>`.
- Uses terminal shell integration when available to watch command output for `Ready`.
- Falls back to probing the port directly when shell integration is unavailable.
- Shows a passive status-bar indicator for whether the dev server is stopped, starting, or running.
- Keeps start, restart, open preview, open terminal, and stop controls in the `Dev Servers` sidebar.

### Remote preview behavior

For remote workspaces, Treehouse:

- Chooses an available remote port on the target server.
- Starts the dev server in a dedicated remote `tmux` session.
- Creates or reuses a local SSH port forward, preferring the same local port as the remote dev server and falling back to the next available local port when needed.
- Opens the forwarded preview locally in the configured preview target.
- Reattaches to the remote `tmux` session on demand.
- Recovers an already-running remote preview session on startup and workspace changes when it can detect one.
- Stops the remote dev server and tears down the port forward when the current worktree is deleted through Treehouse.

### Dev Servers sidebar

Treehouse also contributes a `Dev Servers` sidebar view.

That sidebar:

- Scans the current workspace machine for running dev servers and lists their listening ports.
- Uses the local machine for local workspaces.
- Uses the current Remote-SSH host for SSH workspaces, reusing the configured Treehouse target label when one matches.
- Shows the process name, pid, working directory, and command in the port tooltip when available.
- Shows the tracked app-preview status and controls.
- Provides title actions for open preview, restart, open terminal, stop, and refresh.

## Terminal Sidebar

Treehouse contributes a `Terminal` sidebar view that controls a native VS Code integrated terminal from the Treehouse activity-bar panel.

That sidebar:

- Shows whether the current workspace already has a Treehouse terminal.
- Opens or reveals an integrated terminal named for the current workspace.
- Uses VS Code's integrated terminal API, so terminal rendering, colors, and TUIs are handled by VS Code.
- Uses the local machine for local workspaces.
- Uses the current Remote-SSH workspace host for SSH workspaces, so the shell and Codex process run on the remote host.
- Can open the latest Codex chat history for the current workspace on window startup or reload when `treehouse.openLatestCodexChatOnStartup` is enabled.
- Watches Codex session history for the current workspace.
- Runs from the workspace extension host first, so SSH windows read Codex history from the SSH target instead of the local machine.
- Registers a `${treehouseCodexStatus}` window-title variable with values like `⚪`, `🟡`, `🟢`, or `🔴`.
- Provides actions to open the latest Codex chat, start the configured coding agent, send an arbitrary command, clear the terminal, or restart the terminal.

To show the Codex status in the VS Code title bar, add `${treehouseCodexStatus}` to `window.title`, for example:

```json
{
  "window.title": "${dirty}${activeEditorShort}${separator}${rootName}${separator}${treehouseCodexStatus}${separator}${appName}"
}
```

If the running VS Code build does not support extension-provided window-title variables, Treehouse still watches status and exposes it through `Treehouse: Show Codex Session Status`.

## Coding-Agent Skills

`Treehouse: Execute Agent Skill` scans the configured skills directory and runs a skill command through your configured coding agent.

That flow:

- Resolves `treehouse.skillsRoot` relative to the current workspace when the path is not absolute.
- Recursively finds directories containing `SKILL.md`.
- Sorts skills by most recently executed first, then by name.
- Launches the selected skill as `/<skill-name>`.
- Runs in the background with a cancellable notification when `treehouse.executeSkillsInBackground` is enabled.
- Opens a terminal editor tab instead when background execution is disabled.
- Uses a faster `codex exec --skip-git-repo-check ...` path when the configured agent command starts with `codex`.

## Commands

Treehouse contributes these commands:

- `Treehouse: Create or Open Worktree`
- `Treehouse: Open App Preview`
- `Treehouse: Restart Dev Server`
- `Treehouse: Open Dev Server Terminal`
- `Treehouse: Refresh Dev Servers`
- `Treehouse: Open Terminal`
- `Treehouse: Open Latest Codex Chat`
- `Treehouse: Show Codex Session Status`
- `Treehouse: Start Codex in Terminal`
- `Treehouse: Send Terminal Command`
- `Treehouse: Restart Terminal Session`
- `Treehouse: Clear Terminal`
- `Treehouse: Implement Linear Issue`
- `Treehouse: Open Linear Issue Details`
- `Treehouse: Configure Linear API Key`
- `Treehouse: Execute Agent Skill`
- `Treehouse: Commit and Push`
- `Treehouse: Delete Current Worktree`
- `Treehouse: Rename Current Worktree`

## Deep Links

Treehouse can also open workspaces from a `vscode://` link through VS Code's URI handler.

Use the extension id as the link authority:

```text
vscode://joelwohlhauser.treehouse/open-worktree?target=<target-id>&repo=<repo-name>&branch=<branch-name>&newWindow=1
```

Supported query parameters:

- `target` or `targetId`: Treehouse target id, for example `local` or `remote-server`.
- `sshHost` or `host`: SSH host alias to match an SSH target when you do not want to pass the target id.
- `repo`: Repository name, clone URL, or full repository path on the target.
- `branch`: Branch name to reopen or create as a worktree.
- `path`: Exact folder path to open directly instead of resolving `repo` and `branch`.
- `newWindow`: Whether to force a new VS Code window. Defaults to `1` for URI links.

Examples:

```text
vscode://joelwohlhauser.treehouse/open-worktree?target=remote-server&repo=waffle-maker&branch=crispy-edge&newWindow=1
vscode://joelwohlhauser.treehouse/open-workspace?sshHost=remote-server&path=%2Fhome%2Fdev%2Frepositories%2F.worktrees%2Fwaffle-maker%2Fcrispy-edge&newWindow=1
```

The Linear sidebar also exposes these view actions:

- `New Issue`
- `Treehouse: Refresh My Linear Issues`
- Inline `Implement` for each issue

The Dev Servers sidebar also exposes these view actions:

- `Treehouse: Open App Preview`
- `Treehouse: Restart Dev Server`
- `Treehouse: Open Dev Server Terminal`
- `Treehouse: Stop Dev Server`
- `Treehouse: Refresh Dev Servers`

The Terminal sidebar also exposes these view actions:

- `Treehouse: Open Terminal`
- `Treehouse: Open Latest Codex Chat`
- `Treehouse: Show Codex Session Status`
- `Treehouse: Start Codex in Terminal`
- `Treehouse: Send Terminal Command`
- `Treehouse: Clear Terminal`
- `Treehouse: Restart Terminal Session`

## Configuration

### Recommended target configuration

`treehouse.targets` is the primary configuration model. The local target always exists, and SSH targets use your existing SSH host aliases.

```json
{
  "treehouse.targets": [
    {
      "id": "local",
      "type": "local",
      "label": "Local",
      "repositoriesRoot": "~/Repositories",
      "worktreesRoot": "~/Repositories/.worktrees"
    },
    {
      "id": "remote-server",
      "type": "ssh",
      "label": "Remote Server",
      "sshHost": "remote-server",
      "repositoriesRoot": "~/repositories",
      "worktreesRoot": "~/repositories/.worktrees"
    }
  ]
}
```

### Settings reference

- `treehouse.alwaysPromptForTarget`  
  Default: `false`  
  Prompt for a target before showing repositories instead of using the unified picker.

- `treehouse.defaultCreateTarget`  
  Default: `"last-used"`  
  Select the default target for clone-based creation flows. Supports `"last-used"` or a target id.

- `treehouse.targets`  
  Default: one built-in local target rooted at `~/Repositories` and `~/Repositories/.worktrees`  
  Defines all local and SSH targets.

- `treehouse.repositoriesRoot`  
  Deprecated. Legacy root settings are migrated into `treehouse.targets` when `treehouse.targets` is unset.

- `treehouse.worktreesRoot`  
  Deprecated. Legacy root settings are migrated into `treehouse.targets` when `treehouse.targets` is unset.

- `treehouse.worktreePathTemplate`  
  Default: `"${repo}/${branch}"`  
  Defines the relative path below `worktreesRoot`. Supports `${repo}`, `${branch}`, and `${sanitizedBranch}`.

- `treehouse.envFileMode`  
  Default: `"link"`  
  Controls how `.env` is added to new worktrees. Supported values: `link`, `copy`, `off`.

- `treehouse.installDependencies`  
  Default: `true`  
  Runs `pnpm i` automatically after a newly created worktree opens.

- `treehouse.appPreviewOpenTarget`
  Default: `"externalBrowser"`
  Controls where app preview URLs open. Supported values: `externalBrowser`, `vscodeBrowser`.

- `treehouse.codingAgentCommand`  
  Default: `"codex"`  
  Shell command prefix used to launch the coding agent. Examples: `codex`, `claude code`. When the execution host cannot find a configured path-like executable, Treehouse retries with just the executable name on PATH.

- `treehouse.codexSessionsRoot`
  Default: `"~/.codex/sessions"`
  Root folder containing Codex session history files. `~` is expanded on the current workspace host.

- `treehouse.codexSessionPollIntervalMs`
  Default: `2500`
  Polling interval for watching Codex session JSONL files. Treehouse uses polling so status tracking works on SSH hosts and Linux filesystems.

- `treehouse.openLatestCodexChatOnStartup`
  Default: `false`
  When enabled, opens the latest Codex chat for the current workspace when the VS Code window starts or reloads.

- `treehouse.latestCodexChatOpenTarget`
  Default: `"sidebar"`
  Controls whether the latest Codex chat opens through the OpenAI Codex sidebar route or as a custom editor panel.

- `treehouse.commitMessageCodexCommand`  
  Default: `"codex"`  
  Shell command prefix used to run Codex for `Treehouse: Commit and Push`. Treehouse inserts `exec`, read-only automation flags, and the rendered prompt. When the execution host cannot find a configured path-like executable, Treehouse retries with just the executable name on PATH.

- `treehouse.commitMessagePrompt`  
  Default: built-in prompt template  
  Prompt template used to generate commit titles for `Treehouse: Commit and Push`. Available placeholders: `${repoPath}`, `${branchName}`, `${branchIssueId}`, `${targetLabel}`, `${gitStatus}`, `${gitDiffStat}`, `${gitDiff}`, `${gitCachedDiffStat}`, `${gitCachedDiff}`, and `${untrackedDiffs}`.

- `treehouse.commitMessageRequireApproval`  
  Default: `false`  
  When enabled, `Treehouse: Commit and Push` pauses for manual review of the generated commit title before committing.

- `treehouse.commitAndPushPullRequestMode`  
  Default: `"ready"`  
  Controls whether `Treehouse: Commit and Push` creates a normal pull request or a draft pull request on the first push.

- `treehouse.commitAndPushRunCheckoutPullRequestByNumber`  
  Default: `true`  
  Silently runs `gh pr checkout` after `Treehouse: Commit and Push` creates a new pull request on the first push, so the GitHub Pull Requests extension can detect the active PR without showing its checkout picker.

- `treehouse.skillsRoot`  
  Default: `"skills"`  
  Root folder scanned by `Treehouse: Execute Agent Skill`.

- `treehouse.executeSkillsInBackground`  
  Default: `true`  
  Runs agent skills in the background with a progress notification instead of opening a terminal editor.

- `treehouse.shellCommand`  
  Default: `""`  
  Overrides the shell Treehouse uses for local commands. When unset, Treehouse uses `SHELL`, then `/bin/sh` on Unix or `cmd.exe` on Windows.

- `treehouse.linearApiKey`  
  Default: `""`  
  Linear personal API key used for issue lookup, issue lists, and status updates.

- `treehouse.linearAssignedIssueFilters`  
  Default: `[]`  
  Extra filters applied to assigned issues in both the picker and the sidebar.

- `treehouse.linearAssignedIssuesGroupBy`  
  Default: `"status"`  
  Sidebar grouping mode. Supported values: `status`, `project`.

- `treehouse.linearTeamRepositoryMap`  
  Default: `{}`  
  Maps Linear team keys or names to repository folder names.

- `treehouse.linearSetIssueInProgress`  
  Default: `true`  
  Moves the selected issue into a started state before opening its worktree.

- `treehouse.linearStartCodingAgent`  
  Default: `false`  
  Starts the configured coding agent after opening a Linear issue worktree.

- `treehouse.openInNewWindow`  
  Default: `false`  
  Prefers opening worktrees in a new VS Code window when the current window is empty. If a folder is already open, Treehouse always opens the new worktree in a new window.

## Requirements and Assumptions

### Local requirements

- `git` must be available locally.
- `lsof` is recommended locally for the `Dev Servers` sidebar.
- `pnpm` must be available locally for dependency installation and app preview.
- Your configured coding-agent executable must be available when using agent features.
- The OpenAI Codex VS Code extension must be installed to open Codex chat history.
- The command from `treehouse.commitMessageCodexCommand` must be available when using `Treehouse: Commit and Push`.
- `gh` is optional locally and only needed when you want `Treehouse: Commit and Push` to create a first-push PR.

### SSH target requirements

- The local machine must be able to connect with `ssh <alias>` using the configured `sshHost`.
- `git` must be available on the SSH target.
- `lsof` or `ss` is recommended on the SSH target for the `Dev Servers` sidebar.
- `pnpm` must be available on the SSH target for dependency installation and app preview.
- The Treehouse extension must be installed and enabled in the Remote-SSH extension host.
- `~` in SSH target roots is resolved on the SSH target, not on the local machine.
- The configured coding-agent executable, or its basename when the setting points at a local path, must be available on the SSH target when you want Treehouse to start it there.
- Codex session history must exist under `treehouse.codexSessionsRoot` on the SSH target to open the latest workspace chat and track Codex completion status.
- The command from `treehouse.commitMessageCodexCommand`, or its basename when the setting points at a local path, must be available on the SSH target when using `Treehouse: Commit and Push` there.
- `gh` is optional on the SSH target and only needed when you want first-push PR creation there.

### Extra requirements for SSH app preview

- `ssh` must be available locally.
- `tmux` must be available on the SSH target.
- `node` must be available on the SSH target for Treehouse's remote port probes.
- The current implementation assumes a Linux-like SSH target with `/proc` available for remote preview detection and cleanup.
