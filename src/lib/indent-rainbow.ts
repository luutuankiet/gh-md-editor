import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { getIndentUnit } from '@codemirror/language';

// Tints each level of leading whitespace a different faint colour, so the depth
// of a line is readable at a glance rather than counted. The vertical guides the
// indentation-markers extension already draws answer "which block does this
// belong to"; the tint answers "how deep am I", which is the question that
// actually bites in deeply nested config and markup.
//
// Viewport-scoped by construction: decorations are rebuilt only for the lines
// CodeMirror is currently showing, so cost tracks the window rather than the
// file. A 20k-line file paints as fast as a 200-line one.

const LEVELS = 4;
const marks = Array.from({ length: LEVELS }, (_, i) => Decoration.mark({ class: `cm-ir-${i}` }));
// A partial indent sitting in front of real content means the file mixes widths
// somewhere. Loud on purpose — catching that is half the value.
const errorMark = Decoration.mark({ class: 'cm-ir-err' });

function build(view: EditorView): DecorationSet {
  const unit = getIndentUnit(view.state) || 4;
  const tabSize = view.state.tabSize;
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      const text = line.text;

      // Columns, not characters: a tab advances to the next tab stop, so a
      // tab-indented file has to be measured the way it is rendered or every
      // level past the first lands in the wrong colour.
      let col = 0;
      let i = 0;
      let chunkStart = 0;
      let level = 0;
      while (i < text.length) {
        const ch = text.charCodeAt(i);
        if (ch === 32) col += 1;
        else if (ch === 9) col += tabSize - (col % tabSize);
        else break;
        i++;
        if (col % unit === 0) {
          builder.add(line.from + chunkStart, line.from + i, marks[level % LEVELS]);
          level++;
          chunkStart = i;
        }
      }
      // Only flag a leftover when something follows it. Trailing whitespace on
      // an otherwise blank line is untidy, not a mixed-indent bug, and painting
      // it red would make every half-written file look broken.
      if (i > chunkStart && i < text.length) {
        builder.add(line.from + chunkStart, line.from + i, errorMark);
      }
    }
  }
  return builder.finish();
}

const theme = EditorView.baseTheme({
  '.cm-ir-0': { background: 'rgba(255, 255, 64, 0.07)' },
  '.cm-ir-1': { background: 'rgba(127, 255, 127, 0.07)' },
  '.cm-ir-2': { background: 'rgba(255, 127, 255, 0.07)' },
  '.cm-ir-3': { background: 'rgba(79, 236, 236, 0.07)' },
  '.cm-ir-err': { background: 'rgba(128, 32, 32, 0.55)' },
  // Light backgrounds swallow those alphas, so the light theme gets its own
  // set rather than a shared one that reads as noise on one side or nothing on
  // the other.
  '&light .cm-ir-0': { background: 'rgba(200, 160, 0, 0.10)' },
  '&light .cm-ir-1': { background: 'rgba(0, 160, 60, 0.09)' },
  '&light .cm-ir-2': { background: 'rgba(190, 60, 190, 0.08)' },
  '&light .cm-ir-3': { background: 'rgba(0, 150, 180, 0.09)' },
  '&light .cm-ir-err': { background: 'rgba(210, 60, 60, 0.28)' },
});

export const indentRainbow = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        // Selection changes move nothing here, so they are deliberately not a
        // trigger — arrow-keying through a file must not rebuild decorations.
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
  theme,
];
