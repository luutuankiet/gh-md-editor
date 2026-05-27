# GH MD Editor — VS Code Extension

GitHub-flavored markdown editor as a VS Code custom editor for `.md` / `.markdown` files. Runs in VS Code Desktop AND vscode.dev / github.dev.

## Features
- Default editor for `.md` files (3-pane: source / preview / outline)
- Mermaid pan and zoom (matching mermaid.live UX)
- GitHub-flavored alerts, tables, fenced code highlight (via starry-night)
- Per-pane light / dark themes (cycle independently)
- Resizable splitters; widths cached across sessions via globalState
- Tab swap stays snappy — webview state preserved (`retainContextWhenHidden`)

## Build (local)

```bash
cd vscode
npm install
npm run build         # esbuild dual-target + vite webview
npm run package       # produces gh-md-editor-X.Y.Z.vsix
```

The parent project (`../`) must already have `node_modules` populated (`npm install` once at the top level). The webview Vite build aliases `@gmd → ../src` so Editor / Preview / Outline / Splitter Svelte components are shared with the web app build.

## Install

- VS Code → Extensions → `...` menu → **Install from VSIX...** → select `gh-md-editor-X.Y.Z.vsix`
- Open any `.md` file; it opens in the GH MD Editor by default.
- To temporarily use the default text editor: right-click file → **Reopen With...** → **Text Editor**.

## Architecture

- `src/extension.ts` — extension host. Registers `CustomTextEditorProvider`, bridges webview ↔ TextDocument via postMessage.
- `webview/main.ts` — webview entry. Waits for `init` from host, then mounts the Svelte app.
- `webview/index.html` — Vite dev template (production HTML built at runtime by extension host with CSP nonces).
- `vite.config.ts` — webview bundler; aliases `@gmd` → parent project's `src/` so Editor / Preview / Outline are shared verbatim with the web app.
- `esbuild.config.mjs` — extension host bundler (dual-target: Node desktop + webworker for web).

## Message Protocol

| Direction | Type | Payload | Purpose |
|---|---|---|---|
| webview → host | `ready` | — | Webview booted, ready for init |
| host → webview | `init` | `{ content, widths, uri, languageId }` | Initial document content + cached widths |
| webview → host | `editorChange` | `{ text }` | Full document replacement (Phase 2: structured `changes[]` for proper undo granularity) |
| webview → host | `widthsChange` | `{ splitPct, outlineSplitterPct }` | Persist splitter widths to globalState |
| host → webview | `externalUpdate` | `{ text }` | External edit (other extension, multi-cursor scenario) — re-dispatch to CM6 |

## Known limitations (Phase 1)

- Edit flow uses full-document replace per change; breaks VS Code's per-keystroke undo granularity. Cmd+Z still works but bundles many keystrokes at once.
- Mermaid requires `'unsafe-eval'` in webview CSP (uses `new Function()` internally). Phase 2: try `securityLevel: 'sandbox'` for a cleaner alternative.
- vscode.dev / github.dev compat: build produces the web bundle, but end-to-end verification via `@vscode/test-web` is Phase 2 work.
- Private GitHub user-attachment images (the TM-bridge workaround in the web app) are not yet bridged through `vscode.authentication`. Phase 3.
