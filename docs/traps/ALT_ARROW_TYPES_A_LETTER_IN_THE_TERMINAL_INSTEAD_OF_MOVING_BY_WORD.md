---
symptom: "Option+Arrow rings the bell and inserts a stray D or C instead of moving by word"
area: terminal / xterm.js
verified: 2026-08-20
---

# Alt+Arrow types a letter in the terminal instead of moving by word

## Symptom

In an integrated terminal, Option/Alt+Left or Alt+Right rings the bell and leaves a
literal `D` or `C` on the command line. Alt+Delete does the same with a `~`. It
worked before and no local code changed.

## Mechanism

This is an **inherited upstream change, not a local regression**. xterm.js 6.0.0
removed the Alt-to-word-motion translation it had carried since 2016. The
maintainer position is that the **embedder** owns keybindings now.

So the emulator faithfully emits `\e[1;3D`, zsh has nothing bound to it, ZLE rings
the bell, and the trailing `D` self-inserts. Alt+Delete is the identical class:
`\e[3;3~` is unbound, so you get a bell and a literal `~`.

## Fix

Remap client-side in `src/components/server/TerminalView.svelte` via
`attachCustomKeyEventHandler`, **not** with a shell `bindkey` — an rc edit does not
travel with the npm package.

`TerminalView.svelte` is the one place both the `Terminal` instance and its
websocket are in scope, which is why remapping installs there and nowhere else.

Three contract details, each of which silently breaks the handler:

1. **The handler also fires on `keyup` and `keypress`.** Filter `ev.type !== 'keydown'`
   or one keypress sends its bytes three times.
2. **Returning `false` makes xterm bail *before* its own `preventDefault`.** The
   handler owns cancellation from that point.
3. **Match on `event.code`, not `event.key`** — macOS composes Option+letter into a
   symbol, so `event.key` is not the letter you pressed.

Related: `Ctrl+U` sends `\e-` followed by `^K`, so delete-to-line-start behaves
identically under bash and zsh.

## How to verify

Press the chord and read the line, not the console. A working remap moves the
cursor and leaves no character behind.

Do not test inside tmux — see below.

## What is deliberate here

Every remap gates on `term.buffer.active.type === 'normal'` so full-screen programs
keep their own keymaps. The accepted cost is that **tmux holds the alternate buffer
for its entire session**, so the remap is inert inside tmux. That is the trade, not
a bug.

`Cmd+Left` / `Cmd+Right` still emit nothing, for a different reason: xterm's key
evaluator does `if (ev.metaKey) break;` for arrow keycodes, so the event escapes to
the browser without `preventDefault`. Sending `\x01` / `\x05` from the existing
chord map would close it.

If the chord table passes roughly six entries, lift it to `src/lib/terminal-chords.ts`.

## The general rule

When a terminal emits bytes nobody bound, you get a bell and a stray character, never
an error. Fix it at the layer that ships with your artifact — a shell configuration
change fixes your machine and nobody else's.
