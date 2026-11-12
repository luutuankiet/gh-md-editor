// Peek Definition: the target's surrounding lines shown in a block under the
// line that asked, so a definition can be read without leaving the file. Not
// the git change peek (`gmd-peek`), which is a different widget entirely.

import { StateField, StateEffect, Prec, type Extension } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap } from '@codemirror/view';

export interface DefPeek {
  at: number; // end of the line the widget hangs under
  path: string;
  line: number; // 1-based target line
  from: number; // 1-based number of lines[0]
  lines: string[];
}

export const setDefPeek = StateEffect.define<DefPeek | null>();

const BEFORE = 3;
const AFTER = 7;

function openAt(path: string, line: number) {
  window.dispatchEvent(new CustomEvent('gmd:open-request', { detail: { kind: 'file', path, line } }));
}

class PeekWidget extends WidgetType {
  constructor(readonly p: DefPeek) { super(); }
  eq(o: PeekWidget) { return o.p === this.p; }
  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = 'cm-defPeek';
    const head = document.createElement('div');
    head.className = 'cm-defPeekHead';
    const link = document.createElement('span');
    link.className = 'cm-defPeekLink';
    link.textContent = `${this.p.path}:${this.p.line}`;
    link.title = 'Open the definition';
    link.onclick = () => openAt(this.p.path, this.p.line);
    const close = document.createElement('span');
    close.className = 'cm-defPeekClose';
    close.textContent = '×';
    close.title = 'Close (Escape)';
    close.onclick = () => { view.dispatch({ effects: setDefPeek.of(null) }); view.focus(); };
    head.append(link, close);
    const body = document.createElement('div');
    body.className = 'cm-defPeekBody';
    this.p.lines.forEach((text, i) => {
      const n = this.p.from + i;
      const row = document.createElement('div');
      row.className = n === this.p.line ? 'cm-defPeekRow hit' : 'cm-defPeekRow';
      const num = document.createElement('span');
      num.className = 'cm-defPeekNum';
      num.textContent = String(n);
      const code = document.createElement('span');
      code.textContent = text || ' ';
      row.append(num, code);
      row.ondblclick = () => openAt(this.p.path, n);
      body.append(row);
    });
    box.append(head, body);
    return box;
  }
  // Clicks inside belong to the widget, not to caret placement.
  ignoreEvent() { return true; }
}

const field = StateField.define<DefPeek | null>({
  create: () => null,
  update(v, tr) {
    // Any edit closes it: the widget hangs at a fixed offset and the lines it
    // shows may be the ones just edited.
    if (tr.docChanged) v = null;
    for (const e of tr.effects) if (e.is(setDefPeek)) v = e.value;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) =>
    v ? Decoration.set([Decoration.widget({ widget: new PeekWidget(v), block: true, side: 1 }).range(v.at)]) : Decoration.none),
});

const theme = EditorView.baseTheme({
  '.cm-defPeek': {
    margin: '4px 0 6px',
    borderTop: '2px solid #4daafc',
    borderBottom: '2px solid #4daafc',
    fontSize: '12px',
  },
  '&light .cm-defPeek': { backgroundColor: '#f3f6fa' },
  '&dark .cm-defPeek': { backgroundColor: '#1b2230' },
  '.cm-defPeekHead': {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '2px 8px',
    fontFamily: 'system-ui, sans-serif',
    opacity: '0.85',
  },
  '.cm-defPeekLink': { cursor: 'pointer', color: '#4daafc' },
  '.cm-defPeekLink:hover': { textDecoration: 'underline' },
  '.cm-defPeekClose': { cursor: 'pointer', padding: '0 4px' },
  '.cm-defPeekBody': { padding: '2px 0', overflowX: 'auto' },
  '.cm-defPeekRow': { whiteSpace: 'pre', padding: '0 8px' },
  '.cm-defPeekRow.hit': { backgroundColor: 'rgba(229, 192, 32, 0.22)' },
  '.cm-defPeekNum': { display: 'inline-block', minWidth: '3.5em', opacity: '0.5', userSelect: 'none' },
});

const escape = Prec.high(keymap.of([{
  key: 'Escape',
  run: (v) => {
    if (!v.state.field(field, false)) return false;
    v.dispatch({ effects: setDefPeek.of(null) });
    return true;
  },
}]));

export const defPeek: Extension = [field, theme, escape];

/**
 * Open the peek under the caret's line for a target at `path:line`. Lines come
 * from the open buffer when the target is this same file, else from the server.
 */
export async function showDefPeek(view: EditorView, here: string, path: string, line: number): Promise<boolean> {
  let all: string[];
  if (path === here) {
    all = view.state.doc.toString().split('\n');
  } else {
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const j = (await r.json()) as { content?: string };
      if (typeof j.content !== 'string') return false;
      all = j.content.split('\n');
    } catch {
      return false;
    }
  }
  const from = Math.max(1, line - BEFORE);
  const to = Math.min(all.length, line + AFTER);
  const at = view.state.doc.lineAt(view.state.selection.main.head).to;
  view.dispatch({ effects: setDefPeek.of({ at, path, line, from, lines: all.slice(from - 1, to) }) });
  return true;
}
