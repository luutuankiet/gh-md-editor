# One git repository anchor, chosen once, shared by every panel

The status bar, Source Control, Tree Compare and Git Graph all read a single
anchored repository, chosen in the status bar, persisted per workspace under
`ghmd.gitAnchor` and reachable from the palette as **Open Git Repository…**.

## Considered options

**Each panel discovering its own repository**, which is what came before, was
rejected after it produced a failure nobody could see: in a workspace holding more
than one checkout, the status bar could name one repository while the commit button
acted on another. Nothing errored, and there was no surface on which the two
disagreed visibly.

## Consequences

A workspace with several checkouts needs one deliberate choice before git actions
work, and committing with nothing anchored is refused rather than defaulted. The
picker groups linked worktrees under the checkout that owns them, with fold state in
`ghmd.repoGroups`.

Whether a healthy root repository should surface its worktrees folded by default is
still unanswered.
