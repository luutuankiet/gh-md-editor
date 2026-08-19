---
title: Terminal ownership and workspace scope
summary: how the terminal panel decides which shells belong to the open workspace
verified: 2026-08-20
---

# Terminal ownership and workspace scope

One server can serve several workspaces at once, and one registry of pty sessions
serves all of them. Deciding which shells a given workspace tab may adopt is a
single predicate, and it lives in `src/components/server/TerminalPanel.svelte`:

```js
owns(cwd) === (cwd === folder || cwd.startsWith(folder + '/'))
```

Exact-match when `folder` is the served root.

That one function decides **four** things: adoption, activation, the `drop()`
fallback, and the `mine` fold flag. Change it in one place only — the reason the
panel previously ran commands in the wrong checkout is that these four decisions had
been made separately.

## Two properties that are deliberate

**`GET /api/terminals` is unfiltered.** Scoping is the client's job. A workspace tab
sees every session and folds the ones it does not own; foreign groups stay rendered
and folded, never hidden. Filtering server-side would make a stray session
invisible rather than merely irrelevant.

**Boot fires on first panel *reveal*, not on mount.** The panel is CSS-hidden rather
than conditionally rendered, so a mount-time boot held an unasked-for login shell
open in every tab that had ever been opened.

Never activate a session `owns()` rejects.

## Related

Layout state persists in `localStorage` under `ghmd.layout`.

The server injects `GMD_PORT` into every pty it spawns, so a shell can identify the
server it is running inside — which is what makes a server able to upgrade itself
without reading `/proc`.
