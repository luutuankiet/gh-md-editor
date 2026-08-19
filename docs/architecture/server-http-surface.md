---
title: The server HTTP surface
covers: where an API handler lives in server/index.mjs, how paths are made safe, and how symlinks are classified
verified: 2026-08-20
---

# The server HTTP surface

`server/index.mjs` is **3,719 lines**, roughly 150 KB, and holds around sixty
`apiXxx` handlers — the entire HTTP surface of the server IDE. It is published to
npm **unbundled**, so what you edit is literally what users execute.

**Never read this file whole.** At roughly 37,000 tokens it is the single most
expensive read in the repository. Grep the handler name instead and read the
range around it.

## Line anchors

Starting points, not addresses. Jump roughly there, confirm by what the code says,
and if a range is off by more than a screen, fix the number here and re-date this
page.

| symbol | line | what it is |
|---|---|---|
| `resolveSafe` | 211 | the path jail every handler funnels through |
| `apiTree` | 303 | the explorer tree |
| `apiBrowse` | 352 | directory listing for the workspace browser |
| `commitTemp` | 459 | the atomic-save write path |
| `apiDownload` | 671 | zip export, walks a subtree |

## `resolveSafe` is a lexical jail, not a real one

It is built on `path.resolve`, never `realpath`. It stops `../` traversal by
string arithmetic and nothing else. Two consequences that read as bugs and are
not:

- **An absolute path bypasses it by design.** The server is single-user on a
  trusted network; the jail exists to stop a malformed relative path, not an
  adversary.
- **It cannot see through a symlink**, because resolving links is exactly what it
  does not do. Anything that needs the real target must call `realpath` itself —
  which is why `commitTemp` does, and why it has to.

## Symlink policy is uniform at the boundary

`readdir` reports `lstat` types, so before v0.25.7 a symlinked directory arrived
at the client as a third entry shape the explorer had no branch for. The fix was
placed **entirely server-side**, at the boundary, and required zero client change:

- `apiTree` and `apiBrowse` classify a link by **what it points at** and emit
  `dir` or `file` plus a separate `link: true` flag.
- `commitTemp` resolves the final hop before `rename`. Renaming onto a link
  **replaces the link** and loses the edit silently — see
  `docs/traps/SAVING_A_FILE_THROUGH_A_SYMLINK_SILENTLY_LOSES_THE_EDIT.md`.
- `apiDownload` resolves the *selection* but the walk still refuses links met
  along the way, so a loop or an out-of-workspace escape cannot be zipped.
- All five ripgrep spawns pass `--follow`.

The client gates almost every behaviour on `type === 'dir'` — chevron, expand,
arrow keys, paste target, terminal-here, zip. Collapsing the third shape at the
server fixed all of them at once. That is the pattern to repeat: **normalise the
shape where it enters, not at each of twenty consumers.**

## Scope is a parameter, never a re-derivation

`?folder=` is the anchored workspace, root-relative, empty string meaning the whole
served root. `src/components/App-server.svelte` derives it once (around line 59)
and it is authoritative. Anything that searches must **receive** it.

The three lookup endpoints — `/api/defs`, `/api/refs`, `/api/refcounts` — all take
`path=<scope>`. Before v0.25.8, `/api/defs` sent no path at all and so answered
go-to-definition from the whole served root, returning symbols out of sibling
checkouts; `refs` and `refcounts` guessed the workspace from the open file's first
path segment, which is right only when the workspace sits exactly one level below
the served root.

One call site is still unscoped: `src/components/server/MergeTab.svelte:510`
renders `<CodeTab>` with `gitPath=""` and **no `folder`**, so its lookups fall back
to `'.'`.

## The general rule

The server owns normalisation. When a filesystem concept has more shapes than the
client has branches, collapse it at the handler — and pass scope down explicitly
rather than letting each consumer infer it, because every consumer will infer it
slightly differently.
