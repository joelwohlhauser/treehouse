const vscode = require("vscode");

async function openUrlInEditor(url) {
  const attempts = [
    () =>
      vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(url), {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false
      }),
    () => vscode.commands.executeCommand("simpleBrowser.show", url),
    () => vscode.commands.executeCommand("workbench.action.openBrowserEditor", { url, preserveFocus: false }),
    () => vscode.commands.executeCommand("workbench.action.browser.open", url)
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const suffix = lastError ? ` ${lastError instanceof Error ? lastError.message : String(lastError)}` : "";
  throw new Error(`No supported browser-open command is available in this editor build.${suffix}`.trim());
}

module.exports = {
  openUrlInEditor
};
