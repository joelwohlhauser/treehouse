const https = require("node:https");

async function fetchLinearIssue(issueId, apiKey) {
  const trimmedIssueId = String(issueId || "").trim().toUpperCase();
  if (!trimmedIssueId) {
    throw new Error("Linear issue identifier cannot be empty.");
  }

  const response = await postGraphQL(apiKey, {
    query: `
      query TreehouseIssueLookup($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          branchName
          updatedAt
          project {
            name
          }
          labels {
            nodes {
              name
            }
          }
          state {
            id
            name
            type
          }
          team {
            key
            name
            states {
              nodes {
                id
                name
                type
              }
            }
          }
        }
      }
    `,
    variables: {
      id: trimmedIssueId
    }
  });

  const issue = response.data?.issue;
  if (!issue) {
    throw new Error(`Linear issue not found: ${trimmedIssueId}`);
  }

  return normalizeIssue(issue);
}

async function fetchLinearIssueUrl(issueId, apiKey) {
  const trimmedIssueId = String(issueId || "").trim().toUpperCase();
  if (!trimmedIssueId) {
    throw new Error("Linear issue identifier cannot be empty.");
  }

  const response = await postGraphQL(apiKey, {
    query: `
      query TreehouseIssueUrlLookup($id: String!) {
        issue(id: $id) {
          url
        }
      }
    `,
    variables: {
      id: trimmedIssueId
    }
  });

  return String(response.data?.issue?.url || "").trim();
}

async function listAssignedIssues(apiKey, options = {}) {
  const { filters, limit } = normalizeListAssignedIssuesOptions(options);
  const response = await postGraphQL(apiKey, {
    query: `
      query TreehouseAssignedIssues($limit: Int!) {
        viewer {
          assignedIssues(first: $limit, orderBy: updatedAt) {
            nodes {
              id
              identifier
              title
              branchName
              updatedAt
              project {
                name
              }
              labels {
                nodes {
                  name
                }
              }
              state {
                id
                name
                type
              }
              team {
                key
                name
              }
            }
          }
        }
      }
    `,
    variables: {
      limit
    }
  });

  const issues = response.data?.viewer?.assignedIssues?.nodes || [];
  return issues
    .map(normalizeIssue)
    .filter((issue) => matchesAssignedIssueFilters(issue, filters))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

async function ensureIssueInProgress(issueId, apiKey) {
  const issue = await fetchLinearIssue(issueId, apiKey);
  const startedState = selectStartedState(issue.teamStates);
  if (!startedState) {
    return issue;
  }

  if (issue.state?.id === startedState.id) {
    return issue;
  }

  const response = await postGraphQL(apiKey, {
    query: `
      mutation TreehouseIssueStart($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue {
            id
            identifier
            title
            description
            branchName
            updatedAt
            project {
              name
            }
            labels {
              nodes {
                name
              }
            }
            state {
              id
              name
              type
            }
            team {
              key
              name
              states {
                nodes {
                  id
                  name
                  type
                }
              }
            }
          }
        }
      }
    `,
    variables: {
      id: issueId,
      stateId: startedState.id
    }
  });

  const updatedIssue = response.data?.issueUpdate?.issue;
  if (!response.data?.issueUpdate?.success || !updatedIssue) {
    throw new Error(`Failed to update Linear issue status for ${issueId}`);
  }

  return normalizeIssue(updatedIssue);
}

async function postGraphQL(apiKey, body) {
  const trimmedApiKey = String(apiKey || "").trim();
  if (!trimmedApiKey) {
    throw new Error("Treehouse Linear API key is not configured.");
  }

  const payload = JSON.stringify(body);

  return new Promise<any>((resolve, reject) => {
    const request = https.request(
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: trimmedApiKey
        }
      },
      (response) => {
        let rawBody = "";

        response.on("data", (chunk) => {
          rawBody += chunk.toString();
        });

        response.on("end", () => {
          try {
            const parsed = JSON.parse(rawBody);
            if (parsed.errors?.length) {
              const message =
                parsed.errors.find((error) => error?.message)?.message ||
                `Linear API request failed with status ${response.statusCode}`;
              reject(new Error(message));
              return;
            }

            if (response.statusCode && response.statusCode >= 400) {
              reject(new Error(`Linear API request failed with status ${response.statusCode}`));
              return;
            }

            resolve(parsed);
          } catch (error) {
            reject(new Error(`Failed to parse Linear API response: ${error.message}`));
          }
        });
      }
    );

    request.on("error", (error) => {
      reject(new Error(`Linear API request failed: ${error.message}`));
    });

    request.write(payload);
    request.end();
  });
}

