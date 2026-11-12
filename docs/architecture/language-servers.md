---
title: Language servers (LSP bridge and client)
covers: where hover, completion, diagnostics, go-to-definition and references from a real language server come from, what the node bridge does to the messages, and how a code tab attaches
verified: 2026-11-12
---

# Language servers (LSP bridge and client)

Language servers are **opt-in**. Nothing starts on its own: the user starts one
per (kind, folder) from the Language Servers panel or the command palette, and it
lives until Stop or until the node process exits. The browser runs the stock
`@codemirror/lsp-client` (pinned at `6.3.0`); everything that client cannot do is
done by a bridge in `server/index.mjs`.

## Where it lives

| file | symbol / line | what it is |
|---|---|---|
| `server/index.mjs` | `LSP_KINDS` ~3439 | the three kinds, their binaries and their download fallback |
| `server/index.mjs` | `lspAnswerServerRequest` ~3625 | answers the server's own requests |
| `server/index.mjs` | `lspSchedulePull` ~3660 | pull-to-push diagnostics, TypeScript 7 only |
| `server/index.mjs` | `lspFromServer` ~3685, `lspFromBrowser` ~3715 | the two directions of the bridge |
| `server/index.mjs` | `lspStart` ~3770, `lspStop` ~3854 | spawn, and shutdown → exit → SIGTERM → SIGKILL |
| `server/index.mjs` | `lspWss.on('connection')` ~3987 | the WebSocket data plane and socket takeover |
| `src/lib/lsp-control.ts` | `startLanguageServer` | the POST, the download confirm, the `gmd:lsp-changed` event |
| `src/components/server/LspPanel.svelte` | | the bottom panel: list, memory, Stop |
| `src/lib/lsp/client.ts` | `refreshServers`, `lspFor`, `attach` | one `LSPClient` per running server, for the whole page |
| `src/lib/lsp/actions.ts` | `lspDefinition`, `lspReferences` | requests the editor makes itself, 4 s timeout |
| `src/lib/lsp/error-lens.ts` | `errorLens`, `lineHasDiagnostic` | inline diagnostics after the line end |
| `src/lib/lsp/peek-def.ts` | `showDefPeek` | Peek Definition block under the line |
| `src/components/server/CodeTab.svelte` | `lspCompartment` ~1131 | per-tab attach |

## The bridge (server)

**Kinds.** `tsgo` is TypeScript 7 (`tsc --lsp --stdio`; a local `tsc` only counts
if `tsc --version` reports 7 or later), `ty` is `ty server`, `basedpyright` is
`basedpyright-langserver --stdio`. Resolution is `<folder>/node_modules/.bin`,
then `PATH`. When neither has it, `POST /api/lsp` answers `409 {needsDownload,
command}` with the `npx` or `uvx` line it would run, and the browser asks before
retrying with `allowDownload: true`.

**Routes.** `GET /api/lsp` lists servers with resident memory of the whole
process tree; `POST /api/lsp {kind, folder, allowDownload?}` starts one (a second
POST for the same kind and folder gets the running entry); `DELETE
/api/lsp?id=` stops it. The WebSocket upgrade on `/api/lsp?id=` carries one
JSON-RPC body per text message, with the same auth as `/api/pty`.

**`initialize` patching.** The first `initialize` is forwarded with
`workspace.configuration` and `workspace.workspaceFolders` forced on, the served
folder as the only workspace folder, and `textDocument.diagnostic` **deleted**,
because ty and basedpyright stop pushing diagnostics when the client advertises
pull support. Later attaches get the cached result and their `initialized` is
swallowed: a server accepts only one `initialize`.

**Server requests are answered by the bridge,** because the stock client refuses
all of them. `workspace/configuration` gets `null` per item, except basedpyright's
`python.analysis` and `basedpyright.analysis`, which get an `exclude` list;
`workspace/workspaceFolders` gets the root; registration and progress requests get
`null`. `workspace/applyEdit` and `window/showMessageRequest` are forwarded to the
browser.

**Pull to push, TypeScript 7 only.** TS 7 answers only `textDocument/diagnostic`;
the client only renders `textDocument/publishDiagnostics`. For `tsgo`, 400 ms
after a `didOpen` or `didChange` settles, the bridge sends its own pull (ids
`bridge-<n>`) and turns the result into a push. ty and basedpyright also
advertise `diagnosticProvider`, but they push as well, so pulling for them would
show every diagnostic twice.

**Gitignore filter.** At start the bridge lists ignored directories with `git
ls-files --others --ignored --exclude-standard --directory`. Results of
definition, declaration, type definition, implementation, references and
workspace symbol requests drop locations inside them, and pushed diagnostics for
ignored files are dropped. A definition that would filter down to nothing keeps
its original answer. This filter, not the basedpyright `exclude` reply, is what
keeps ignored folders out: measured, basedpyright still indexed every file under
them with the exclude in place.

**Socket takeover.** One socket per server. A newer attach closes the older one
with code **4000**; the bridge first sends `didClose` for every document the old
socket had open, so the new one starts clean. The server process never notices.
A server that exits closes its socket with 4001.

## The client (browser)

`client.ts` fetches `GET /api/lsp` once on load and again on every
`gmd:lsp-changed` window event. A socket closed with 4000 marks the connection
*evicted*: it stays off until this window is used again (focus, or a start or
stop in the panel), because retrying on a timer would evict the other window in
turn, forever. Any other close retries after 3 s.

`lspFor(path)` picks the server whose folder holds the file and whose kind
matches the extension, deepest folder winning, and returns nothing for a
gitignored file. `CodeTab.svelte` reconfigures `lspCompartment` with the
returned extension (completion, hover, signature help, `serverDiagnostics()`,
Error Lens), skips read-only and untitled tabs, and clears lint state when the
server goes away, since that state lives outside the compartment.

**Fallbacks.** Go-to-definition and Peek ask the server first; an error, a
timeout or an empty answer falls through to the older heuristics (same file,
then the imported module, then `/api/defs`). Find References does the same with
`/api/refs`, which is ripgrep. Only the editor-initiated requests in
`actions.ts` fall back; hover and completion simply show nothing.

**Error Lens** draws the most severe diagnostic of each line after its end over a
faint line tint, hints excluded, reading what `@codemirror/lint` already holds.
Inline blame hides on a line that has a diagnostic, since both draw in the same
place.
