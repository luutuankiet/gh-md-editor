# A broken worktree link is detected and blocked, never repaired

The repository picker detects a linked git worktree whose link is broken — two
absolute paths in two small text files, broken by moving either side — and refuses
to act on it. It prints the exact `git worktree repair` command and stops.

## Considered options

**Repairing automatically** was rejected. Which checkout owns a given worktree is an
*inference*, and repairing against a wrong inference silently de-registers a healthy
worktree. The failure is invisible and the damage is to a repository the user did not
ask you to touch.

## Consequences

The user has to run one command by hand. That boundary is deliberate: repair is the
user's job, and the editor's job is to refuse to poison anything. The same principle
is why committing with nothing anchored is refused outright rather than quietly
falling back to the served root — a fallback that picks a repository for you is the
same class of guess.