function deriveBranchName(identifier, title) {
  return `${String(identifier || "").toLowerCase()}-${slugify(title)}`;
}

function normalizeIssue(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || "",
    branchName: issue.branchName || deriveBranchName(issue.identifier, issue.title),
    updatedAt: issue.updatedAt || "",
    projectName: issue.project?.name || "",
    labels: normalizeIssueLabels(issue.labels?.nodes),
    state: issue.state || null,
    teamKey: issue.team?.key || "",
    teamName: issue.team?.name || "",
    teamStates: issue.team?.states?.nodes || []
  };
}

function normalizeIssueLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels
    .map((label) => String(label?.name || "").trim())
    .filter(Boolean);
}

function normalizeListAssignedIssuesOptions(options) {
  if (typeof options === "number") {
    return {
      limit: options,
      filters: []
    };
  }

  return {
    limit: Number.isInteger(options?.limit) && options.limit > 0 ? options.limit : 25,
    filters: Array.isArray(options?.filters) ? options.filters : []
  };
}

function matchesAssignedIssueFilters(issue, filters) {
  const parsedFilters = filters.map(parseAssignedIssueFilter).filter(Boolean);
  return parsedFilters.every((filter) => {
    const matches = issueMatchesAssignedIssueFilter(issue, filter);
    return filter.negated ? !matches : matches;
  });
}

function parseAssignedIssueFilter(rawFilter) {
  const trimmedFilter = String(rawFilter || "").trim();
  if (!trimmedFilter) {
    return null;
  }

  const match = trimmedFilter.match(/^([!-])?\s*([a-zA-Z]+)\s*:\s*(?:"((?:\\"|[^"])*)"|(.+))$/);
  if (!match) {
    if (trimmedFilter.includes(":")) {
      throw new Error(
        `Invalid Treehouse Linear issue filter: ${trimmedFilter}. Use formats like label:"Today" or state:"In Progress".`
      );
    }

    return {
      field: "text",
      negated: false,
      value: normalizeFilterValue(trimmedFilter)
    };
  }

  const [, negation, rawField, quotedValue, bareValue] = match;
  const field = String(rawField || "").toLowerCase();
  const value = normalizeFilterValue(quotedValue ?? bareValue ?? "");
  const supportedFields = new Set([
    "id",
    "identifier",
    "label",
    "labels",
    "project",
    "query",
    "state",
    "status",
    "team",
    "text",
    "title"
  ]);

  if (!supportedFields.has(field)) {
    throw new Error(
      `Unsupported Treehouse Linear issue filter: ${trimmedFilter}. Supported fields: label, state, team, project, id, title, text.`
    );
  }

  if (!value) {
    throw new Error(`Treehouse Linear issue filter cannot be empty: ${trimmedFilter}`);
  }

  return {
    field,
    negated: negation === "!" || negation === "-",
    value
  };
}

function normalizeFilterValue(value) {
  return String(value || "")
    .trim()
    .replace(/\\"/g, "\"");
}

function issueMatchesAssignedIssueFilter(issue, filter) {
  const value = filter.value;

  switch (filter.field) {
    case "id":
    case "identifier":
      return equalsIgnoreCase(issue.identifier, value);
    case "label":
    case "labels":
      return issue.labels.some((label) => equalsIgnoreCase(label, value));
    case "project":
      return equalsIgnoreCase(issue.projectName, value);
    case "state":
    case "status":
      return equalsIgnoreCase(issue.state?.name, value) || equalsIgnoreCase(issue.state?.type, value);
    case "team":
      return equalsIgnoreCase(issue.teamKey, value) || equalsIgnoreCase(issue.teamName, value);
    case "title":
      return containsIgnoreCase(issue.title, value);
    case "query":
    case "text":
      return getIssueSearchableText(issue).includes(value.toLowerCase());
    default:
      return false;
  }
}

function getIssueSearchableText(issue) {
  return [
    issue.identifier,
    issue.title,
    issue.projectName,
    issue.teamKey,
    issue.teamName,
    issue.state?.name,
    issue.state?.type,
    ...issue.labels
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function equalsIgnoreCase(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function containsIgnoreCase(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function selectStartedState(states) {
  const startedStates = Array.isArray(states) ? states.filter((state) => state?.type === "started") : [];
  if (!startedStates.length) {
    return null;
  }

  return (
    startedStates.find((state) => String(state.name || "").toLowerCase() === "in progress") ||
    startedStates[0]
  );
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

module.exports = {
  ensureIssueInProgress,
  fetchLinearIssue,
  fetchLinearIssueUrl,
  listAssignedIssues
};
