# Documentation

Every page here is written for a maintainer six months from now who opened
exactly this file from a search result and has nothing else loaded.

This index is generated. Run `scripts/gen-docs-index.sh` after adding or
renaming a page; `--check` fails if it is stale.

<!-- BEGIN GENERATED INDEX -- edit the pages, not this block -->

## Where things live

One page per area of the system. Read before going looking for where
something is implemented.

| page | covers | verified |
|---|---|---|
| [Release and delivery](architecture/release-and-delivery.md) | which manifest publishes what, what a v* tag triggers, and how a running server upgrades itself | 2026-08-20 |
| [The server HTTP surface](architecture/server-http-surface.md) | where an API handler lives in server/index.mjs, how paths are made safe, and how symlinks are classified | 2026-08-20 |
| [Source-line mapping and reveal-counterpart](architecture/source-line-mapping.md) | how a preview element knows which markdown line produced it, and why the panes do not scroll together | 2026-08-20 |
| [Tab lifecycle and per-tab view state](architecture/tab-lifecycle-and-view-state.md) | why state kept in a tab component disappears when you switch tabs, and where to put it instead | 2026-08-20 |
| [Two shells, one source tree](architecture/two-shells-one-repo.md) | which components belong to the browser editor, which to the server IDE, and why a change in src/lib touches both | 2026-08-20 |

## Traps

Failure modes that produce no error message, indexed by the symptom you
would observe. Read before debugging behaviour that is wrong but not
crashing.

| symptom | page | area | verified |
|---|---|---|---|
| Option+Arrow rings the bell and inserts a stray D or C instead of moving by word | [ALT_ARROW_TYPES_A_LETTER_IN_THE_TERMINAL_INSTEAD_OF_MOVING_BY_WORD](traps/ALT_ARROW_TYPES_A_LETTER_IN_THE_TERMINAL_INSTEAD_OF_MOVING_BY_WORD.md) | terminal / xterm.js | 2026-08-20 |
| the file is committed and on disk, but users report the command is not found | [A_FILE_IS_IN_GIT_BUT_MISSING_FROM_THE_NPM_TARBALL](traps/A_FILE_IS_IN_GIT_BUT_MISSING_FROM_THE_NPM_TARBALL.md) | npm packaging | 2026-08-20 |
| I indexed a markdown file by heading and the list has entries that are not headings | [A_MARKDOWN_HEADING_INDEX_CONTAINS_LINES_THAT_ARE_NOT_HEADINGS](traps/A_MARKDOWN_HEADING_INDEX_CONTAINS_LINES_THAT_ARE_NOT_HEADINGS.md) | repository conventions / searching | 2026-08-20 |
| my scroll handler is registered but never runs, and the saved position is always zero | [A_SCROLL_LISTENER_NEVER_FIRES_AT_ALL](traps/A_SCROLL_LISTENER_NEVER_FIRES_AT_ALL.md) | Svelte effects / diff view | 2026-08-20 |
| driving the editor from a script, the caret lands one line below where I clicked | [A_SYNTHETIC_CLICK_PLACES_THE_CARET_ONE_LINE_OFF](traps/A_SYNTHETIC_CLICK_PLACES_THE_CARET_ONE_LINE_OFF.md) | browser verification | 2026-08-20 |
| I reload the browser and one kind of tab is gone, while every other tab came back | [A_TAB_DISAPPEARS_ON_BROWSER_RELOAD](traps/A_TAB_DISAPPEARS_ON_BROWSER_RELOAD.md) | session persistence | 2026-08-20 |
| a search under src/ returned an enormous unreadable blob and I have no idea what matched | [GREP_ON_SRC_DUMPS_MEGABYTES_OF_ONE_LINE_SVG](traps/GREP_ON_SRC_DUMPS_MEGABYTES_OF_ONE_LINE_SVG.md) | repository layout / searching | 2026-08-20 |
| I saved a file, the editor reported success, and the change is not on disk | [SAVING_A_FILE_THROUGH_A_SYMLINK_SILENTLY_LOSES_THE_EDIT](traps/SAVING_A_FILE_THROUGH_A_SYMLINK_SILENTLY_LOSES_THE_EDIT.md) | server save path | 2026-08-20 |
| the scroll position drifts a little further down the file each time I reopen the tab | [SCROLL_POSITION_WALKS_FURTHER_DOWN_THE_FILE_EVERY_TIME_YOU_REOPEN_A_TAB](traps/SCROLL_POSITION_WALKS_FURTHER_DOWN_THE_FILE_EVERY_TIME_YOU_REOPEN_A_TAB.md) | tab view state / CodeMirror | 2026-08-20 |

## Reference

Simply true, and expensive to re-derive.

| page | summary | verified |
|---|---|---|
| [Stack choices and the numbers behind them](reference/stack-choices.md) | what each layer is, and the measured evidence that picked it over the obvious alternative | 2026-08-20 |
| [Terminal key chords and their byte sequences](reference/terminal-key-chords.md) | the escape sequences the integrated terminal sends for line-editing chords, and the prior art they come from | 2026-08-20 |
| [Terminal ownership and workspace scope](reference/terminal-ownership-and-workspace-scope.md) | how the terminal panel decides which shells belong to the open workspace | 2026-08-20 |

## Decisions

Why the repo is the way it is. A merged decision is immutable -- supersede
it with a new one rather than editing it.

- [No coupled scroll between the editor and the preview](adr/0001-no-coupled-scroll-between-editor-and-preview.md)
- [A broken worktree link is detected and blocked, never repaired](adr/0002-worktree-links-are-detected-never-repaired.md)
- [One git repository anchor, chosen once, shared by every panel](adr/0003-one-git-anchor-shared-by-every-git-panel.md)
- [A published documentation catalogue replaces the private journal](adr/0004-a-published-docs-catalogue-replaces-the-private-journal.md)

<!-- END GENERATED INDEX -->
