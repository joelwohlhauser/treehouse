const { openUrlInEditor } = require("./browser");

async function createLinearIssue() {
  await openUrlInEditor("https://linear.app/new");
}

module.exports = {
  createLinearIssue
};
