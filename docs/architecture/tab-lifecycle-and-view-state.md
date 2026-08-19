---
title: Tab lifecycle and per-tab view state
covers: why state kept in a tab component disappears when you switch tabs, and where to put it instead
verified: 2026-08-20
---

# Tab lifecycle and per-tab view state

## The shell destroys tabs, it does not hide them

`src/components/App-server.svelte` renders only a group's **active** tab, and it
does so inside a keyed block:

```svelte
{#key g.activePath}        <!-- App-server.svelte:2174 -->
```

Keying on the active path means switching tabs **unmounts the component and builds
a new one**. Anything held in that component's `$state` dies with it. This is not
a leak or a missing save — it is the shell's design, and every tab type has to be
written against it.

So: **any state that must survive a tab switch lives in `src/lib/tab-view-state.svelte.ts`,
not in the component.**

## What the store is

A per-tab override map, roughly 160 lines.

| property | value |
|---|---|
| storage | `localStorage`, key `ghmd.tabview:<folder>` |
| payload | `{ v: 1, order, tabs }` |
| eviction | LRU, 300 entries |
| writes | debounced 300 ms |
| cross-tab | synced via the `storage` event |
| init | `initTabViewState(folder)` at `App-server.svelte:64` |

Fields: `wrap`, `diffView`, `lang`, `anchor` (a `{line, off}` document position),
`px` and `aux` (pixel scroll offsets), `sha` and `folds` (the commit graph),
`frac` and `conflict` (the merge view).

Entries are written **only for tabs actually touched**, so an untouched tab keeps
following the app-wide default and no existing setting moves on upgrade.
`renameTabView` carries state across a Save As.

It is keyed on **file path**, so one file open in two split groups shares one
setting. VS Code keys per group instead. That difference is a parked design
question, not a defect.

## The session snapshot is a second, independent list

Surviving a tab *switch* and surviving a browser *reload* are two different
mechanisms, and this is where the trap is:

- `sessionSnapshot()` — `App-server.svelte:916`
- `restoreSession()` — `App-server.svelte:970`

They are **two hand-maintained field lists that must agree**. Adding a tab `kind`
means editing both, or the tab vanishes silently on reload. See
`docs/traps/A_TAB_DISAPPEARS_ON_BROWSER_RELOAD.md`.

`beforeunload` calls `saveSessionNow()`, overwriting `ghmd.session:<folder>` at
unload — so seeding that key by hand and then reloading is clobbered before the
reload happens.

Tab path keys double as view-state keys: `gmd-graph:<repo>`, `gmd-merge:<repo>:<path>`,
`gmd-diff:...`, `gmd-cmp:...`.

## Restoring is harder than saving, and always retries

`src/lib/cm-scroll-anchor.ts` (~90 lines) exists because CodeMirror's own
`scrollSnapshot()` is not serialisable and cannot go in `localStorage`. It offers a
`{line, off}` anchor plus `restoreScrollTop(resolve, px, tries = 25)` — a
growth-retrying pixel restore on a 60 ms interval, a 1.5 s ceiling, returning a
cancel function.

The retry is load-bearing. A folded merge view and a rendered markdown article both
keep growing for several frames after mount, so a single early assignment clamps to
whatever the height was at that instant.

Two guards recur across tab types and both matter: a **one-shot placed flag**, so a
freshly clicked item does not inherit a restored offset; and a **content gate**, so
an offset is not applied over an empty list that has not arrived from the server yet.

## Where each tab type keeps what

| tab | keeps |
|---|---|
| code | `anchor`, `wrap`, `lang` |
| diff | `diffView`, `px` — hunks mode has **no** scroll restore, its gate needs an editor generation hunks mode never produces |
| git graph | `sha`, `folds`, `px` (rows), `aux` (detail pane) — the commit is **re-fetched** from the stored sha, never cached, so an amend between visits shows the commit as it is now |
| merge | `frac` (three read-only panes), `conflict` (selected index); the editable result pane inherits `anchor` from the inner `<CodeTab>` |

## The general rule

In this shell, a component is a rendering of state, never the owner of it. Before
adding a `$state` you expect to still be there later, ask whether a tab switch
would destroy it — the answer is yes — and put it in the store with a `viewKey`.
