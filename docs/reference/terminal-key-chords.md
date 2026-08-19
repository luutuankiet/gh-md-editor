---
title: Terminal key chords and their byte sequences
summary: the escape sequences the integrated terminal sends for line-editing chords, and the prior art they come from
verified: 2026-08-20
---

# Terminal key chords and their byte sequences

Since xterm.js 6.0.0, the **embedder** owns keybindings — upstream removed its 2016
Alt-to-word-motion translation and flagged the change as breaking, with release
wording to the effect that you will need to add keybindings in your own code.

This repository does that in `src/components/server/TerminalView.svelte`, in a chord
table consumed by `attachCustomKeyEventHandler`.

## Byte table

| chord | bytes | effect |
|---|---|---|
| Option/Alt + Left | `\eb` | back one word |
| Option/Alt + Right | `\ef` | forward one word |
| Option/Alt + Delete | `\ed` | delete word forward |
| Ctrl + A | `\x01` | start of line |
| Ctrl + E | `\x05` | end of line |
| Ctrl + U | `\e-` then `^K` | delete to start of line, identically under bash and zsh |

On platforms other than macOS the word-motion equivalents are `\e[1;5D` and
`\e[1;5C`.

## Prior art

Two independent implementations agree on this table, which is why it is worth
copying rather than deriving:

- **VS Code**, in its `sendSequence` keybinding contribution
  (`src/vs/workbench/contrib/terminalContrib/sendSequence/browser/terminal.sendSequence.contribution.ts`)
  — the same fix, on the same library.
- **iTerm2**, in its Natural Text Editing preset (`plists/PresetKeyMappings.plist`)
  — the canonical byte table for Option and Command line-editing chords.

## Handler semantics

`attachCustomKeyEventHandler` is documented in xterm's own typings
(https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts). Three
properties decide whether a remap works:

- it fires on **keydown, keyup and keypress** — filter on `keydown`
- returning `false` makes xterm bail **before** its own `preventDefault`, so the
  handler owns cancellation
- match on `event.code`; macOS composes Option+letter into a symbol, so `event.key`
  is not the key you pressed

Gate every remap on `term.buffer.active.type === 'normal'` so full-screen programs
keep their own keymaps.

Background on the upstream change: xterm.js PR #5346
(https://github.com/xtermjs/xterm.js/pull/5346) and the v6.0.0 release notes
(https://github.com/xtermjs/xterm.js/releases/tag/6.0.0).
