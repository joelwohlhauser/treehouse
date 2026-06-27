const REPOSITORY_USAGE_KEY = "treehouse.repositoryUsage";

function getRepositoryUsageHistory(context) {
  if (!context?.globalState) {
    return {};
  }

  const value = context.globalState.get(REPOSITORY_USAGE_KEY);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

async function recordRepositoryUsed(context, repository) {
  if (!context?.globalState || !repository) {
    return;
  }

  const usageHistory = getRepositoryUsageHistory(context);
  usageHistory[getRepositoryUsageKey(repository)] = Date.now();
  await context.globalState.update(REPOSITORY_USAGE_KEY, usageHistory);
}

function sortRepositoriesByUsage(repositories, usageHistory = {}) {
  return repositories.slice().sort((left, right) => {
    const leftUsedAt = Number(usageHistory[getRepositoryUsageKey(left)] || 0);
    const rightUsedAt = Number(usageHistory[getRepositoryUsageKey(right)] || 0);

    if (leftUsedAt !== rightUsedAt) {
      return rightUsedAt - leftUsedAt;
    }

    return Number(right.modifiedAt || 0) - Number(left.modifiedAt || 0);
  });
}

function getRepositoryUsageKey(repository) {
  return JSON.stringify({
    targetId: repository.targetId || repository.target?.id || "",
    repoPath: repository.repoPath || ""
  });
}

module.exports = {
  getRepositoryUsageHistory,
  recordRepositoryUsed,
  sortRepositoriesByUsage
};
