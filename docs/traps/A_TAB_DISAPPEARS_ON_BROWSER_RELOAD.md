---
symptom: "I reload the browser and one kind of tab is gone, while every other tab came back"
area: session persistence
verified: 2026-08-20
---

# A tab disappears on browser reload

## Symptom

Every open tab is restored after a reload except one *kind* — every commit-graph
tab, say, or every merge tab. No error in the console, no toast. The tab simply is
not there.

## Mechanism

Session save and session restore are **two independent, hand-maintained field
lists**:

- `sessionSnapshot()` — `src/components/App-server.svelte:916`
- `restoreSession()` — `src/components/App-server.svelte:970`

They must agree, and nothing enforces that they do. Measured twice on the same
codebase: `restoreSession()` already carried a `st.kind === 'graph' && st.graph`
branch, but `sessionSnapshot()` had never been given the field to feed it. Every
graph tab therefore fell through to the generic disk-fetch branch, requested a file
literally named `gmd-graph:<repo>`, got a 404, and was dropped. Merge tabs were
absent from **both** sides.

The 404 is the giveaway: the restore path treats an unrecognised tab as a file on
disk, and a tab whose path is a synthetic key is never on disk.

## Fix

**Adding a tab `kind` means editing both lists.** Add the field to the snapshot and
the matching branch to the restore, in the same change. There is no shared schema
to lean on; the only defence is knowing the pair exists.

## How to verify

Open one tab of each kind, reload the browser, and count them back. Do not test by
seeding `localStorage` by hand and reloading — `beforeunload` calls
`saveSessionNow()`, which overwrites `ghmd.session:<folder>` at unload, so your
seeded value is clobbered *before* the reload reads it.

## What is deliberate here

Restoring a merge tab is safe even if the conflict was resolved elsewhere in the
meantime. `MergeTab.load()` re-derives all three sides from git's index on every
mount and sets a plain notice when stages 2 and 3 are both absent — so you get the
working copy with an explanation, never a fabricated three-way view.

Similarly, the graph tab stores the commit **sha** and re-fetches the commit body,
never caching it. A cached copy would outlive the amend or rebase that invalidated
it; the refetch is one local socket round-trip. A sha that no longer resolves closes
the pane silently rather than reporting an error nobody asked for.

## The general rule

When serialisation and deserialisation are written as two literal field lists,
treat them as one edit site with two locations. If you are adding a case to one and
did not open the other in the same change, the feature is already broken.
