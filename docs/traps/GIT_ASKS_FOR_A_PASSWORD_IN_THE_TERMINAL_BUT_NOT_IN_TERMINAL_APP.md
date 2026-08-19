---
symptom: "git asks for a username and password in the integrated terminal, but the same command works in Terminal.app"
area: terminal / macOS keychain
verified: 2026-08-20
---

# Git asks for a password in the terminal but not in Terminal.app

## Symptom

On macOS, cloning or fetching over HTTPS inside an integrated terminal stops on

```
Username for 'https://github.com':
```

or, with prompting disabled, on

```
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

The identical command in Terminal.app or iTerm on the same Mac, as the same user,
succeeds without asking. `gh auth status` run in the integrated terminal makes it
look like a token problem:

```
X Failed to log in to github.com account <user> (~/.config/gh/hosts.yml)
- The token in ~/.config/gh/hosts.yml is invalid.
```

**That message is a red herring.** The token is fine. Re-running `gh auth login`
fixes nothing, because nothing is wrong with what is stored.

## Mechanism

`gh auth login` stores its token in the **login keychain**, and installs a git
credential helper that reads it back:

```
credential.https://github.com.helper = !/opt/homebrew/bin/gh auth git-credential
```

macOS attaches the login keychain **per security session**, not per user. A
process that was not started from inside the graphical login session gets audit
session `100001` — the constant meaning "no session" — and `securityd` then
refuses to put the login keychain in that process's search list at all. Every
child inherits it, so the pty this server spawns inherits it too.

The result inside the terminal:

```
$ security list-keychains
    "/Library/Keychains/System.keychain"
```

Against, in a terminal launched from the desktop:

```
$ security list-keychains
    "/Users/<user>/Library/Keychains/login.keychain-db"
    "/Library/Keychains/System.keychain"
```

The keychain holding the token is simply **not in the list**. A direct read exits
44, which is `errSecItemNotFound` — not "locked", not "denied", *not there*:

```
$ security find-generic-password -s gh:github.com -w; echo $?
44
```

`gh` sees an empty keyring, falls back to the on-disk config, finds no
`oauth_token:` there either, and reports the file as invalid. Git's helper then
returns nothing and git falls through to prompting.

The environment is not the problem — `createSession` in `server/index.mjs` copies
`process.env` wholesale into the shell. A security session is kernel state
attached to the process, and copying environment variables cannot carry it.

## What does not fix it

These look like they should work and do not. Verified on macOS 15 (Darwin 24.6.0):

- **`security unlock-keychain` in a shell rc file.** The keychain is not locked.
  Unlocking a keychain that is absent from the search list changes nothing.
- **`security list-keychains -d user -s ~/Library/Keychains/login.keychain-db`.**
  The user preference domain *already* names the login keychain in this state, and
  the effective list stays System-only regardless of what you write to it. The
  preference is advisory; `securityd` is the one refusing.
- **`security list-keychains -d session ...`.** There is no such domain. The valid
  values are `user`, `system`, `common`, `dynamic`.

## Fix

**Start the server from a process that is inside the graphical login session** — a
terminal application running on the Mac's desktop. Everything downstream inherits
the session and the keychain appears.

If the server is started by a launchd agent, add to the plist:

```xml
<key>LimitLoadToSessionType</key>
<string>Aqua</string>
```

If the server must be started over SSH or from a headless context, take the token
out of the keychain instead, with `gh auth login --insecure-storage`. That writes
`oauth_token:` into `~/.config/gh/hosts.yml` in plaintext, which works from any
session — trade it deliberately, not by accident.

## How to verify

Two commands, both run **inside the integrated terminal**, not on the desktop:

```
security list-keychains
sudo launchctl procinfo $$ | grep -A1 'audit info'
```

A healthy terminal lists `login.keychain-db` first and reports a five- or
six-digit session id. A broken one lists only `System.keychain` and reports
`session id = 100001`.

The end-to-end check is a private repository with prompting disabled, so a hang
becomes a failure:

```
GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/<owner>/<private-repo>.git /tmp/x
```

## What is deliberate here

The pty is spawned as a **login shell** (`pty.spawn(shell, ['-l'], …)`) so the
user's rc chain loads. That is why the terminal otherwise feels identical to a
desktop one, and it is exactly what makes this trap confusing: everything a shell
can inherit *has* been inherited. The security session is the one thing that
cannot be, and it is invisible until you go looking for it.

## The general rule

This is not specific to `gh`. Anything reading the macOS login keychain from a
server-spawned shell fails the same silent way — `git-credential-osxkeychain`,
`aws`, `docker login`, `security` itself. When a credential works on the desktop
and not through a remote shell on the same machine, check the audit session before
you check the credential.
