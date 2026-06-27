Always build the project after making changes. Always build it after changes so we never forget to build it.

## Local VS Code Development

This extension is usually tested in normal VS Code windows through a linked local install, not through a VSIX and not through an Extension Development Host.

The local install should be a symlink from the local VS Code extensions directory to this repo root. Use the current machine's repo path; do not hard-code personal absolute paths in committed docs.

Example:

```bash
extension_id="$(node -p "const p = require('./package.json'); p.publisher + '.' + p.name")"
ln -s "$(pwd)" "$HOME/.vscode/extensions/${extension_id}-local"
```

If the user uses VS Code profiles, make sure the active profile is using that linked local extension location rather than a versioned VSIX install folder.

The extension root is the repo root. VS Code reads `package.json` from the repo, and `package.json` points to the built JavaScript:

```json
"main": "./dist/extension.js"
```

So after TypeScript changes, run:

```bash
npm run compile
```

Then ask the user to reload a normal VS Code window using the active local-development profile. The agent cannot reload the user's VS Code window itself. After the user reloads, VS Code will pick up the rebuilt `dist/extension.js`.

Do not install local changes with `code --install-extension` unless the user explicitly asks for VSIX testing. Do not create temporary local version bumps just to force VS Code to refresh. That creates versioned extension folders and stale profile state, which makes local testing confusing.

Do not use `--extensionDevelopmentPath` unless the user explicitly wants an Extension Development Host. The default local workflow should make Treehouse available in normal VS Code windows.

For `package.json` contribution changes, activity bar icon changes, or other manifest-level changes, still run `npm run compile`. Ask the user to reload a normal VS Code window after the build. A normal window reload is usually enough with the symlinked local install, but VS Code can cache contributed icons by path. If an icon change does not show up after the user reloads, ask the user to fully quit and reopen VS Code or rename the icon asset and update the manifest path to cache-bust it.

Do not commit or push unless the user explicitly asks. Pushing to `main` publishes the extension automatically.
