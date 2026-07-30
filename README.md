# gh-md-editor

A browser-only GitHub-flavored markdown editor with a live side-by-side preview. Built for reading and editing PR-content markdown without leaving the browser.



https://github.com/user-attachments/assets/71694022-c26e-4ef5-9ecc-28074059191a






## Features

- **CodeMirror 6 editor** with markdown syntax tinting (distinct hues per heading level, strong/emphasis, monospace, links, quotes)
- **Live preview** using `markdown-it` and the GitHub markdown stylesheet, diffed onto the DOM with `morphdom` so `<details open>` state, scroll position, mermaid SVGs, and starry-night syntax highlighting survive each keystroke
- **Source-line mapping**: right-click on either pane to reveal the matching block on the other; closed `<details>` sections expand automatically when revealed
- **Outline sidebar** (H1–H8) on the right with fold/unfold, jump-on-click, and an active-heading highlight that follows the preview viewport (correctly skips headings inside collapsed `<details>`)
- **VS Code-style sticky-header stack** at the top of the editor, showing the heading breadcrumb for the current scroll position
- **GitHub-flavored alerts**: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`
- **Mermaid diagrams** and **starry-night syntax highlighting** in fenced code blocks (both lazy-loaded)
- **Markdown auto-pairs**: select text and type `` ` `` / `*` / `_` / `~` / `(` / `[` / `{` / `"` / `'` to wrap; `Cmd/Ctrl+Shift+→` expands the selection to the enclosing syntax node
- **In-pane search** (`Cmd/Ctrl+F`) and **soft-wrap toggle** (`Alt+Z`, persisted)
- **Keyboard shortcuts dialog** (press `?` with the outline focused, or click the `?` in the outline header)
- **localStorage persistence** — documents survive reloads

## Server mode

Since v0.9.1 the same editor can be served over a real folder, turning it into a small browser IDE:

```bash
npx @luutuankiet/gh-md-editor          # serves the current directory on http://127.0.0.1:8790
npx @luutuankiet/gh-md-editor --port 9000 --host 0.0.0.0 --token secret
```

`.md` files open in the three-pane cockpit above; every other file opens in a plain CodeMirror editor with language auto-detect and syntax highlighting. Also included: a lazy file tree, preview/pinned tabs with `Cmd/Ctrl+S` write-back and mtime-conflict prompts, an integrated terminal (multiple persistent sessions), workspace search backed by ripgrep, a git source-control panel with line-level stage/revert, fuzzy quick open, and a listening-ports panel.

It binds to loopback by default. Going beyond that with `--host` exposes a terminal, so pair it with `--token` or a reverse proxy that authenticates.

## Dev

```bash
npm install
npm run dev
```

## Build

```bash
npm run build          # web app -> dist/
npm run preview        # serve dist/ locally
npm run build:ext      # VS Code extension -> vscode/*.vsix
npm run build:all      # both
```

## Type-check

```bash
npm run check
```

## Shipping

This repo produces **two** deliverables with independent version numbers:

| | Source of truth | Ships to |
|---|---|---|
| Web app | `package.json` | GitHub Pages, deployed by Actions on every push to `main` |
| VS Code extension | `vscode/package.json` | `.vsix` / the VS Code Marketplace |

Most feature work lands in `src/components/*` and `src/lib/*`, which **both** deliverables
compile from — so one source edit usually wants one release on each side.

`scripts/ship.sh` automates both paths. It finds node under nvm if it isn't on your
`PATH`, runs the safety gates that keep private files and internal notes out of the
public remote, and refuses to tag a web release without a matching notes file.

```bash
npm run status                      # both versions + git state
npm run gates                       # safety gates only, nothing else

./scripts/ship.sh release web 0.8.2 # bump, build, gate, commit, tag, push
./scripts/ship.sh release ext 0.2.8 # bump, build, package vsix, commit, push
./scripts/ship.sh publish ext       # push an already-built vsix to the Marketplace
./scripts/ship.sh --help
```

Before a **web** release, write `releases/vX.Y.Z.md` and add its row to the
[index](./releases/README.md) — the script checks for the file and stops if it's missing.
It asks for confirmation before anything irreversible; pass `--yes` in a script.

Publishing the extension needs an Azure DevOps token with the `Marketplace: Manage`
scope, either in `VSCE_PAT` or stored via `vsce login luutuankiet`. These expire, and
the failure surfaces as an opaque `TF400813` error — the script explains the fix when
it hits one.

## Releases

Narrative release notes live in [`releases/`](./releases/). Start with the [index](./releases/README.md) or jump to the latest: [v0.8.1](./releases/v0.8.1.md).
