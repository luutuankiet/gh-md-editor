---
symptom: "the file is committed and on disk, but users report the command is not found"
area: npm packaging
verified: 2026-08-20
---

# A file is in git but missing from the npm tarball

## Symptom

A file is tracked, committed, present in a fresh clone, and works perfectly when
you run from the repository. Users on the published package hit "command not
found", or an import that resolves to nothing. Nothing failed at publish time.

## Mechanism

The published package here is **`server/package.json`**, not the root manifest, and
it carries a `files` allowlist:

```json
"files": ["index.mjs", "daemon.mjs", "bin", "dist/web"]
```

An allowlist is a whitelist. **A path outside it is absent from the tarball even
when it is tracked in git**, and npm reports nothing, because from npm's point of
view you asked for exactly this.

This is not hypothetical: v0.13.0 shipped without `bin/code-gh` because the
allowlist had never gained `bin`. Every integrated shell prepended a nonexistent
directory to its `PATH`, and the command was silently not found for everyone.

## Fix

When you add a file that users need at runtime, **edit the allowlist in the same
change**. Adding a directory to git is not adding it to the package.

## How to verify

Do not read the manifest — read the tarball.

```
npm pack --dry-run    # run from server/
```

Better still, verify from the **published** artifact with `PATH` stripped, which is
how the v0.13.0 regression was caught in passing. Installing from the registry into
a clean environment exercises the allowlist; running from the repository never does.

## The general rule

Whenever what ships is decided by a list rather than by the working tree, the list
is the artifact. Check it with a packaging command, not by looking at the files —
the files will always be there.
