---
title: Release and delivery
covers: which manifest publishes what, what a v* tag triggers, and how a running server upgrades itself
verified: 2026-08-20
---

# Release and delivery

Three deliverables, three version numbers, two publish channels. `README.md` holds
the step-by-step recipe; this page holds the shape and the parts that bite.

## Three manifests

| manifest | version of | goes to |
|---|---|---|
| `package.json` (root) | the browser editor | GitHub Pages |
| `server/package.json` | `@luutuankiet/gh-md-editor` | the npm registry |
| `vscode/package.json` | the extension | the VS Code Marketplace |

They move independently on purpose. Most feature work lands in `src/components/`
and `src/lib/`, which more than one deliverable compiles from, so one source edit
usually wants a release on more than one side.

`scripts/ship.sh` bumps the root and server manifests together; the extension is
bumped and released separately.

## What a tag push does

`.github/workflows/publish-npm.yml` fires on a `v*` tag push (plus manual
dispatch). Node 24, `working-directory: server`, publishing over **OIDC trusted
publishing** — there is no npm token stored anywhere, which is the point.
`.github/workflows/deploy.yml` publishes the Pages build in parallel.

Pages uses `build_type=workflow`, which enables Actions-driven publish without
picking a branch source in the repository settings.

## The published package is `server/package.json`

Its `files` allowlist — `index.mjs`, `daemon.mjs`, `bin`, `dist/web` — decides
what reaches users. **A file outside the allowlist is absent from the tarball even
when it is tracked in git.** That is exactly how v0.13.0 shipped without
`bin/code-gh`. See `docs/traps/A_FILE_IS_IN_GIT_BUT_MISSING_FROM_THE_NPM_TARBALL.md`.

`server/index.mjs` is shipped **unbundled**. There is no build step between your
edit and the user.

## Release preconditions

- `releases/vX.Y.Z.md` must exist before `ship.sh release web X.Y.Z`, or it aborts.
  List them with `ls releases/ | sort -V` — plain `ls` puts `v0.9.1` after `v0.25.6`.
- `scripts/ship.sh` is not executable; invoke it as `bash scripts/ship.sh`.
- It hard-fails without `--yes` when stdin is not a terminal.
- `npm run gates` stages everything and then refuses two things: private paths, and
  internal note identifiers of the `LOG-<n>` / `TASK-<n>` shape. The second gate
  exists because that notation is meaningless to anyone reading the published
  repository, and it persists in version control forever.

## Self-upgrade

`gh-md-editor upgrade` reads the server registry at
`~/.cache/gh-md-editor/servers/<port>.json`, stops each server through the existing
SIGTERM → 8 s → SIGKILL path, and respawns it from its own entry — replaying port,
bind host, workspace and auth token, so bookmarked `?token=` URLs survive.

Three properties worth knowing before running it:

- **It restarts every registered server, not one**, and kills their live terminal
  sessions. A throwaway server left in the registry is replayed too, so kill scratch
  servers before upgrading.
- Servers already on the running version are skipped unless `--force`; `--dry-run`
  prints the plan and stops.
- It is deliberately promptless, which is what makes it safe to drive from an
  automated session.

Self-hosting the upgrade works without `/proc`: the server injects `GMD_PORT` into
every pty it spawns, so a shell upgrading its own server can identify it and re-exec
detached.

## The general rule

The artifact is the manifest's allowlist, not the working tree. Before believing a
file ships, check that the allowlist claims it — `git ls-files` and `npm pack`
disagree far more often than anyone expects.
