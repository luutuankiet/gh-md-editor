---
name: repo-maintenance
description: This repo keeps a catalogue of its own traps — failure modes that produce no error, so you find them by symptom, not by stack trace — plus its reference pages and its decision records. Use before debugging behaviour that is wrong but not crashing, before editing shared state, and whenever you finish debugging something that cost more than an hour.
---

# Traps in this repo

Most of what has cost time here fails **silently**. There is no stack trace to
search, so the catalogue below is keyed on **the symptom you would observe**, not
on the subsystem at fault.

**Before you debug anything that misbehaves without erroring, scan this table.**
Then open exactly one file. Each page is self-contained — you will not need to
open a second one.

<!-- BEGIN GENERATED INDEX -- edit the pages, not this block -->

## Traps

Failure modes that produce no error message, indexed by the symptom you
would observe. Read before debugging behaviour that is wrong but not
crashing.

| symptom | page | area | verified |
|---|---|---|---|
| Option+Arrow rings the bell and inserts a stray D or C instead of moving by word | [ALT_ARROW_TYPES_A_LETTER_IN_THE_TERMINAL_INSTEAD_OF_MOVING_BY_WORD](../../../docs/traps/ALT_ARROW_TYPES_A_LETTER_IN_THE_TERMINAL_INSTEAD_OF_MOVING_BY_WORD.md) | terminal / xterm.js | 2026-08-20 |
| the file is committed and on disk, but users report the command is not found | [A_FILE_IS_IN_GIT_BUT_MISSING_FROM_THE_NPM_TARBALL](../../../docs/traps/A_FILE_IS_IN_GIT_BUT_MISSING_FROM_THE_NPM_TARBALL.md) | npm packaging | 2026-08-20 |
| I indexed a markdown file by heading and the list has entries that are not headings | [A_MARKDOWN_HEADING_INDEX_CONTAINS_LINES_THAT_ARE_NOT_HEADINGS](../../../docs/traps/A_MARKDOWN_HEADING_INDEX_CONTAINS_LINES_THAT_ARE_NOT_HEADINGS.md) | repository conventions / searching | 2026-08-20 |
| my scroll handler is registered but never runs, and the saved position is always zero | [A_SCROLL_LISTENER_NEVER_FIRES_AT_ALL](../../../docs/traps/A_SCROLL_LISTENER_NEVER_FIRES_AT_ALL.md) | Svelte effects / diff view | 2026-08-20 |
| driving the editor from a script, the caret lands one line below where I clicked | [A_SYNTHETIC_CLICK_PLACES_THE_CARET_ONE_LINE_OFF](../../../docs/traps/A_SYNTHETIC_CLICK_PLACES_THE_CARET_ONE_LINE_OFF.md) | browser verification | 2026-08-20 |
| I reload the browser and one kind of tab is gone, while every other tab came back | [A_TAB_DISAPPEARS_ON_BROWSER_RELOAD](../../../docs/traps/A_TAB_DISAPPEARS_ON_BROWSER_RELOAD.md) | session persistence | 2026-08-20 |
| a search under src/ returned an enormous unreadable blob and I have no idea what matched | [GREP_ON_SRC_DUMPS_MEGABYTES_OF_ONE_LINE_SVG](../../../docs/traps/GREP_ON_SRC_DUMPS_MEGABYTES_OF_ONE_LINE_SVG.md) | repository layout / searching | 2026-08-20 |
| I saved a file, the editor reported success, and the change is not on disk | [SAVING_A_FILE_THROUGH_A_SYMLINK_SILENTLY_LOSES_THE_EDIT](../../../docs/traps/SAVING_A_FILE_THROUGH_A_SYMLINK_SILENTLY_LOSES_THE_EDIT.md) | server save path | 2026-08-20 |
| the scroll position drifts a little further down the file each time I reopen the tab | [SCROLL_POSITION_WALKS_FURTHER_DOWN_THE_FILE_EVERY_TIME_YOU_REOPEN_A_TAB](../../../docs/traps/SCROLL_POSITION_WALKS_FURTHER_DOWN_THE_FILE_EVERY_TIME_YOU_REOPEN_A_TAB.md) | tab view state / CodeMirror | 2026-08-20 |

## Reference

Simply true, and expensive to re-derive.

| page | summary | verified |
|---|---|---|
| [Stack choices and the numbers behind them](../../../docs/reference/stack-choices.md) | what each layer is, and the measured evidence that picked it over the obvious alternative | 2026-08-20 |
| [Terminal key chords and their byte sequences](../../../docs/reference/terminal-key-chords.md) | the escape sequences the integrated terminal sends for line-editing chords, and the prior art they come from | 2026-08-20 |
| [Terminal ownership and workspace scope](../../../docs/reference/terminal-ownership-and-workspace-scope.md) | how the terminal panel decides which shells belong to the open workspace | 2026-08-20 |

## Decisions

Why the repo is the way it is. A merged decision is immutable -- supersede
it with a new one rather than editing it.

