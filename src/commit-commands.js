const vscode = require("vscode");

const { getExecutableToken, resolveCommandForTarget } = require("./command-utils");
const { getConfig } = require("./config");
const { shellQuote } = require("./shell");
const {
  branchExistsOnOrigin,
  createTargetAdapter,
  getCurrentBranchName,
  normalizeRepositoryOrigin
} = require("./target-adapters");
const { getCurrentWorkspaceLocation, getTargetLabel } = require("./targets");

const COMMIT_MESSAGE_OUTPUT_SCHEMA = JSON.stringify(
  {
    type: "object",
    additionalProperties: false,
    required: ["commitMessage"],
    properties: {
      commitMessage: {
        type: "string",
        minLength: 1,
        pattern: "^[^\\r\\n]+$"
      }
    }
  },
  null,
  2
);
async function commitAndPushCurrentWorkspace(output) {
  const config = getConfig();
  const location = getCurrentWorkspaceLocation(config);
  const adapter = createTargetAdapter(location.target);
  const targetLabel = getTargetLabel(location.target);
  const workflowResult = {
    branchName: "",
    commitTitle: "",
    branchAlreadyExistedOnOrigin: false,
    pushSkippedReason: "",
    pullRequestCreated: false,
    pullRequestUrl: "",
    pullRequestNote: ""
  };

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Commit and push on ${targetLabel}`,
        cancellable: true
      },
      async (progress, token) => {
        const commandOptions = { signal: token };
        let repoPath = "";

        progress.report({ message: "Preparing repository context" });
        repoPath = (
          await adapter.runGit(
            location.workspacePath,
            ["rev-parse", "--path-format=absolute", "--show-toplevel"],
            undefined,
            commandOptions
          )
        ).trim();
        workflowResult.branchName = await getCurrentBranchName(adapter, location.workspacePath, commandOptions);

        if (!workflowResult.branchName) {
          throw new Error("Current workspace is in detached HEAD state. Switch to a branch before committing.");
        }

        await adapter.ensureCommandAvailable("git", repoPath, commandOptions);
        const commitMessageCodexCommand = await resolveCommandForTarget(
          adapter,
          config.commitMessageCodexCommand,
          repoPath,
          {
            ...commandOptions,
            settingName: "treehouse.commitMessageCodexCommand"
          }
        );
        if (commitMessageCodexCommand.fallbackFrom) {
          output.appendLine(
            `Using ${commitMessageCodexCommand.primaryCommand} on ${targetLabel} for commit-title generation instead of ${commitMessageCodexCommand.fallbackFrom}.`
          );
        }
        throwIfCancelled(token);

        progress.report({ message: "Inspecting current changes" });
        const promptContext = await collectCommitMessageContext(
          adapter,
          repoPath,
          workflowResult.branchName,
          targetLabel,
          commandOptions
        );

        if (!promptContext.gitStatus.trim()) {
          progress.report({ message: "No changes to commit" });
          output.appendLine(`No changes to commit on ${targetLabel}.`);
          return;
        }

        throwIfCancelled(token);

        output.appendLine(`Generating commit title for ${repoPath} on ${targetLabel}`);
        progress.report({ message: "Generating commit title" });
        const renderedPrompt = renderPromptTemplate(config.commitMessagePrompt, promptContext);
        const generatedCommitMessage = await generateCommitMessageWithCodex(
          adapter,
          repoPath,
          commitMessageCodexCommand.command,
          renderedPrompt,
          commandOptions
        );
        const normalizedCommitMessage = normalizeCommitMessage(generatedCommitMessage);

        if (!normalizedCommitMessage) {
          throw new Error("Codex returned an empty commit title.");
        }

        let finalCommitTitle = normalizedCommitMessage;
        if (config.commitMessageRequireApproval) {
          progress.report({ message: "Waiting for commit title review" });
          finalCommitTitle = await vscode.window.showInputBox({
            prompt: `Review the generated commit title for ${targetLabel}`,
            value: normalizedCommitMessage,
            validateInput(value) {
              const trimmedValue = String(value || "").trim();
              if (!trimmedValue) {
                return "Commit title cannot be empty.";
              }

              if (/[\r\n]/.test(trimmedValue)) {
                return "Commit title must be a single line.";
              }

              return null;
            }
          });

          if (!finalCommitTitle) {
            progress.report({ message: "Cancelled before commit" });
            return;
          }
        }

        const trimmedCommitTitle = finalCommitTitle.trim();
        workflowResult.commitTitle = trimmedCommitTitle;

        throwIfCancelled(token);

        progress.report({ message: "Staging changes" });
        await adapter.runGit(repoPath, ["add", "-A"], output, commandOptions);

        throwIfCancelled(token);

        progress.report({ message: "Creating commit" });
        await adapter.runGit(repoPath, ["commit", "-m", trimmedCommitTitle], output, commandOptions);

        let originUrl = "";
        try {
          originUrl = (
            await adapter.runGit(repoPath, ["remote", "get-url", "origin"], output, commandOptions)
          ).trim();
        } catch {
          workflowResult.pushSkippedReason = "No git remote named origin is configured.";
          progress.report({ message: "Committed, but no origin remote is configured" });
          return;
        }

        throwIfCancelled(token);

        workflowResult.branchAlreadyExistedOnOrigin = await branchExistsOnOrigin(
          adapter,
          repoPath,
          workflowResult.branchName,
          commandOptions
        );
        const upstreamName = await getCurrentUpstreamName(
          adapter,
          repoPath,
          workflowResult.branchName,
          commandOptions
        );
        const shouldSetUpstream =
          !workflowResult.branchAlreadyExistedOnOrigin || upstreamName !== `origin/${workflowResult.branchName}`;

        progress.report({
          message: shouldSetUpstream ? "Pushing branch and setting upstream" : "Pushing branch"
        });

        try {
          if (shouldSetUpstream) {
            await adapter.runGit(
              repoPath,
              ["push", "-u", "origin", workflowResult.branchName],
              output,
              commandOptions
            );
          } else {
            await adapter.runGit(repoPath, ["push"], output, commandOptions);
          }
        } catch (error) {
          throw new Error(
            `Commit '${trimmedCommitTitle}' was created, but pushing ${workflowResult.branchName} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }

        if (workflowResult.branchAlreadyExistedOnOrigin) {
          progress.report({ message: "Done" });
          return;
        }

        if (!isGitHubOrigin(originUrl)) {
          workflowResult.pullRequestNote = "Skipped PR creation because origin is not a GitHub repository.";
          progress.report({ message: "Done" });
          return;
        }

        progress.report({
          message:
            config.commitAndPushPullRequestMode === "draft" ? "Creating draft pull request" : "Creating pull request"
        });
        const pullRequestResult = await tryCreatePullRequest(
          adapter,
          repoPath,
          workflowResult.branchName,
          config.commitAndPushPullRequestMode,
          output,
          commandOptions
        );
        workflowResult.pullRequestCreated = pullRequestResult.created;
        workflowResult.pullRequestUrl = pullRequestResult.url;
        workflowResult.pullRequestNote = pullRequestResult.note;

        if (
          pullRequestResult.created &&
          config.commitAndPushRunCheckoutPullRequestByNumber
        ) {
          await tryCheckoutCreatedPullRequest(adapter, repoPath, pullRequestResult.url, workflowResult.branchName, commandOptions);
          await refreshGitAndPullRequestViews();
        }

        progress.report({ message: "Done" });
      }
    );
  } catch (error) {
    if (isCancellationError(error)) {
      output.appendLine(`Commit and push cancelled on ${targetLabel}.`);
      return;
    }

    throw error;
  }

  appendWorkflowSummary(output, targetLabel, workflowResult);
}

