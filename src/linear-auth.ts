const vscode = require("vscode");

const { getConfig } = require("./config");

async function getOrConfigureLinearApiKey() {
  const configuredApiKey = getConfig().linearApiKey;
  if (configuredApiKey) {
    return configuredApiKey;
  }

  return configureLinearApiKey();
}

async function configureLinearApiKey() {
  const apiKey = await vscode.window.showInputBox({
    prompt: "Enter your Linear personal API key",
    placeHolder: "lin_api_...",
    password: true,
    ignoreFocusOut: true,
    validateInput(value) {
      if (!value.trim()) {
        return "Linear API key cannot be empty.";
      }

      if (!value.trim().startsWith("lin_api_")) {
        return "Linear personal API keys usually start with lin_api_.";
      }

      return null;
    }
  });

  if (!apiKey) {
    return "";
  }

  await vscode.workspace
    .getConfiguration("treehouse")
    .update("linearApiKey", apiKey.trim(), vscode.ConfigurationTarget.Global);

  return apiKey.trim();
}

module.exports = {
  configureLinearApiKey,
  getOrConfigureLinearApiKey
};
