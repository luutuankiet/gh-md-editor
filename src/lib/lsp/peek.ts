// The inline peek: Peek Definition and Find All References shown in a block
// under the line that asked, the way VS Code does it. The left pane is a real
// read-only CodeMirror view carrying the main editor's theme and the file's
// language, so the code reads in the same colours as the code around it. The
// right pane lists every location grouped by file; picking a row swaps the
// left pane to that file and line. Not the git change peek (`gmd-peek`), which
// is a different widget entirely.

import { StateField, StateEffect, Prec, EditorState, Text, type Extension } from '@codemirror/state';
import {
  EditorView, Decoration, WidgetType, keymap, lineNumbers, ViewPlugin,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { describeFor } from '../lang-detect';

export interface PeekHit { path: string; line: number; text: string; cols?: [number, number][] }

export interface PeekSpec {
  at: number; // end of the line the widget hangs under
  kind: 'refs' | 'def';
  name: string; // the symbol, boxed in the preview when a hit carries no columns
  hits: PeekHit[]; // sorted by path, then line
  truncated?: boolean;
  here: string; // path of the outer buffer, whose live text is used for it
  theme: Extension; // the outer editor's theme bundle, so the colours match
}

export const setPeek = StateEffect.define<PeekSpec | null>();

// How many lines of code the left pane shows at once.
const ROWS = 18;
const HEAD = 24;

function openAt(path: string, line: number, word?: string) {
  window.dispatchEvent(new CustomEvent('gmd:open-request', { detail: { kind: 'file', path, line, word } }));
}

function splitPath(path: string) {
  const cut = path.lastIndexOf('/');
  return { base: cut < 0 ? path : path.slice(cut + 1), dir: cut < 0 ? '' : path.slice(0, cut) };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Where the symbol sits on a hit's line: the server's columns when it sent
// them, else the first whole-word occurrence of the name.
function colsOf(hit: PeekHit, text: string, name: string): [number, number] | null {
  const c = hit.cols?.[0];
  if (c && c[1] > c[0]) return c;
  if (!name) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).exec(text);
  return m ? [m.index, m.index + name.length] : null;
}

// --- the left pane's target line and boxed word -----------------------------
const setMark = StateEffect.define<{ line: number; cols: [number, number] | null }>();
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) {
      if (!e.is(setMark)) continue;
      const { line, cols } = e.value;
      if (line < 1 || line > tr.state.doc.lines) { v = Decoration.none; continue; }
      const ln = tr.state.doc.line(line);
      const ranges = [Decoration.line({ class: 'cm-peekTarget' }).range(ln.from)];
      if (cols) {
        const from = Math.min(ln.to, ln.from + cols[0]);
        const to = Math.min(ln.to, ln.from + cols[1]);
        if (to > from) ranges.push(Decoration.mark({ class: 'cm-peekMatch' }).range(from, to));
      }
      v = Decoration.set(ranges);
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The peek's own surface. Selectors start below the outer editor's scope class,
// so they outrank the single-class theme rules the nested view inherits.
const innerTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { overflow: 'auto' },
});

interface Group { path: string; base: string; dir: string; hits: number[] }

class Peek {
  dom: HTMLElement;
  private head: HTMLElement;
  private list: HTMLElement | null = null;
  private inner: EditorView | null = null;
  private innerPath: string | null = null;
  private seq = 0;
  private groups: Group[];

  constructor(readonly spec: PeekSpec, readonly st: UiState, readonly outer: EditorView) {
    const box = el('div', 'cm-peekW');
    box.contentEditable = 'false';
    const bodyH = Math.round(ROWS * outer.defaultLineHeight);
    box.style.height = `${HEAD + bodyH + 4}px`;
    this.head = el('div', 'cm-peekHead');
    const body = el('div', 'cm-peekBody');
    const left = el('div', 'cm-peekCode');
    body.append(left);

    const by = new Map<string, number[]>();
    spec.hits.forEach((h, i) => {
      const arr = by.get(h.path);
      if (arr) arr.push(i);
      else by.set(h.path, [i]);
    });
    this.groups = [...by].map(([path, hits]) => ({ path, ...splitPath(path), hits }));

    // A single definition needs no list: the header already names where it is.
    if (spec.kind === 'refs' || spec.hits.length > 1) {
      this.list = el('div', 'cm-peekList');
      this.list.tabIndex = 0;
      this.list.addEventListener('keydown', (e) => this.listKey(e));
      body.append(this.list);
    }
    box.append(this.head, body);
    this.dom = box;

    this.inner = new EditorView({
      parent: left,
      state: EditorState.create({ doc: '' }),
    });
    this.renderList();
    void this.select(st.sel, false);
  }

