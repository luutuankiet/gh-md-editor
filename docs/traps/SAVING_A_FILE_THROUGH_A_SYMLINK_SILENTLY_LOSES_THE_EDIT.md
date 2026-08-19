---
symptom: "I saved a file, the editor reported success, and the change is not on disk"
area: server save path
verified: 2026-08-20
---

# Saving a file through a symlink silently loses the edit

## Symptom

You edit a file reached through a symlinked directory, save, and the UI reports
success. The change is not in the file. Worse, the symlink itself is now gone,
replaced by a regular file containing your edit.

## Mechanism

The atomic-save path writes a temporary file and then `rename`s it into place —
`commitTemp` at `server/index.mjs:459`.

**`rename` onto a symlink replaces the link.** It does not follow it. So the link
that pointed somewhere useful becomes an ordinary file at the link's own location,
and the file you thought you were editing is untouched. Both halves of the damage
are silent: `rename` succeeded, so the server reports success.

`resolveSafe` (line 211) does not save you here. It is a **lexical** jail built on
`path.resolve`, never `realpath` — it stops `../` traversal by string arithmetic
and by construction cannot see through a link.

## Fix

Resolve the final hop before renaming. `commitTemp` now calls `realpath` on the
destination, so the rename lands on the link's *target*.

The same class of defect existed at four other places and was closed the same way,
uniformly at the server boundary:

- `apiTree` and `apiBrowse` classify a link by what it points at, emitting `dir` or
  `file` plus a separate `link: true` flag, rather than a third entry type the
  client has no branch for
- `apiDownload` resolves the selection while the walk still refuses links met along
  the way, so a loop or an escape from the workspace cannot be zipped
- all five ripgrep spawns pass `--follow`

## How to verify

Symlink a directory into the workspace, edit a file through it, save, then check
both the link and the target:

```
ls -l <link>              # must still be a symlink
cat <target>/<file>       # must contain the edit
```

Checking only that the edit "worked" in the editor proves nothing — that is exactly
what the broken version reported.

## What is deliberate here

An **absolute** path still bypasses `resolveSafe` by design. The server is
single-user on a trusted network; the jail exists to stop a malformed relative path,
not an adversary. Do not read the lexical jail as a security boundary and then be
surprised by its gaps.

Failure modes that survive `rename` succeeding also exist for bind mounts, where the
fix is a `copyFile` fallback on `EBUSY`, `EPERM` and `EXDEV` — plus an alert, because
that path had also been failing silently.

## The general rule

`rename` is atomic with respect to *the path*, not with respect to *what you meant*.
Any write path that must survive a symlink has to resolve the final hop itself, and
any save that cannot prove it landed must say so rather than reporting success.
