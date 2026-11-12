// Error Lens style diagnostics: the most severe message of each line printed
// after its end, coloured by severity, over a faint tint of the whole line.
// Reads the diagnostics @codemirror/lint already holds (serverDiagnostics()
// feeds them in), so the squiggle and its hover come from lint itself.

import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { forEachDiagnostic, setDiagnosticsEffect, type Diagnostic } from '@codemirror/lint';

const RANK: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
const MAX = 500;

class LensWidget extends WidgetType {
  constructor(readonly sev: string, readonly text: string) { super(); }
  eq(o: LensWidget) { return o.sev === this.sev && o.text === this.text; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-lens cm-lens-${this.sev}`;
    // textContent, never innerHTML: the message quotes the user's source.
    el.textContent = this.text;
    el.title = this.text;
    return el;
  }
}

function build(state: EditorState): DecorationSet {
  const best = new Map<number, Diagnostic>();
  forEachDiagnostic(state, (d, from) => {
    // Hints are off, as in Error Lens: unused-variable fades would otherwise
    // put text on half the lines of a file being written.
    if (d.severity === 'hint') return;
    const ln = state.doc.lineAt(Math.min(from, state.doc.length)).number;
    const cur = best.get(ln);
    // Strict `<` keeps the first of equal severity: server order wins ties.
    if (!cur || RANK[d.severity] < RANK[cur.severity]) best.set(ln, d);
  });
  const b = new RangeSetBuilder<Decoration>();
  for (const ln of [...best.keys()].sort((x, y) => x - y)) {
    const d = best.get(ln)!;
    const line = state.doc.line(ln);
    let msg = d.message.replace(/[\n\r\t]+/g, ' ⏎ ');
    const cps = [...msg];
    if (cps.length > MAX) msg = cps.slice(0, MAX).join('') + '…';
    b.add(line.from, line.from, Decoration.line({ class: `cm-lensLine-${d.severity}` }));
    // side 2: after inline blame (side 1) should both ever land on one line.
    b.add(line.to, line.to, Decoration.widget({ widget: new LensWidget(d.severity, msg), side: 2 }));
  }
  return b.finish();
}

const field = StateField.define<DecorationSet>({
  create: build,
  update(deco, tr) {
    return tr.docChanged || tr.effects.some((e) => e.is(setDiagnosticsEffect)) ? build(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Whether any diagnostic (hints aside) starts on the line holding `pos`. */
export function lineHasDiagnostic(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  let hit = false;
  forEachDiagnostic(state, (d, from) => {
    if (!hit && d.severity !== 'hint' && from >= line.from && from <= line.to) hit = true;
  });
  return hit;
}

// The tint is a background IMAGE so it layers over the active-line
// background colour instead of replacing it on the cursor's line.
const tint = (c: string) => ({ backgroundImage: `linear-gradient(${c}, ${c})` });

const theme = EditorView.baseTheme({
  '&dark .cm-lensLine-error': tint('#e454541b'),
  '&dark .cm-lensLine-warning': tint('#ff942f1b'),
  '&dark .cm-lensLine-info': tint('#00b7e420'),
  '&light .cm-lensLine-error': tint('#e4545420'),
  '&light .cm-lensLine-warning': tint('#ff942f20'),
  '&light .cm-lensLine-info': tint('#00b7e420'),
  '.cm-lens': {
    marginLeft: '4ch',
    whiteSpace: 'pre',
    userSelect: 'none',
    borderRadius: '0.2em',
  },
  '&dark .cm-lens-error': { color: '#ff6464' },
  '&dark .cm-lens-warning': { color: '#fa973a' },
  '&light .cm-lens-error': { color: '#e45454' },
  '&light .cm-lens-warning': { color: '#ff942f' },
  '.cm-lens-info': { color: '#00b7e4' },
  // With wrap on, a long message would add rows under the code and shove
  // everything below it each time diagnostics arrive. Clip it to one row; the
  // title carries the full text.
  '.cm-lineWrapping .cm-lens': {
    display: 'inline-block',
    maxWidth: '60%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    verticalAlign: 'top',
  },
});

export const errorLens = [field, theme];
