// The `N references` row above each declaration, from the language server
// only. Positions come from `textDocument/documentSymbol`, so a decorator or a
// local variable never gets a row; counts come from `textDocument/references`
// without the declaration, asked lazily for the symbols on screen and cached
// per document version. A server with its own code lenses is shown as is.
// Clicking a row opens the References peek with the very locations it counted.

import { StateEffect, StateField, RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Conn } from './client';
import { askAt, lspReferencesAt, normalize, type LspLoc, type LspPosition } from './actions';

export interface LensOpts {
  conn: Conn;
  uri: string;
  /** Opens the References peek under `pos` with `locs`. */
  open(view: EditorView, pos: number, name: string, locs: LspLoc[]): void;
}

interface Row {
  line: number; // 1-based line the row sits above
  title: string;
  name: string;
  at: LspPosition; // where the symbol's name is
  locs: LspLoc[] | null; // what a click opens; null asks the server again
}

// Module, Namespace, Class, Method, Constructor, Enum, Interface, Function.
const KINDS = new Set([2, 3, 5, 6, 9, 10, 11, 12]);
const DEBOUNCE_MS = 300;

interface Pos { line: number; character: number }
interface RangeL { start: Pos; end: Pos }
interface DocSymbol { name: string; kind: number; range: RangeL; selectionRange: RangeL; children?: DocSymbol[] }
interface SymInfo { name: string; kind: number; location: { range: RangeL } }
interface Sym { name: string; line: number; at: LspPosition }

function flatten(raw: unknown): Sym[] {
  const out: Sym[] = [];
  const walk = (list: (DocSymbol | SymInfo)[]) => {
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      if ('location' in s) {
        if (KINDS.has(s.kind)) out.push({ name: s.name, line: s.location.range.start.line + 1, at: s.location.range.start });
        continue;
      }
      // The row sits above the full range, which in Python starts at the
      // decorator, and the count is asked at the name itself.
      if (KINDS.has(s.kind)) out.push({ name: s.name, line: s.range.start.line + 1, at: s.selectionRange.start });
      if (s.children) walk(s.children);
    }
  };
  if (Array.isArray(raw)) walk(raw as (DocSymbol | SymInfo)[]);
  return out;
}

class LensWidget extends WidgetType {
  constructor(readonly row: Row, readonly indent: number, readonly click: (row: Row, dom: HTMLElement) => void) { super(); }
  eq(o: LensWidget) {
    return o.row.title === this.row.title && o.row.line === this.row.line && o.indent === this.indent && o.row.locs === this.row.locs;
  }
  toDOM() {
    const wrap = document.createElement('div');
    const live = this.row.locs == null || this.row.locs.length > 0;
    wrap.className = live ? 'cm-refLens' : 'cm-refLens empty';
    // Aligned with its declaration: a nested method's row at column zero reads
    // as belonging to the class above it.
    wrap.style.paddingLeft = `${this.indent}ch`;
    const link = document.createElement('span');
    link.className = 'cm-refLensLink';
    link.textContent = this.row.title;
    if (live) {
      link.setAttribute('role', 'button');
      link.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // Without this the click also places the caret, which scrolls the
        // buffer away from the declaration the peek opens under.
        e.preventDefault();
        e.stopPropagation();
        this.click(this.row, wrap);
      });
    }
    wrap.appendChild(link);
    return wrap;
  }
  ignoreEvent() { return true; }
}

function plural(n: number) { return n === 1 ? '1 reference' : `${n} references`; }

