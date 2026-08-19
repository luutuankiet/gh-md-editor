# No coupled scroll between the editor and the preview

The two panes scroll independently, and moving one never moves the other. Navigation
between them is explicit instead: reveal-counterpart commands jump on request and
flash the destination for 1200 ms.

## Considered options

**Line-based scroll synchronisation**, as most side-by-side markdown tools implement
it, was rejected. Soft wrap makes raw character height and rendered height different
quantities, so a line-based mapping drifts continuously and the drift is worst
exactly where documents are densest. Every tool that ships coupled scroll gets this
wrong; avoiding it is the original reason this project exists.

**Proportional scroll synchronisation** was rejected for the same reason one step
removed: a fraction of the scrollable span is only meaningful when both sides have
comparable content density, and a document with one large code fence has none.

## Consequences

The mapping only has to be correct **at the moment of a jump**, never continuously.
That is why line-level source mapping — which carries no column information and
leaves inline elements unmapped — is sufficient here and would not be sufficient for
a coupled implementation.

A user who wants the panes near each other has to press a key. That cost is accepted
knowingly, and the flash highlight exists to pay it back.
