---
symptom: "the scroll position drifts a little further down the file each time I reopen the tab"
area: tab view state / CodeMirror
verified: 2026-08-20
---

# Scroll position walks further down the file every time you reopen a tab

## Symptom

You restore a saved scroll position and it is *nearly* right. Reopen the tab and
it is slightly lower. Reopen again, lower still. Measured across four rebuilds of
one merge view, as a fraction of the scrollable span:

```
0.5544 → 0.5650 → 0.5744 → 0.5881
```

Roughly 1% per remount, compounding. Nothing errors. Each individual restore looks
like a rounding artefact.

## Mechanism

Two facts combine.

**First: CodeMirror's `scrollHeight` starts as an estimate and shrinks.** On mount
it guesses line heights, then replaces the guesses with measurements as lines are
actually laid out. One reference pane measured `9659` immediately after mount and
`8669` once settled, with `clientHeight` constant at `327`.

**Second: the restore was reading its own writes back.** Applying
`fraction × span` against the *inflated* span lands too far down the document.
Reading that pixel position back once the span has *settled smaller* yields a
**larger** fraction. Save that, and the next restore starts from a worse number.

It is a feedback loop, which is why it compounds instead of just being wrong once.

## Fix

Two changes, both required — either alone leaves the loop half-open.

1. **Keep re-applying until the height stops moving.** The restore loop re-applies
   the fraction every 60 ms and stops only when `scrollHeight` is unchanged across
   two consecutive passes, so the final write lands against the settled height.
2. **Block the save path for the whole restore window.** A `restoring` flag gates
   the save branch for the entire loop plus 200 ms, so the restore cannot observe
   its own writes.

Live in `restorePanes()` in `src/components/server/MergeTab.svelte`.

## How to verify

Remount the tab five times and reload the browser twice, reading the stored
fraction each time. It must be **byte-identical** on every read — after the fix,
`0.5544363480497214` on all seven, deviation `0.0000`. A drift of `0.001` is not
"close enough"; it is the loop still running, just slower.

Review will not catch this. It needs a browser actually driving the app, because
the defect only exists in the gap between an estimated layout and a settled one.

## What is deliberate here

The editable result pane is **not** covered by the fraction mechanism. It restores
from a `{line, off}` document anchor inherited from the inner `<CodeTab>`, because
an anchor survives wrap and font-size changes that a fraction drifts under. Where
two mechanisms overlap, the more accurate one wins — and two mechanisms racing one
element is the bug, not the fix.

## The general rule

Any restore that reads back the same quantity it writes is a feedback loop waiting
for a measurement to change under it. Gate the save path for the duration of a
restore, and settle against a quantity that has stopped moving — never against one
the framework is still refining.