export function referencesLens(opts: LensOpts): Extension {
  const setRows = StateEffect.define<{ rows: Row[]; view: EditorView }>();

  const plugin = ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined;
    seq = 0;
    syms = new WeakMap<Text, Promise<Sym[]>>();
    counts = new WeakMap<Text, Map<string, Promise<LspLoc[] | null>>>();
    lenses = new WeakMap<Text, Promise<Row[] | null>>();
    constructor(readonly view: EditorView) { this.schedule(); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.schedule(); }
    destroy() { clearTimeout(this.timer); this.seq++; }
    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
    }

    async refresh() {
      const view = this.view;
      const doc = view.state.doc;
      const seq = ++this.seq;
      const client = opts.conn.client;
      const caps = client.serverCapabilities;
      if (!client.connected || !caps) return;
      let rows: Row[] | null = null;
      try {
        if (caps.codeLensProvider) rows = await this.serverLenses(doc);
        if (!rows && caps.referencesProvider) rows = await this.countedRows(doc);
      } catch { return; /* keep the last rows; the next settle asks again */ }
      if (seq !== this.seq || view.state.doc !== doc || !rows) return;
      view.dispatch({ effects: setRows.of({ rows, view }) });
    }

    symbols(doc: Text): Promise<Sym[]> {
      let p = this.syms.get(doc);
      if (!p) {
        p = (async () => {
          const c = opts.conn.client;
          c.sync();
          return flatten(await c.request('textDocument/documentSymbol', { textDocument: { uri: opts.uri } }));
        })();
        p.catch(() => this.syms.delete(doc));
        this.syms.set(doc, p);
      }
      return p;
    }

    async countedRows(doc: Text): Promise<Row[]> {
      const syms = await this.symbols(doc);
      // Only what is on screen is counted; each row's count is one search of
      // the whole project.
      const vis = this.view.visibleRanges;
      const first = vis.length ? doc.lineAt(vis[0].from).number : 1;
      const last = vis.length ? doc.lineAt(vis[vis.length - 1].to).number : doc.lines;
      let per = this.counts.get(doc);
      if (!per) this.counts.set(doc, (per = new Map()));
      const seen = new Set<number>();
      const rows: Row[] = [];
      const jobs: Promise<void>[] = [];
      for (const s of syms) {
        if (s.line < first - 1 || s.line > last + 1 || seen.has(s.line)) continue;
        seen.add(s.line);
        const key = `${s.at.line}:${s.at.character}`;
        let p = per.get(key);
        if (!p) {
          p = lspReferencesAt(opts.conn, opts.uri, s.at, false).catch(() => null);
          per.set(key, p);
        }
        jobs.push(p.then((locs) => {
          if (locs) rows.push({ line: s.line, title: plural(locs.length), name: s.name, at: s.at, locs });
        }));
      }
      await Promise.all(jobs);
      return rows.sort((a, b) => a.line - b.line);
    }

    serverLenses(doc: Text): Promise<Row[] | null> {
      let p = this.lenses.get(doc);
      if (!p) {
        p = (async () => {
          const c = opts.conn.client;
          c.sync();
          type Lens = { range: RangeL; command?: { title: string; arguments?: unknown[] }; data?: unknown };
          const got = (await c.request('textDocument/codeLens', { textDocument: { uri: opts.uri } })) as Lens[] | null;
          if (!got?.length) return null;
          const resolve = !!(c.serverCapabilities?.codeLensProvider as { resolveProvider?: boolean } | undefined)?.resolveProvider;
          const done = await Promise.all(got.map(async (l) => (
            l.command || !resolve ? l : ((await c.request('codeLens/resolve', l).catch(() => l)) as Lens)
          )));
          const rows: Row[] = [];
          for (const l of done) {
            if (!l.command?.title) continue;
            // VS Code's show-references command carries the locations as its
            // third argument; other commands get the server's references.
            const args = l.command.arguments;
            const locs = Array.isArray(args) && Array.isArray(args[2]) ? normalize(args[2]) : null;
            rows.push({ line: l.range.start.line + 1, title: l.command.title, name: '', at: l.range.start, locs });
          }
          return rows.sort((a, b) => a.line - b.line);
        })();
        p.catch(() => this.lenses.delete(doc));
        this.lenses.set(doc, p);
      }
      return p;
    }
  });

  const click = (view: EditorView) => async (row: Row, dom: HTMLElement) => {
    let at: number;
    try { at = view.posAtDOM(dom); } catch { at = view.state.selection.main.head; }
    // The peek hangs under the declaration's name line, below a decorator.
    const doc = view.state.doc;
    const nameLine = row.at.line + 1;
    if (nameLine >= 1 && nameLine <= doc.lines) at = doc.line(nameLine).from;
    let locs = row.locs;
    if (!locs) {
      try { locs = await lspReferencesAt(opts.conn, opts.uri, row.at, false); } catch { locs = []; }
    }
    const w = view.state.wordAt(Math.min(doc.length, at + row.at.character));
    const name = row.name || (w ? view.state.sliceDoc(w.from, w.to) : '');
    opts.open(view, at, name, locs);
  };

  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(set, tr) {
      let next = set.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setRows)) continue;
        const doc = tr.state.doc;
        const view = e.value.view;
        const b = new RangeSetBuilder<Decoration>();
        for (const r of e.value.rows) {
          if (r.line < 1 || r.line > doc.lines) continue;
          const ln = doc.line(r.line);
          const indent = /^[ \t]*/.exec(ln.text)?.[0].length ?? 0;
          b.add(ln.from, ln.from, Decoration.widget({
            widget: new LensWidget(r, indent, click(view)),
            block: true,
            side: -1,
          }));
        }
        next = b.finish();
      }
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });


  return [plugin, field, lensTheme];
}

const lensTheme = EditorView.baseTheme({
  // Deliberately quiet: it sits above every declaration in the file, so
  // anything louder would out-shout the code it annotates.
  '.cm-refLens': {
    paddingTop: '2px',
    fontSize: '11px',
    lineHeight: '1.3',
    color: '#7a7a7a',
    userSelect: 'none',
    fontFamily: 'system-ui, sans-serif',
  },
  '.cm-refLensLink': { cursor: 'pointer' },
  '.cm-refLensLink:hover': { color: '#4daafc', textDecoration: 'underline' },
  '.cm-refLens.empty .cm-refLensLink': { cursor: 'default', opacity: '0.65' },
});