async function collectCommitMessageContext(adapter, repoPath, branchName, targetLabel, commandOptions = {}) {
  const branchIssueId = extractIssueIdFromBranchName(branchName) || "none";
  const gitStatus = await adapter.runGit(repoPath, ["status", "--short"], undefined, commandOptions);
  const untrackedDiffs = await collectUntrackedDiffs(adapter, repoPath, gitStatus, commandOptions);
  const [gitDiffStat, gitDiff, gitCachedDiffStat, gitCachedDiff] = await Promise.all([
    adapter.runGit(repoPath, ["diff", "--stat"], undefined, commandOptions),
    adapter.runGit(repoPath, ["diff"], undefined, commandOptions),
    adapter.runGit(repoPath, ["diff", "--cached", "--stat"], undefined, commandOptions),
    adapter.runGit(repoPath, ["diff", "--cached"], undefined, commandOptions)
  ]);

  return {
    branchIssueId,
    branchName,
    gitCachedDiff,
    gitCachedDiffStat,
    gitDiff,
    gitDiffStat,
    gitStatus,
    repoPath,
    targetLabel,
    untrackedDiffs
  };
}

async function collectUntrackedDiffs(adapter, repoPath, gitStatus, commandOptions = {}) {
  const untrackedFiles = String(gitStatus || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3))
    .filter(Boolean);

  if (!untrackedFiles.length) {
    return "";
  }

  const diffs = [];
  for (const relativePath of untrackedFiles) {
    const diff = await adapter.runCommand(
      `git diff --no-index -- /dev/null ${shellQuote(relativePath)} || test $? -eq 1`,
      repoPath,
      undefined,
      commandOptions
    );
    diffs.push(`### ${relativePath}\n${diff.trim()}`);
  }

  return diffs.filter(Boolean).join("\n\n");
}

