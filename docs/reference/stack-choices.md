---
title: Stack choices and the numbers behind them
summary: what each layer is, and the measured evidence that picked it over the obvious alternative
verified: 2026-08-20
---

# Stack choices and the numbers behind them

The evidence here is what stops a settled choice being relitigated every year. The
version column is a starting point — read the manifests for what is actually
installed.

| layer | choice | why |
|---|---|---|
| editor core | CodeMirror 6 | ~4× smaller than Monaco, no resize lag, tree-shakable |
| renderer | markdown-it | mature, exposes source-line maps via `token.map`, used internally by VS Code |
| diagrams | mermaid v10, **not v11** | v11 is roughly 30% larger gzipped with no feature this needs |
| preview highlighting | starry-night | GitHub's own highlighter; its CSS variables match `github-markdown-css` |
| framework | Svelte 5 | minimal runtime, fine-grained reactivity for outline and cursor sync |
| build | Vite 6 | `base: '/gh-md-editor/'`, `optimizeDeps.exclude` for the CodeMirror packages |
| preview CSS | `github-markdown-css` | auto-themes from `prefers-color-scheme` |
| terminal | xterm.js 6 | see the terminal chord trap for what v6 changed |

## Measured baselines

| metric | value | source |
|---|---|---|
| Monaco → CodeMirror 6 bundle | 5.01 MB → 1.26 MB gzip (4×) | Replit's migration writeup |
| CodeMirror 6 mobile retention impact | +70% weekly | Replit migration |
| mermaid v10 vs v11 gzip | 373 KB vs 480 KB (~30%) | mermaid issue tracker |
| markdown-it core gzip | ~20–30 KB | bundlephobia |
| starry-night, per lazy grammar | ~10–50 KB | upstream |
| target initial bundle | < 1 MB gzip | self-imposed |

Monaco is a **standing rejection**, re-affirmed more than once. Bundle size and
resize lag are the reasons; both are measured above.

## Framework details that are easy to trip over

- Vite needs `optimizeDeps.exclude` for the CodeMirror packages, or pre-bundling
  breaks ESM resolution.
- `keymap.of([...])` evaluates top to bottom and stops at the first match, so
  app-level shortcuts must be registered **first** to shadow `defaultKeymap` and
  `searchKeymap`.
- CodeMirror 6 has no scrollbar match-dot API — CodeMirror 5's `annotateScrollbar`
  was never ported. A custom `ViewPlugin` overlay is the community pattern.
- `github-markdown-css` honours only `prefers-color-scheme`. It ignores a
  `data-color-mode` attribute.
- mermaid v10 ships its own TypeScript types. Do **not** install `@types/mermaid`;
  no v10-compatible package exists.
- The front end ships as eight parallel chunks, with the roughly 130 lazy
  highlighting grammars deliberately left unnamed.
- `index.html` inlines a boot skeleton that retires itself through a `:not(:empty)`
  sibling CSS rule, with no script involved.

## Upstream references

| what | url |
|---|---|
| CodeMirror 6 system guide | https://codemirror.net/docs/guide/ |
| `@codemirror/search` | https://codemirror.net/docs/ref/#search |
| markdown-it | https://markdown-it.github.io |
| starry-night | https://github.com/wooorm/starry-night |
| github-markdown-css | https://github.com/sindresorhus/github-markdown-css |
| mermaid render API | https://mermaid.js.org/config/usage.html |
| Vite on GitHub Pages | https://vitejs.dev/guide/static-deploy#github-pages |
| Replit's CodeMirror 6 migration | https://blog.replit.com/codemirror |
| solomd — the Vue 3 reference implementation this lifted library code from | https://github.com/zhitongblog/solomd |
