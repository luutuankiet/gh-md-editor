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

## Dev

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Type-check

```bash
npm run check
```

## Releases

Narrative release notes live in [`releases/`](./releases/). Start with the [index](./releases/README.md) or jump to the latest: [v0.4.2](./releases/v0.4.2.md).