  get estimatedHeight() {
    return HEAD + Math.round(ROWS * this.outer.defaultLineHeight) + 4;
  }

  close() {
    this.outer.dispatch({ effects: setPeek.of(null) });
    this.outer.focus();
  }

  focus() {
    if (this.list) this.list.focus();
    else this.inner?.focus();
  }

  private renderHead() {
    const hit = this.spec.hits[this.st.sel];
    const { base, dir } = splitPath(hit?.path ?? '');
    const h = this.head;
    h.textContent = '';
    const title = el('span', 'cm-peekTitle');
    title.title = 'Double-click to open';
    title.ondblclick = () => hit && openAt(hit.path, hit.line, this.spec.name);
    title.append(el('span', 'cm-peekBase', base));
    if (dir) title.append(el('span', 'cm-peekDir', dir));
    const n = this.spec.hits.length;
    title.append(el('span', 'cm-peekKind', this.spec.kind === 'refs'
      ? ` - References (${n}${this.spec.truncated ? '+' : ''})`
      : n > 1 ? ` - Definitions (${n})` : ' - Definition'));
    const close = el('span', 'cm-peekClose', '✕');
    close.title = 'Close (Escape)';
    close.onclick = () => this.close();
    h.append(title, close);
  }

  private renderList() {
    const list = this.list;
    if (!list) return;
    list.textContent = '';
    for (const g of this.groups) {
      const folded = this.st.folded.has(g.path);
      const row = el('div', 'cm-peekFile');
      row.append(
        el('span', folded ? 'cm-peekChev folded' : 'cm-peekChev', '⌄'),
        el('span', 'cm-peekFileBase', g.base),
        el('span', 'cm-peekFileDir', g.dir),
        el('span', 'cm-peekCount', String(g.hits.length)),
      );
      row.title = g.path;
      row.onclick = () => { this.toggle(g.path); list.focus(); };
      list.append(row);
      if (folded) continue;
      for (const i of g.hits) {
        const h = this.spec.hits[i];
        const r = el('div', i === this.st.sel ? 'cm-peekHit sel' : 'cm-peekHit');
        r.dataset.i = String(i);
        // Leading indentation dropped so the matched word sits as far left as
        // the list can put it.
        const lead = h.text.length - h.text.trimStart().length;
        const c = colsOf(h, h.text, this.spec.name);
        const from = c ? Math.max(lead, c[0]) : lead;
        const to = c ? Math.max(from, c[1]) : from;
        r.append(
          document.createTextNode(h.text.slice(lead, from)),
          el('mark', 'cm-peekHitMark', h.text.slice(from, to)),
          document.createTextNode(h.text.slice(to)),
        );
        r.title = `${h.path}:${h.line} - Enter or double-click to open`;
        r.onclick = () => { void this.select(i); list.focus(); };
        r.ondblclick = () => openAt(h.path, h.line, this.spec.name);
        list.append(r);
      }
    }
    list.querySelector('.cm-peekHit.sel')?.scrollIntoView({ block: 'nearest' });
  }

  // Moves the highlight without rebuilding the rows: a rebuild between the two
  // clicks of a double-click removes the row under the pointer, and the
  // browser then never fires the dblclick that opens the location.
  private markSel() {
    const list = this.list;
    if (!list) return;
    const row = list.querySelector(`.cm-peekHit[data-i="${this.st.sel}"]`);
    if (!row) { this.renderList(); return; }
    list.querySelector('.cm-peekHit.sel')?.classList.remove('sel');
    row.classList.add('sel');
    row.scrollIntoView({ block: 'nearest' });
  }

