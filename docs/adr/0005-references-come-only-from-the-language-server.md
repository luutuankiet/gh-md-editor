# References come only from the language server

The "N references" lens, Find All References (Shift+F12) and the references peek
ask the language server (`textDocument/references`) and nothing else. There is no
text-search fallback: with no server running for the file, the lens does not show
and Find All References has nothing to return.

Verified: 2026-11-12, against `src/lib/lsp/lens.ts` and `src/lib/lsp/actions.ts`.

## The two counts differ on purpose

The lens asks with `includeDeclaration: false` (`src/lib/lsp/lens.ts`), and Find
All References asks with `true` (`src/lib/lsp/actions.ts`), as VS Code does. So a
function used three times shows "3 references" on its lens, and Find All References
lists 4 entries: the three uses plus the definition. The lens peek opens exactly the
entries it counted. Do not "fix" the two to agree.

## Considered options

**Keeping the ripgrep fallback** was rejected. It counted every textual match of
the name: comments, strings, other symbols with the same name, and both of two
same-named methods in one file. The counts looked authoritative and were often
wrong, which is worse than no count. It also disagreed with what Find All
References returned once a server was running.

**Showing the lens from text search until the server is ready** was rejected for
the same reason. Instead the lens retries until the server answers, and re-asks
when a count comes back empty during indexing.

## Cost

A file with no language server running gets no lens and no references at all.
Starting a server is one click, and nothing heavy starts on its own.