function renderPromptTemplate(template, context) {
  return String(template || "").replace(/\$\{([A-Za-z0-9]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      return match;
    }

    return formatPromptValue(context[key]);
  });
}

function formatPromptValue(value) {
  const normalizedValue = String(value ?? "").trim();
  return normalizedValue || "(empty)";
}

async function generateCommitMessageWithCodex(adapter, repoPath, codexCommand, promptBody, commandOptions = {}) {
  const prompt = buildStructuredPrompt(promptBody);
  const command = buildCodexGenerationCommand(codexCommand, prompt);
  const rawOutput = await adapter.runCommand(command, repoPath, undefined, commandOptions);
  return parseGeneratedCommitMessage(rawOutput);
}

function buildStructuredPrompt(promptBody) {
  return [
    "You are generating a git commit title for an automated workflow.",
    "Use only the provided context.",
    "Do not run tools, inspect files, or ask follow-up questions.",
    "Return a JSON object with exactly one key named commitMessage.",
    "The commitMessage value must be a single-line git commit title with no surrounding quotes or commentary.",
    "",
    promptBody
  ].join("\n");
}

function buildCodexGenerationCommand(codexCommand, prompt) {
  const promptMarker = buildHereDocMarker("TREEHOUSE_PROMPT", prompt);
  const schemaMarker = buildHereDocMarker("TREEHOUSE_SCHEMA", COMMIT_MESSAGE_OUTPUT_SCHEMA);
  const execCommand = buildCodexExecCommand(codexCommand, "$schema_file", "$output_file");

  return `
tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t treehouse-commit)
prompt_file="$tmp_dir/prompt.txt"
schema_file="$tmp_dir/schema.json"
output_file="$tmp_dir/output.json"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
cat > "$prompt_file" <<'${promptMarker}'
${prompt}
${promptMarker}
cat > "$schema_file" <<'${schemaMarker}'
${COMMIT_MESSAGE_OUTPUT_SCHEMA}
${schemaMarker}
${execCommand} < "$prompt_file" 1>&2
test -s "$output_file"
cat "$output_file"
`;
}

function buildHereDocMarker(prefix, content) {
  let marker = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  while (String(content || "").includes(marker)) {
    marker = `${marker}_X`;
  }
  return marker;
}

function buildCodexExecCommand(commandPrefix, schemaFileExpression, outputFileExpression) {
  const trimmedCommandPrefix = String(commandPrefix || "").trim();
  const executableToken = getExecutableToken(trimmedCommandPrefix);
  if (!executableToken) {
    throw new Error("treehouse.commitMessageCodexCommand must start with an executable command.");
  }

  const trailingArgs = trimmedCommandPrefix.slice(executableToken.length).trim();
  const parts = [executableToken, "exec"];
  if (trailingArgs) {
    parts.push(trailingArgs);
  }

  parts.push(
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-schema",
    schemaFileExpression,
    "--output-last-message",
    outputFileExpression,
    "-"
  );

  return parts.join(" ");
}

function parseGeneratedCommitMessage(rawOutput) {
  const trimmedOutput = String(rawOutput || "").trim();
  if (!trimmedOutput) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmedOutput);
    if (parsed && typeof parsed.commitMessage === "string") {
      return parsed.commitMessage;
    }
  } catch {}

  return trimmedOutput;
}

function normalizeCommitMessage(message) {
  return String(message || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/, "");
}

function extractIssueIdFromBranchName(branchName) {
  const match = String(branchName || "").match(/[A-Za-z]+-[0-9]+/);
  return match?.[0]?.toLowerCase() || "";
}

function isGitHubOrigin(originUrl) {
  const normalizedOrigin = normalizeRepositoryOrigin(originUrl);
  const host = normalizedOrigin.split("/")[0] || "";
  return host === "github.com" || host.startsWith("github.") || host.includes(".github.");
}