  private toggle(path: string) {
    if (this.st.folded.has(path)) this.st.folded.delete(path);
    else this.st.folded.add(path);
    this.renderList();
  }

  // Arrow keys walk what is on screen; a hit inside a folded group is not.
  private visible(): number[] {
    return this.groups.filter((g) => !this.st.folded.has(g.path)).flatMap((g) => g.hits);
  }

  private listKey(e: KeyboardEvent) {
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    const hit = this.spec.hits[this.st.sel];
    if (k === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (hit) openAt(hit.path, hit.line, this.spec.name);
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      if (!hit) return;
      const folded = this.st.folded.has(hit.path);
      if (k === 'ArrowLeft' ? !folded : folded) this.toggle(hit.path);
      return;
    }
    if (k !== 'ArrowDown' && k !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const vis = this.visible();
    if (!vis.length) return;
    const at = vis.indexOf(this.st.sel);
    const next = at < 0 ? 0 : (at + (k === 'ArrowDown' ? 1 : vis.length - 1)) % vis.length;
    void this.select(vis[next]);
  }

  private async text(path: string): Promise<string | null> {
    if (path === this.spec.here) return this.outer.state.doc.toString();
    const hit = this.st.cache.get(path);
    if (hit !== undefined) return hit;
    try {
      const j = (await (await fetch(`/api/file?path=${encodeURIComponent(path)}`)).json()) as { content?: string };
      if (typeof j.content !== 'string') return null;
      this.st.cache.set(path, j.content);
      return j.content;
    } catch {
      return null;
    }
  }

  private innerExtensions(lang: Extension): Extension {
    return [
      EditorState.readOnly.of(true),
      lineNumbers(),
      this.spec.theme,
      innerTheme,
      lang,
      markField,
      Prec.highest(keymap.of([
        { key: 'Escape', run: () => { this.close(); return true; } },
      ])),
      // Escape is handled above; stopping it here keeps the same keystroke from
      // also reaching a panel listener further up the page.
      EditorView.domEventHandlers({
        keydown: (e) => { if (e.key === 'Escape') e.stopPropagation(); return false; },
      }),
    ];
  }

  async select(i: number, rerender = true) {
    const hit = this.spec.hits[i];
    if (!hit) return;
    this.st.sel = i;
    this.renderHead();
    if (rerender) this.markSel();
    const seq = ++this.seq;
    const inner = this.inner;
    if (!inner) return;
    if (this.innerPath !== hit.path) {
      const content = await this.text(hit.path);
      if (seq !== this.seq || !this.inner) return;
      const desc = describeFor(hit.path);
      let lang: Extension = [];
      if (desc) {
        try { lang = desc.support ?? (await desc.load()); } catch { /* plain text */ }
      }
      if (seq !== this.seq || !this.inner) return;
      inner.setState(EditorState.create({
        doc: Text.of((content ?? `Could not load ${hit.path}`).split('\n')),
        extensions: this.innerExtensions(lang),
      }));
      this.innerPath = hit.path;
    }
    const doc = inner.state.doc;
    const n = Math.max(1, Math.min(hit.line, doc.lines));
    const ln = doc.line(n);
    const cols = colsOf(hit, ln.text, this.spec.name);
    inner.dispatch({
      effects: [
        setMark.of({ line: n, cols }),
        // A few lines of context above the target, as VS Code leaves.
        EditorView.scrollIntoView(ln.from, { y: 'start', yMargin: 4 * inner.defaultLineHeight }),
      ],
      selection: { anchor: ln.from + (cols?.[0] ?? 0) },
    });
  }

  destroy() {
    this.seq++;
    this.inner?.destroy();
    this.inner = null;
  }
}

// What survives the widget being torn down and rebuilt, which CodeMirror does
// whenever the line it hangs under scrolls out of the viewport and back.
interface UiState { sel: number; folded: Set<string>; cache: Map<string, string> }
const ui = new WeakMap<PeekSpec, UiState>();

class PeekWidget extends WidgetType {
  private peek: Peek | null = null;
  constructor(readonly spec: PeekSpec) { super(); }
  eq(o: PeekWidget) { return o.spec === this.spec; }
  get estimatedHeight() { return HEAD + Math.round(ROWS * 19) + 4; }
  toDOM(view: EditorView) {
    let st = ui.get(this.spec);
    const first = !st;
    if (!st) {
      // Start on the hit the peek was opened from, as VS Code does, so the
      // first thing shown is the line under the caret rather than whichever
      // file sorts first.
      const line = view.state.doc.lineAt(Math.min(this.spec.at, view.state.doc.length)).number;
      const hits = this.spec.hits;
      let sel = hits.findIndex((h) => h.path === this.spec.here && h.line === line);
      if (sel < 0) sel = hits.findIndex((h) => h.path === this.spec.here);
      st = { sel: Math.max(0, sel), folded: new Set(), cache: new Map() };
      ui.set(this.spec, st);
    }
    this.peek = new Peek(this.spec, st, view);
    const p = this.peek;
    if (first) setTimeout(() => { if (p.dom.isConnected) p.focus(); }, 0);
    return p.dom;
  }
  destroy() { this.peek?.destroy(); this.peek = null; }
  // Clicks and keys inside belong to the peek, not to the outer editor.
  ignoreEvent() { return true; }
}

const field = StateField.define<PeekSpec | null>({
  create: () => null,
  update(v, tr) {
    // Any edit closes it: the widget hangs at a fixed offset and the lines it
    // shows may be the ones just edited.
    if (tr.docChanged) v = null;
    for (const e of tr.effects) if (e.is(setPeek)) v = e.value;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) =>
    v ? Decoration.set([Decoration.widget({ widget: new PeekWidget(v), block: true, side: 1 }).range(v.at)]) : Decoration.none),
});

