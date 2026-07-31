# gh-md-editor

A browser-only GitHub-flavored markdown editor with a live side-by-side preview. Built for reading and editing PR-content markdown without leaving the browser.



https://github.com/user-attachments/assets/71694022-c26e-4ef5-9ecc-28074059191a






## Features

- **CodeMirror 6 editor** with markdown syntax tinting (distinct hues per heading level, strong/emphasis, monospace, links, quotes)
- **Live preview** using `markdown-it` and the GitHub markdown stylesheet, diffed onto the DOM with `morphdom` so `<details open>` state, scroll position, mermaid SVGs, and starry-night syntax highlighting survive each keystroke
- **Source-line mapping**: right-click on either pane to reveal the matching block on the other; closed `<details>` sections expand automatically when revealed
- **Outline sidebar** (H1–H8) on the right with fold/unfold, jump-on-click, and an active-heading highlight that follows the preview viewport (correctly skips headings inside collapsed `<details>`)
- **VS Code-style sticky-header stack** at the top of the editor, showing the heading breadcrumb for the current scroll position
- **GitHub-flavored alerts**: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`
- **Mermaid diagrams** and **starry-night syntax highlighting** in fenced code blocks (both lazy-loaded)
- **Markdown auto-pairs**: select text and type `` ` `` / `*` / `_` / `~` / `(` / `[` / `{` / `"` / `'` to wrap; `Cmd/Ctrl+Shift+→` expands the selection to the enclosing syntax node
- **In-pane search** (`Cmd/Ctrl+F`) and **soft-wrap toggle** (`Alt+Z`, persisted)
- **Keyboard shortcuts dialog** (press `?` with the outline focused, or click the `?` in the outline header)
- **localStorage persistence** — documents survive reloads

## Server mode

Since v0.9.1 the same editor can be served over a real folder, turning it into a small browser IDE:

```bash
npx @luutuankiet/gh-md-editor                        # current directory on http://127.0.0.1:8790
npx @luutuankiet/gh-md-editor . --host 0.0.0.0 --port 9000 --auth secret
npx @luutuankiet/gh-md-editor . --tunnel             # public HTTPS URL, auth forced on
```

`.md` files open in the three-pane cockpit above; every other file opens in a plain CodeMirror editor with language auto-detect and syntax highlighting. Also included: a lazy file tree, preview/pinned tabs with `Cmd/Ctrl+S` write-back and mtime-conflict prompts, an integrated terminal (multiple persistent sessions), workspace search backed by ripgrep, a git source-control panel with line-level stage/revert, fuzzy quick open, and a listening-ports panel.

### Background mode

`up` starts the server detached and returns, so one ssh session can start it and then end:

```bash
npx -y @luutuankiet/gh-md-editor up . --host 0.0.0.0 -p 3457   # start, print the url, return
npx -y @luutuankiet/gh-md-editor list-servers                  # all of them, with urls  (alias: ls)
npx -y @luutuankiet/gh-md-editor down                          # stop; picks when several are up
```

`up` waits for the port to actually bind before returning, so a server that fails to start says so in the terminal that asked for it instead of dying quietly into a log. Pointing it at a workspace that already has a server prints that one's url rather than starting a second; `--force` if a second is what you meant.

`list-servers` reads `~/.cache/gh-md-editor/servers/` — one file per port, written by the server itself once it is listening. Entries whose process is gone are dropped on read, so a hard-killed server tidies up after itself. Those files hold the auth token, because a url you cannot open is useless and a `--tunnel` token is minted server-side where no caller can see it; the directory is `0700` and the files `0600`.

`down` stops a lone server outright, offers an arrow-key picker when several are up, and also takes `--port <n>` or `--all`. It sends `SIGTERM`, so the server's own shutdown sweeps the terminal shells it spawned, and it warns before taking any that are still live (`--yes` skips the prompt). Each detached server's stdout lands in `~/.cache/gh-md-editor/logs/<port>.log`.

### What the host needs

Only Node ≥ 20 is required. Everything below is optional, degrades loudly at startup rather than failing, and never blocks the rest of the editor:

| Want | Install on the host | Without it |
|---|---|---|
| Search + quick open (`Cmd/Ctrl+P`) | `ripgrep` | both come back empty, with the reason |
| Source-control panel | `git` | the panel stays empty |
| Integrated terminal | a C toolchain, so the optional `node-pty` can build: `build-essential python3` (Debian/Ubuntu) or Xcode CLT (macOS) | terminal disabled, one warning at boot |
| `--tunnel` (public URL) | nothing — cloudflared is downloaded once into `~/.cache/gh-md-editor` | n/a |
| `--tunnel funnel` | `tailscale`, running and logged in | falls back to a clear error; the local server keeps serving |

A fully-loaded Debian/Ubuntu box is therefore:

```bash
apt-get install -y ripgrep git build-essential python3
npx -y @luutuankiet/gh-md-editor . --host 0.0.0.0 --port 8790 --auth "$(openssl rand -hex 16)"
```

The listening-ports panel reads `/proc/net/tcp`, so it is Linux-only; elsewhere the panel accepts a port typed by hand.

### Reaching it

