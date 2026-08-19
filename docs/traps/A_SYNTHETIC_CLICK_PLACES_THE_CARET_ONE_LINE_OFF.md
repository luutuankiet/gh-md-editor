---
symptom: "driving the editor from a script, the caret lands one line below where I clicked"
area: browser verification
verified: 2026-08-20
---

# A synthetic click places the caret one line off

## Symptom

You are verifying editor behaviour by driving the page from injected JavaScript.
Clicks place the caret one line lower than the target. Counting `.cm-cursor`
elements in the DOM confirms the off-by-one. It looks like a real defect in caret
placement.

It is not. Two full verification passes were spent on this phantom.

## Mechanism

Two independent things conspire.

**CodeMirror ignores `event.detail` in Gecko** and derives click count from time and
distance instead. Repeated synthetic clicks at one point within roughly a second are
therefore **promoted to double- and triple-clicks**, even though each event you
dispatched claimed to be a single click.

**A line-click produces `range(line.from, line.to + 1)`** — and the head of that
range is the **start of the next line, at column 0**. So a promoted triple-click
reports a position one line down, exactly as though placement were off by one.

The DOM makes it worse rather than better: counting cursor elements hides the
distinction entirely.

## Fix

Do not measure CodeMirror by synthetic click.

- Place the caret programmatically:
  `view.dispatch({ selection: { anchor: <pos> } })`
- Read the result from `view.state.selection.ranges`, **never** from the DOM.
- If you must click, leave more than 1.3 s between clicks that need to stay single.

Getting the view from page JavaScript:

```js
document.querySelector('.cm-content').cmTile.view
```

`.cmView` does **not** exist in this build. Open a file programmatically with:

```js
window.dispatchEvent(new CustomEvent('gmd:open-request',
  { detail: { kind: 'file', path: '<root-relative path>' } }))
```

## How to verify

Assert against editor state, not rendered elements. If your assertion reads the DOM,
you are measuring the rendering of the thing rather than the thing.

## Neighbouring traps in the same harness

- **Synthetic keydown into xterm drops space** — keycode 32 fails xterm's
  `keyCode >= 48` branch. Use a comma instead; it is absent from zsh's default
  `WORDCHARS` and so is a real word separator.
- **Paste injection silently does nothing** — the browser ignores `clipboardData` on
  a synthetic `ClipboardEvent`.
- **`document.querySelector('.xterm textarea')` may grab a hidden terminal** when
  several sessions exist. Enumerate and pick by `offsetParent`.
- **Clicking the terminal panel's own New terminal button while the panel is
  CSS-hidden bypasses the boot path** and is not a reachable user state. Dispatch the
  `Ctrl+Shift+backquote` keydown on `window` instead.
- A different dev-server port is a different `localStorage` origin — a free way to
  force a fresh boot state without clearing storage.

## The general rule

A synthetic event is not a user action; it is an approximation whose divergences are
undocumented and browser-specific. Verify through the application's own state API
wherever one exists, and reserve synthetic input for the cases where the input
handling itself is what you are testing.
