---
symptom: "my scroll handler is registered but never runs, and the saved position is always zero"
area: Svelte effects / diff view
verified: 2026-08-20
---

# A scroll listener never fires at all

## Symptom

You attach a scroll listener, the code plainly runs, and the handler never fires
once for the entire life of the tab. The persisted position is always `0`, so it
reads as a persistence bug rather than a registration one.

## Mechanism

**Effect ordering.** In `src/components/server/DiffTab.svelte` the scroll-saving
effect was attached to an element created by a *different* effect declared roughly
480 lines further down the file. Svelte runs effects in declaration order, so the
listener ran first, found nothing to attach to, and was never retried. It was not
"attached and silent" — it was never installed at all.

Three things arrive at three different times here, and they arrive in this order:
the container element, the editor the builder effect creates inside it, and the
diff payload from the server.

## Fix

Attach to the **container** in the **capture phase**, not to the inner element in
the bubble phase. The container exists from the first render; capture-phase
listening sees scroll events from descendants that did not exist when the listener
was installed.

The second half is a gate: restore must wait on `docsVersion > 0` or it spends its
whole retry budget before the document exists.

## How to verify

Scroll, then read the persisted value — not the presence of the listener. A
`console.log` inside the handler that never prints is the actual diagnostic; a
registered-but-never-invoked listener looks identical to a working one from the
outside.

## What is deliberate here

`scroller()` (around line 376) is the single authority for which element owns the
overflow. In split mode that is the merge container, **not** an inner editor —
reading `scrollTop` off an inner element persists a zero over a good position. Ask
`scroller()` rather than picking an element.

Hunks mode has no scroll restore at all. Its gate requires an editor generation
that hunks mode never produces. That is a known gap, not a broken listener.

## The general rule

A listener attached to an element another effect creates is a race you will lose
about half the time and never notice the other half. Attach to the outermost
element that already exists and let capture-phase propagation do the rest.