// The peek spans the visible width rather than the content's, which on a file
// with long lines is far wider than the screen and would push the list and the
// close button out of sight. Sticky against the scroller, beside the gutter.
const widthSync = ViewPlugin.fromClass(class {
  constructor(v: EditorView) { this.sync(v); }
  update(u: ViewUpdate) { if (u.geometryChanged || u.viewportChanged) this.sync(u.view); }
  sync(v: EditorView) {
    v.requestMeasure({
      read: () => {
        const g = v.dom.querySelector('.cm-gutters') as HTMLElement | null;
        return { w: v.scrollDOM.clientWidth, g: g?.offsetWidth ?? 0 };
      },
      write: (m) => {
        v.dom.style.setProperty('--gmd-peek-w', `${Math.max(200, m.w - m.g)}px`);
        v.dom.style.setProperty('--gmd-peek-left', `${m.g}px`);
      },
    });
  }
});

const accent = '#4daafc';
const theme = EditorView.baseTheme({
  '.cm-peekW': {
    position: 'sticky',
    left: 'var(--gmd-peek-left, 0)',
    width: 'var(--gmd-peek-w, 100%)',
    boxSizing: 'border-box',
    margin: '2px 0',
    borderTop: `2px solid ${accent}`,
    borderBottom: `2px solid ${accent}`,
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '13px',
    whiteSpace: 'normal',
    cursor: 'default',
  },
  '&dark .cm-peekW': { backgroundColor: '#252526', color: '#cccccc' },
  '&light .cm-peekW': { backgroundColor: '#f3f3f3', color: '#333333' },
  '.cm-peekHead': {
    flex: `0 0 ${HEAD}px`,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 8px 0 12px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  '&dark .cm-peekHead': { backgroundColor: '#1f2a36', borderBottom: '1px solid #2b3b4f' },
  '&light .cm-peekHead': { backgroundColor: '#e4eef8', borderBottom: '1px solid #c8d8e8' },
  '.cm-peekTitle': { flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-peekBase': { fontWeight: '600' },
  '.cm-peekDir': { marginLeft: '6px', opacity: '0.6' },
  '.cm-peekKind': { opacity: '0.9' },
  '.cm-peekClose': { flex: '0 0 auto', cursor: 'pointer', padding: '0 4px', opacity: '0.8' },
  '.cm-peekClose:hover': { opacity: '1' },
  '.cm-peekBody': { flex: '1 1 auto', display: 'flex', minHeight: '0' },
  '.cm-peekCode': { flex: '1 1 65%', minWidth: '0', height: '100%' },
  // Tinted, so the borrowed code reads as a window onto another place.
  '&dark .cm-peekCode .cm-editor, &dark .cm-peekCode .cm-gutters': { backgroundColor: '#001b2e' },
  '&light .cm-peekCode .cm-editor, &light .cm-peekCode .cm-gutters': { backgroundColor: '#eaf3fb' },
  '.cm-peekCode .cm-editor': { height: '100%' },
  '.cm-peekCode .cm-editor.cm-focused': { outline: 'none' },
  '&dark .cm-peekCode .cm-peekTarget': { backgroundColor: 'rgba(255, 255, 255, 0.07)' },
  '&light .cm-peekCode .cm-peekTarget': { backgroundColor: 'rgba(0, 0, 0, 0.06)' },
  '.cm-peekCode .cm-peekMatch': {
    backgroundColor: 'rgba(234, 92, 0, 0.33)',
    outline: '1px solid #f38518',
  },
  '.cm-peekList': {
    flex: '0 0 35%',
    maxWidth: '480px',
    minWidth: '200px',
    overflow: 'auto',
    padding: '2px 0',
    outline: 'none',
  },
  '&dark .cm-peekList': { borderLeft: '1px solid #2b3b4f' },
  '&light .cm-peekList': { borderLeft: '1px solid #c8d8e8' },
  '.cm-peekFile': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '1px 8px 1px 6px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    lineHeight: '22px',
  },
  '.cm-peekChev': { flex: '0 0 12px', textAlign: 'center', opacity: '0.8', transition: 'transform 0.1s' },
  '.cm-peekChev.folded': { transform: 'rotate(-90deg)' },
  '.cm-peekFileBase': { flex: '0 0 auto' },
  '.cm-peekFileDir': { flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', opacity: '0.6', fontSize: '12px' },
  '.cm-peekCount': {
    flex: '0 0 auto',
    minWidth: '18px',
    padding: '0 5px',
    borderRadius: '9px',
    fontSize: '11px',
    lineHeight: '18px',
    textAlign: 'center',
  },
  '&dark .cm-peekCount': { backgroundColor: '#4d4d4d', color: '#ffffff' },
  '&light .cm-peekCount': { backgroundColor: '#c4c4c4', color: '#333333' },
  '.cm-peekHit': {
    padding: '1px 8px 1px 30px',
    cursor: 'pointer',
    whiteSpace: 'pre',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    lineHeight: '22px',
  },
  '&dark .cm-peekFile:hover, &dark .cm-peekHit:hover': { backgroundColor: '#2a2d2e' },
  '&light .cm-peekFile:hover, &light .cm-peekHit:hover': { backgroundColor: '#e8e8e8' },
  '&dark .cm-peekHit.sel': { backgroundColor: '#04395e', color: '#ffffff' },
  '&light .cm-peekHit.sel': { backgroundColor: '#cce4f7' },
  '.cm-peekHitMark': {
    backgroundColor: 'rgba(234, 92, 0, 0.33)',
    color: 'inherit',
    borderRadius: '2px',
  },
});

const escape = Prec.high(keymap.of([{
  key: 'Escape',
  run: (v) => {
    if (!v.state.field(field, false)) return false;
    v.dispatch({ effects: setPeek.of(null) });
    return true;
  },
}]));

export const peekInline: Extension = [field, theme, escape, widthSync];

/** Open the peek under the line holding `pos`. */
export function showPeek(view: EditorView, pos: number, spec: Omit<PeekSpec, 'at'>) {
  const at = view.state.doc.lineAt(Math.min(pos, view.state.doc.length)).to;
  view.dispatch({ effects: setPeek.of({ ...spec, at }) });
}