It binds to loopback by default. `--host 0.0.0.0` opens it to the network, which also exposes the terminal — pair that with `--auth <token>` or an authenticating reverse proxy.

`--tunnel` skips all of that: it starts a cloudflared quick tunnel and prints a public HTTPS URL that works from a phone with no router config, no account and no signup. Because that URL is reachable by the whole internet, auth is forced on with a server-minted token baked into the printed link. If the tunnel binary is missing or dies, the local server carries on serving regardless. `--tunnel funnel` uses Tailscale Funnel instead for a stable hostname, and `--tunnel-bin <path>` points at a binary you already have.

## Dev

```bash
npm install
npm run dev
```

## Build

```bash
npm run build          # web app -> dist/
npm run preview        # serve dist/ locally
npm run build:ext      # VS Code extension -> vscode/*.vsix
npm run build:all      # both
```

## Type-check

```bash
npm run check
```

## Shipping

This repo produces **two** deliverables with independent version numbers:

| | Source of truth | Ships to |
|---|---|---|
| Web app | `package.json` | GitHub Pages, deployed by Actions on every push to `main` |
| VS Code extension | `vscode/package.json` | `.vsix` / the VS Code Marketplace |

Most feature work lands in `src/components/*` and `src/lib/*`, which **both** deliverables
compile from — so one source edit usually wants one release on each side.

`scripts/ship.sh` automates both paths. It finds node under nvm if it isn't on your
`PATH`, runs the safety gates that keep private files and internal notes out of the
public remote, and refuses to tag a web release without a matching notes file.

```bash
npm run status                      # both versions + git state
npm run gates                       # safety gates only, nothing else

./scripts/ship.sh release web 0.8.2 # bump, build, gate, commit, tag, push
./scripts/ship.sh release ext 0.2.8 # bump, build, package vsix, commit, push
./scripts/ship.sh publish ext       # push an already-built vsix to the Marketplace
./scripts/ship.sh --help
```

Before a **web** release, write `releases/vX.Y.Z.md` and add its row to the
[index](./releases/README.md) — the script checks for the file and stops if it's missing.
It asks for confirmation before anything irreversible; pass `--yes` in a script.

Publishing the extension needs an Azure DevOps token with the `Marketplace: Manage`
scope, either in `VSCE_PAT` or stored via `vsce login luutuankiet`. These expire, and
the failure surfaces as an opaque `TF400813` error — the script explains the fix when
it hits one.

## Appendix — how releasing works

A memo for whoever runs the next one.

### Three deliverables, three version numbers

| Deliverable | Version lives in | Ships to | Triggered by |
|---|---|---|---|
| Web app | `package.json` | GitHub Pages | any push to `main` (`deploy.yml`) |
| Server / CLI | `server/package.json` | npm `@luutuankiet/gh-md-editor` | pushing a `v*` tag (`publish-npm.yml`) |
| VS Code extension | `vscode/package.json` | VS Code Marketplace | manual `vsce publish` |

They version independently on purpose. Most feature work lands in `src/components/*` and `src/lib/*`, which all three compile from, so one source edit usually deserves a release on more than one side.

### Cutting a web + npm release

```bash
# 1. write the notes file first — ship.sh refuses to release without it
$EDITOR releases/v0.9.2.md          # title line + ~8 short bullets, no diagrams

# 2. bump the npm package by hand (ship.sh only bumps the root package.json)
$EDITOR server/package.json

# 3. bump, build, run the gates, commit, tag, push
./scripts/ship.sh release web 0.9.2

# 4. create the GitHub release page from the notes file
gh release create v0.9.2 --repo luutuankiet/gh-md-editor --notes-file releases/v0.9.2.md
```

Step 3 pushes to `main` (Pages redeploys) and pushes the tag (npm publishes). Step 4 is separate because `gh` isn't installed everywhere — run it from any machine that has it.

Extension releases are their own command: `./scripts/ship.sh release ext 0.2.8 --publish` (needs `VSCE_PAT`, or `vsce login luutuankiet` first).

### Things that will bite you

- **Check npm before picking a version.** `npm view @luutuankiet/gh-md-editor version`. npm refuses to overwrite a published version, so the tag must be ahead of whatever is already on the registry — not just ahead of the last git tag. These two drifted apart once already, when the first publish had to be done by hand.
- **npm auth is OIDC, not a token.** Nothing secret is stored in this repo. npmjs.com trusts this repository plus the exact workflow filename `publish-npm.yml`. Renaming or moving that file silently breaks publishing until the trust config is updated.
- **A brand-new npm package has to be published manually once.** Trusted publishing can only be attached to a package that already exists, so the bootstrap publish is `npm login && npm publish` from `server/` after `npm run build:server`.
- **`ship.sh` gates the commit.** It refuses to ship if the private working-notes directory or agent config is staged, or if internal note identifiers leak into shipped files. Fix the content rather than bypassing it.
- **Release notes are the release body verbatim.** Keep them to a title plus roughly eight short bullets — see `releases/README.md`.

## Releases

Narrative release notes live in [`releases/`](./releases/). Start with the [index](./releases/README.md) or jump to the latest: [v0.8.1](./releases/v0.8.1.md).
