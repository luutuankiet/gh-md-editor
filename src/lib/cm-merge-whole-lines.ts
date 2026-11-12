import { ViewPlugin, Decoration, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, type EditorState } from '@codemirror/state';
import { getChunks } from '@codemirror/merge';

// @codemirror/merge marks changed text word by word, and a line that was added
// or removed whole is one big change, so with `highlightChanges` every token on
// it gets its own changed-text box on top of the line tint. This tags those
// lines so the stylesheet can show the line tint alone, as VS Code does, and
// keep the word highlight for lines that were only partly edited.
const whole = Decoration.line({ class: 'cm-wholeChangedLine' });

function build(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const info = getChunks(state);
  if (!info) return b.finish();
  const isA = info.side === 'a';
  const doc = state.doc;
  let last = -1;
  for (const chunk of info.chunks) {
    const base = isA ? chunk.fromA : chunk.fromB;
    for (const ch of chunk.changes) {
      const from = base + (isA ? ch.fromA : ch.fromB);
      const to = base + (isA ? ch.toA : ch.toB);
      if (to <= from) continue;
      for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
        if (line.length > 0 && line.from >= from && line.to <= to && line.from > last) {
          b.add(line.from, line.from, whole);
          last = line.from;
        }
        if (line.to >= to || line.number >= doc.lines) break;
      }
    }
  }
  return b.finish();
}

export const wholeChangedLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || getChunks(u.state)?.chunks !== getChunks(u.startState)?.chunks) {
        this.decorations = build(u.state);
      }
    }
  },
  { decorations: (p) => p.decorations },
);