async function getCurrentUpstreamName(adapter, repoPath, branchName, commandOptions = {}) {
  return (
    await adapter.runGit(
      repoPath,
      ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branchName}`],
      undefined,
      commandOptions
    )
  ).trim();
}

async function tryCreatePullRequest(adapter, repoPath, branchName, mode, output, commandOptions = {}) {
  try {
    await adapter.ensureCommandAvailable("gh", repoPath);
  } catch {
    return {
      created: false,
      url: "",
      note: "Commit and push succeeded, but gh is not available for PR creation."
    };
  }

  let baseBranch = "";
  try {
    baseBranch = await getOriginDefaultBranchName(adapter, repoPath, commandOptions);
  } catch {
    return {
      created: false,
      url: "",
      note: "Commit and push succeeded, but Treehouse could not determine origin's default branch for PR creation."
    };
  }

  try {
    const modeFlag = mode === "draft" ? "--draft " : "";
    const outputText = await adapter.runCommand(
      `gh pr create ${modeFlag}--fill-first --base ${shellQuote(baseBranch)} --head ${shellQuote(branchName)}`,
      repoPath,
      output,
      commandOptions
    );
    const urlMatch = String(outputText || "").match(/https:\/\/github\.com\/\S+/);
    return {
      created: true,
      url: urlMatch?.[0] || "",
      note:
        urlMatch?.[0]
          ? `${mode === "draft" ? "Draft PR" : "PR"} created: ${urlMatch[0]}`
          : `${mode === "draft" ? "Draft PR" : "PR"} created.`
    };
  } catch (error) {
    return {
      created: false,
      url: "",
      note: `Commit and push succeeded, but PR creation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}

async function tryCheckoutCreatedPullRequest(adapter, repoPath, pullRequestUrl, branchName, commandOptions = {}) {
  if (!pullRequestUrl || !branchName) {
    return;
  }

  try {
    await adapter.ensureCommandAvailable("gh", repoPath, commandOptions);
    await adapter.runCommand(
      `gh pr checkout ${shellQuote(pullRequestUrl)} --branch ${shellQuote(branchName)}`,
      repoPath,
      undefined,
      commandOptions
    );
  } catch (error) {
    if (isCancellationError(error)) {
      throw error;
    }
  }
}

async function refreshGitAndPullRequestViews() {
  await silentlyExecuteCommand("git.refresh");
  await silentlyExecuteCommand("pr.refreshList");
  await silentlyExecuteCommand("pr.refreshActivePullRequest");
}

async function silentlyExecuteCommand(command) {
  try {
    await vscode.commands.executeCommand(command);
  } catch {}
}

async function getOriginDefaultBranchName(adapter, repoPath, commandOptions = {}) {
  try {
    const output = await adapter.runGit(repoPath, ["ls-remote", "--symref", "origin", "HEAD"], undefined, commandOptions);
    const match = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match?.[1]) {
      return match[1];
    }
  } catch {}

  for (const candidate of ["main", "master"]) {
    if (await branchExistsOnOrigin(adapter, repoPath, candidate, commandOptions)) {
      return candidate;
    }
  }

  throw new Error("Unable to determine the default branch on origin.");
}

function appendWorkflowSummary(output, targetLabel, workflowResult) {
  if (!workflowResult.commitTitle) {
    return;
  }

  output.appendLine(`Committed '${workflowResult.commitTitle}' on ${targetLabel}`);
  output.appendLine(
    `Branch existed on origin before push: ${workflowResult.branchAlreadyExistedOnOrigin ? "yes" : "no"}`
  );

  if (workflowResult.pushSkippedReason) {
    output.appendLine(`Push skipped: ${workflowResult.pushSkippedReason}`);
    return;
  }

  output.appendLine(`Pushed branch ${workflowResult.branchName} to origin.`);

  if (workflowResult.pullRequestCreated) {
    output.appendLine(workflowResult.pullRequestUrl || "Pull request created.");
    return;
  }

  if (workflowResult.pullRequestNote) {
    output.appendLine(workflowResult.pullRequestNote);
  }
}

function joinNotes(...notes) {
  return notes
    .map((note) => String(note || "").trim())
    .filter(Boolean)
    .join(" ");
}

function throwIfCancelled(token) {
  if (token?.isCancellationRequested) {
    const error = new Error("Commit and push cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function isCancellationError(error) {
  return error?.name === "AbortError";
}

module.exports = {
  commitAndPushCurrentWorkspace
};
