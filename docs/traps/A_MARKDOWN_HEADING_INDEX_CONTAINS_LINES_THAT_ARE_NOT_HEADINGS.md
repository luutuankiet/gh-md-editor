---
symptom: "I indexed a markdown file by heading and the list has entries that are not headings"
area: repository conventions / searching
verified: 2026-08-20
---

# A markdown heading index contains lines that are not headings

## Symptom

You index a large markdown file with a pattern like `^#{1,4} ` to get its table of
contents, and the result contains entries that do not exist as sections. Nothing
errors. The index looks completely plausible, which is what makes it expensive.

## Mechanism

**A shell comment inside a fenced code block is indistinguishable from a level-1
heading.** Both are `# ` at the start of a line. Markdown parsers know the
difference because they track fence state; a line-oriented search does not.

Measured on a mature markdown file in this repository: of 25 level-1 matches, **24
were shell comments inside code blocks** and one was the actual title.

## Fix

Always index with `^#{2,4} `, never `^#{1,4} `.

Level-2 and deeper are effectively safe because a genuine `## ` inside a fenced
shell block is rare, and the document title — the only real level-1 heading in a
well-formed file — is not something an index needs anyway.

## How to verify

Compare the counts. If `^#{1,4} ` returns far more than `^#{2,4} ` on a file with
code examples, the extra rows are comments. Spot-check one by opening its line.

## Related failure of the same shape

A `grep` on this host may be shimmed to `ugrep -G`, which **silently answers "0
matches" on a pattern it cannot parse** rather than erroring. Use `rg` for anything
whose emptiness you intend to trust.

## The general rule

A search that returns a wrong answer is more expensive than one that returns an
error, because you act on it. When a pattern is ambiguous with something the file
legitimately contains, tighten the pattern rather than eyeballing the result — you
will not spot 24 wrong rows in a list of 25.
