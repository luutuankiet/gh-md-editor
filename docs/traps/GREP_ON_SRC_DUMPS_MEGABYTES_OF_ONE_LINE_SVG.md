---
symptom: "a search under src/ returned an enormous unreadable blob and I have no idea what matched"
area: repository layout / searching
verified: 2026-08-20
---

# Grep on `src/` dumps megabytes of one-line SVG

## Symptom

An ordinary search under `src/` returns a wall of minified markup. There is no
error; the search "worked". It just cost more than the rest of the session.

## Mechanism

`src/lib/vscode-icons/` is a **6.7 MB vendored corpus**, and its contents are
nearly all on single lines. A line-oriented tool that matches anywhere in a line
prints the whole line.

| file | shape |
|---|---|
| `src/lib/vscode-icons/icons/` | ~1,220 SVGs, nearly all one line each. The worst is `file_type_lerna.svg` at **219,771 bytes on line 1** |
| `src/lib/vscode-icons/manifest.json` | **136,819 bytes across 2 lines** — roughly 68 KB per line |

One incidental match in the manifest costs more than reading the entire server.

## Fix

Never search `src/` unglobbed.

- Pass a glob: `--glob '*.svelte'`, `--glob '*.ts'`
- Or exclude explicitly: `--glob '!**/vscode-icons/**'`
- Query the manifest with `jq`. Never read it, never grep it.

The same reflex applies to the other large files in this repository:
`server/index.mjs` is ~3,719 lines and should be reached by grepping a handler name
and reading the range around it, never read whole.

## How to verify

`du -sh src/lib/vscode-icons` — if it still reads in megabytes, the trap is live.
Refreshing the corpus is `scripts/vendor-vscode-icons.mjs`; it is expected to be
large, and shrinking it is not the fix.

## The general rule

In a repository with vendored assets, the unit of cost is the **line**, not the
file. Before searching a tree you have not searched before, find out whether
anything in it is minified — one 200 KB line is indistinguishable from a hundred
files until it lands in front of you.
