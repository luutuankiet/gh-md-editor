// Double-click word-instance highlight, ported from the cmd_f VS Code
// extension. Fires ONLY when the selection is exactly one whole word (what a
// double-click produces); drags, multi-word selections and empty selections
// clear it. That gating is why this layer earns its keep where the old
// always-on cursor-word layer (removed in v0.5.x as noise) did not.
// Imports stay inside the vite ONE-CM-CORE dedupe graph.
import { EditorView, Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';

const MAX_MATCHES = 2000;

// All whole-word occurrences of the selected word, or [] when the selection
// is not exactly one whole word. Shared by the decoration plugin below and
// the hosts' scrollbar tick rails.
export function wordMatchRanges(state: EditorState): { from: number; to: number }[] {
  const sel = state.selection.main;
  if (sel.empty) return [];
  const word = state.wordAt(sel.from);
  if (!word || word.from !== sel.from || word.to !== sel.to) return [];
  const text = state.sliceDoc(sel.from, sel.to);
  if (!text || /\s/.test(text)) return [];
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const doc = state.doc.toString();
  const ranges: { from: number; to: number }[] = [];
  for (let m: RegExpExecArray | null; (m = re.exec(doc)) !== null; ) {
    ranges.push({ from: m.index, to: m.index + text.length });
    if (ranges.length >= MAX_MATCHES) break;
  }
  return ranges;
}

const mark = Decoration.mark({ class: 'cm-gmd-word' });

function build(state: EditorState): DecorationSet {
  const ranges = wordMatchRanges(state);
  // A lone match is just the selection itself — nothing to point at.
  if (ranges.length < 2) return Decoration.none;
  return Decoration.set(ranges.map((r) => mark.range(r.from, r.to)));
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = build(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.baseTheme({
  '.cm-gmd-word': {
    backgroundColor: 'rgba(56, 139, 253, 0.25)',
    outline: '1px solid rgba(56, 139, 253, 0.35)',
    borderRadius: '2px',
  },
});

export const wordHighlight = [plugin, theme];