- [No coupled scroll between the editor and the preview](../../../docs/adr/0001-no-coupled-scroll-between-editor-and-preview.md)
- [A broken worktree link is detected and blocked, never repaired](../../../docs/adr/0002-worktree-links-are-detected-never-repaired.md)
- [One git repository anchor, chosen once, shared by every panel](../../../docs/adr/0003-one-git-anchor-shared-by-every-git-panel.md)
- [A published documentation catalogue replaces the private journal](../../../docs/adr/0004-a-published-docs-catalogue-replaces-the-private-journal.md)

<!-- END GENERATED INDEX -->

The same tables, browsable, are [docs/README.md](../../../docs/README.md).

## Adding a trap

Write one when you have just spent real time on something that would have taken
minutes if someone had told you. Three tests, all must pass:

1. **It has a symptom.** If a fact is merely true, it is reference, not a trap.
   *If it has a symptom it is a trap; if it is just true it is reference.*
2. **Nothing cheaper catches it.** A doc is the *last* resort, because it only
   works if someone reads it. Stop at the first rung that holds:

   | rung | use when | this repo |
   |---|---|---|
   | make it a **type error** | the mistake is expressible in the type system | `npm run check` (`svelte-check`) |
   | make it a **test** | the mistake is an assertable behaviour | **there is no test runner** |
   | **comment at the site** | there is exactly one line where someone could get it wrong | yes, and load-bearing — see the header of `scripts/ship.sh`, or the `resolveSafe` comment in `server/index.mjs` |
   | **a doc** | the mistake can be made from any of several files, or from a file that does not exist yet | the catalogue above |

   Before adding one, say out loud which single line you would have commented
   instead — if you can name it, comment it and stop.
3. **It is not already in the table.** Extend the existing file. Two docs on one
   fact is how a catalogue rots.

Then:

- **Filename is the identifier.** `SCREAMING_SNAKE.md`, describing the symptom,
  not the fix. It is quoted in code comments and commit messages, so it never
  gets renamed — if the understanding changes, edit the body.
- **`symptom:` is the search key.** The string a frustrated person would paste
  into a search box, not a topic name. If the console prints something, put the
  console text verbatim.
- **Date it.** `verified:` is the day someone last confirmed it in the running
  code. An undated trap is a claim with no expiry.
- **Regenerate the index**: `bash scripts/gen-docs-index.sh`. The block above is
  generated; hand edits to it are overwritten.

## Writing the body

The reader is a maintainer six months from now who opened this one file from a
search result and has **no other context loaded**. Not you, not this session.

- Resolve every reference inline. No "see the other doc", no ticket numbers, no
  "as discussed". If a line number matters, quote the code.
- Publishing tone. It is a page on the project's documentation site, not a note
  to self.
- Lead with the symptom, then the mechanism, then the fix, then how to verify.
  Someone in the middle of a bug reads the first two lines and stops.
- Include the **evidence** — measured numbers, observed values, verbatim code. A
  trap without evidence gets argued with.
- **Say what is deliberate.** Half of what looks like a bug in a mature codebase
  is a trade someone made on purpose. Write down which, and what the trade was.

## The other collections

`docs/` holds five kinds of page, all generated into the same index by the same
script, all governed by the rules above:

| directory | what belongs there | frontmatter |
|---|---|---|
| `docs/traps/` | it has a symptom | `symptom`, `area`, `verified` |
| `docs/architecture/` | where behaviour lives — one page per area | `title`, `covers`, `verified` |
| `docs/reference/` | simply true, no symptom, worth not re-deriving | `title`, `summary`, `verified` |
| `docs/adr/` | **why the repo is the way it is** — a decision record | none; the `# ` heading is the entry |
| `docs/*.md` | a long-form guide belonging to no single area | `title`, `summary`, `verified` |

The architecture pages are the `codebase-map` skill's index; read that skill
before adding one. The escalation ladder does **not** apply to them — a map is not
a warning. Everything else does: date it, resolve references inline, regenerate
the index.

### Decision records

`docs/adr/NNNN-kebab-slug.md`, sequential, created lazily. Offer one only when
**all three** hold:

1. **hard to reverse** — if it is easy to reverse, skip it; you will just reverse it
2. **surprising without context** — otherwise the code explains itself
3. **the result of a real trade-off** — if there was no genuine alternative, there
   is nothing to record beyond "we did the obvious thing"

One to three sentences is a complete record: the context, what was decided, why.

**A merged record is immutable.** Superseding means a *new* file that names what
it replaces; the old one stays readable, because the reason a decision was made is
not invalidated by the decision changing.

This is the one destination that is append-only and unrecoverable. A trap can be
rewritten later; a rationale never written is gone.

## Removing a trap

**Before trusting a page, check it is still true.** These describe code, and code
moves. If the underlying cause is fixed, **delete the file** and say so in the
commit message. Do not leave it with a "fixed in vX" note — a stale trap costs a
reader the same time as a real one, and costs the catalogue its credibility, which
is the only thing making anyone open the next page. If the fix came with a comment
at the site, that comment is now the record.
