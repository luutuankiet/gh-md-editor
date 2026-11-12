// Overview ruler: a thin strip down the editor's right edge with one tick per
// diagnostic line, red for errors, yellow for warnings, blue for the rest, at
// the line's height in the whole document (not the viewport). Clicking a tick
// moves the cursor to that diagnostic. Reads the lint state the LSP
// extension fills, so it shows exactly what the squiggles show.
import { forEachDiagnostic } from '@codemirror/lint';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';

const COLORS: Record<string, string> = { error: '#f14c4c', warning: '#cca700', info: '#3794ff', hint: '#3794ff' };
const RANK: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };

interface Tick { line: number; from: number; severity: string }

class Ruler implements PluginValue {
  dom: HTMLDivElement;
  key = '';

  constructor(readonly view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'gmd-overview-ruler';
    this.dom.setAttribute('aria-hidden', 'true');
    view.dom.appendChild(this.dom);
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.geometryChanged || u.heightChanged || u.transactions.length) this.schedule();
  }

  schedule() {
    this.view.requestMeasure({
      key: this,
      read: (v) => {
        // One tick per line: the worst severity on it wins.
        const byLine = new Map<number, Tick>();
        forEachDiagnostic(v.state, (d, from) => {
          const line = v.state.doc.lineAt(from).number;
          const have = byLine.get(line);
          if (!have || RANK[d.severity] < RANK[have.severity]) byLine.set(line, { line, from, severity: d.severity });
        });
        const total = Math.max(v.contentHeight, 1);
        const ticks = [...byLine.values()].map((t) => ({ ...t, frac: v.lineBlockAt(t.from).top / total }));
        return { ticks, height: v.scrollDOM.clientHeight };
      },
      write: ({ ticks, height }) => this.draw(ticks, height),
    });
  }

  draw(ticks: (Tick & { frac: number })[], height: number) {
    const key = `${height}|${ticks.map((t) => `${t.from}:${t.severity}:${t.frac.toFixed(4)}`).join(',')}`;
    if (key === this.key) return;
    this.key = key;
    this.dom.replaceChildren();
    // Draw the less severe first so an error on a nearby line stays on top.
    for (const t of [...ticks].sort((a, b) => RANK[b.severity] - RANK[a.severity])) {
      const el = document.createElement('div');
      el.className = 'gmd-overview-tick';
      el.style.top = `${Math.min(Math.round(t.frac * height), height - 3)}px`;
      el.style.background = COLORS[t.severity] ?? COLORS.info;
      el.title = `Line ${t.line}`;
      el.onmousedown = (e) => {
        e.preventDefault();
        this.view.dispatch({ selection: { anchor: t.from }, effects: EditorView.scrollIntoView(t.from, { y: 'center' }) });
        this.view.focus();
      };
      this.dom.appendChild(el);
    }
  }

  destroy() { this.dom.remove(); }
}

export const overviewRuler = [
  ViewPlugin.fromClass(Ruler),
  EditorView.theme({
    '.gmd-overview-ruler': {
      position: 'absolute', top: '0', right: '0', bottom: '0', width: '8px',
      pointerEvents: 'none', zIndex: '5',
    },
    '.gmd-overview-tick': {
      position: 'absolute', left: '0', right: '0', height: '3px',
      pointerEvents: 'auto', cursor: 'pointer',
    },
  }),
];
