---
title: Two shells, one source tree
covers: which components belong to the browser editor, which to the server IDE, and why a change in src/lib touches both
verified: 2026-08-20
---

# Two shells, one source tree

This repository builds three deliverables from one `src/`. Knowing which shell you
are in decides whether a change is live, frozen or double-shipped.

## The three shells

| shell | entry | components | shipped as |
|---|---|---|---|
| **browser editor** | `src/main.ts`, `index.html` | `src/components/{App,Editor,Preview,Outline,Splitter,ShortcutsDialog,ThemeToggle}.svelte` | GitHub Pages, built by `npm run build` |
| **server IDE** | `server/web/main.ts`, `src/components/App-server.svelte` | `src/components/server/*` | npm `@luutuankiet/gh-md-editor`, built by `npm run build:server` |
| **VS Code extension** | `vscode/webview/main.ts`, `src/components/App-vscode.svelte` | reuses the browser components | `.vsix`, built by `bash scripts/ship.sh build ext` |

Each carries its own version number in its own manifest. They move independently
on purpose.

## The browser editor is frozen

It still ships and still works, but no feature has landed in it since v0.7. If you
are reading a component under `src/components/` that is not in `server/`, you are
reading maintained-but-not-developed code. New work goes in `src/components/server/`.

The one thing worth preserving from it is the reveal-counterpart design — see
`docs/architecture/source-line-mapping.md`.

## `src/lib/` is the shared floor

Everything under `src/lib/` is framework-agnostic TypeScript compiled into all
three bundles. A change there is a change to every shell at once, which is both
the reason the repo is structured this way and the reason `src/lib/` is where a
careless edit does the most damage.

Two modules in there behave differently per shell, and the mechanism is worth
knowing because it looks like dead code otherwise:

- `src/lib/tab-view-state.svelte.ts` — `initTabViewState(folder)` is called only
  at `src/components/App-server.svelte` module scope. In the Pages and VS Code
  builds it is never initialised, so `patchTabView` no-ops and every lookup falls
  through to the app-wide default. That is deliberate, not a missing call.
- `src/lib/vscode-icons/` — a **6.7 MB** vendored corpus, refreshed by
  `scripts/vendor-vscode-icons.mjs`. Only the server IDE renders from it. See
  `docs/traps/GREP_ON_SRC_DUMPS_MEGABYTES_OF_ONE_LINE_SVG.md` before searching
  anywhere near it.

## The general rule

Ask which shell owns a file before changing it. A file under `src/components/server/`
affects one deliverable; a file under `src/lib/` affects three, and two of those
three are ones nobody will exercise before you tag a release.
