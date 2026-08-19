# gh-md-editor — agent contract

## What this is

A self-hosted code and markdown IDE. `npx @luutuankiet/gh-md-editor <dir>` starts
one node process serving that directory over HTTP; a browser gets an explorer,
tabbed editors, real terminals, git and source control, diff and three-way merge,
search, quick open and symbol navigation.

It began as a browser-only markdown editor on GitHub Pages. That app still ships
but has been frozen since v0.7 — every feature since lands in **server mode**.
Both modes plus a VS Code extension build from one source tree.

## Hard constraints

- **`server/index.mjs` ships to npm unbundled** — an edit there reaches users
  verbatim, with no build step in between to catch it.
- **The published manifest is `server/package.json`, not the root one.** Its
  `files` allowlist decides what ships; a path outside it is absent from the
  tarball even when tracked in git.
- **Personal use on a trusted network.** Auth is a bearer token in the URL — no
  user model, no multi-tenancy.
- **No Electron, no Tauri;** the client is a browser and the host runs plain node.
  Content never leaves the host: no telemetry, no cloud sync.
- **Three deliverables, three independent version numbers** — web app (root
  `package.json`), npm server (`server/package.json`), extension
  (`vscode/package.json`).

## Layout

```
src/components/          browser-mode Svelte 5 components (frozen since v0.7)
src/components/server/   server-mode IDE — explorer, tabs, terminal, git, merge
src/lib/                 framework-agnostic TS: markdown, reveal, tab view state
src/lib/vscode-icons/    vendored icon corpus, 6.7 MB — never grep unglobbed
server/                  the node server; index.mjs is the shipped artifact
server/web/              server-mode front-end entry point
vscode/                  VS Code extension shell
public/                  Pages static assets and the userscript installer
releases/                one notes file per version, required before a release
scripts/                 ship.sh (build/gate/release), gen-docs-index.sh
docs/                    this catalogue
.github/workflows/       deploy.yml (Pages), publish-npm.yml (npm on a v* tag)
```

## Commands

| command | what it does |
|---|---|
| `npm run dev` | browser-mode dev server |
| `npm run dev:server` | server-mode dev server |
| `npm run build` | browser-mode build to `dist/` |
| `npm run build:server` | server-mode build plus precompression |
| `npm run check` | `svelte-check` — the only static gate; **there is no test runner** |
| `npm run gates` | stages everything, then refuses private paths and internal note ids |
| `npm run status` | current versions and git state |
| `bash scripts/ship.sh release web X.Y.Z --yes` | bump, build, gate, commit, tag, push |

`scripts/ship.sh` is not executable — always invoke it as `bash scripts/ship.sh`.
It hard-fails without `--yes` when stdin is not a terminal, and it refuses to
release unless `releases/vX.Y.Z.md` already exists.
<!-- The appendable seam. Everything ABOVE this comment belongs to the project and
     is never touched on a re-run; everything below is the standard block. Append
     it to whatever AGENTS.md already says. Never replace. The literal string
     "Standard block." on the first line is what check 2 of audit.sh looks for. -->

<!-- Standard block. Everything above belongs to this project; everything below is
     the pointer every repo laid out this way carries. -->

## Documentation

Indexed in [docs/README.md](docs/README.md). Every page is self-contained — it
assumes you opened that one file and have nothing else loaded.

| where | what | read it |
|---|---|---|
| [architecture/](docs/architecture/) | where behaviour lives, one page per area | before going looking for something |
| [traps/](docs/traps/) | failure modes with no error message, indexed by symptom | before debugging something wrong but not crashing |
| [reference/](docs/reference/) | simply true, expensive to re-derive | when you need the detail |
| [adr/](docs/adr/) | why the repo is the way it is | before changing something that looks odd |

## Before you wrap up

Leave the repo holding what this session cost you to find out. Four rules.

1. **Sort it, and expect most of it to go nowhere.** A next action is an issue. A
   durable, expensive-to-re-derive fact is a page. A choice that was hard to
   reverse, surprising without context and a real trade-off is a decision record
   under `docs/adr/`. Status, dates, version pins and plans are none of those —
   delete them.
2. **A doc is the last resort.** Type error → test → comment at the site → doc.
   Name the single line you would have commented instead; if you can name it,
   comment it and stop.
3. **Verify against running code before writing, and date the page `verified:`.**
   Anything remembered from earlier in the session is stale until re-read. Deleting
   a draft because the problem is already fixed is a success.
4. **Append, never rewrite.** Supersede a merged decision record with a new one
   naming what it replaces. A trap filename is an identifier quoted elsewhere:
   edit the body, never the name.

Then run `bash scripts/gen-docs-index.sh`. Never hand-maintain an index.
