<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap, gutter, GutterMarker, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
  import type { DecorationSet, ViewUpdate } from '@codemirror/view';
  import { EditorState, EditorSelection, Compartment, StateField, StateEffect, Facet, RangeSet, RangeSetBuilder } from '@codemirror/state';
  import { unifiedMergeView, getChunks, getOriginalDoc, rejectChunk } from '@codemirror/merge';
  import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
  import {
    indentOnInput,
    bracketMatching,
    LanguageDescription,
    syntaxHighlighting,
    defaultHighlightStyle,
    codeFolding,
    foldGutter,
    foldKeymap,
    foldService,
    syntaxTree,
  } from '@codemirror/language';
  import { highlightTree } from '@lezer/highlight';
  import { indentFoldService } from '../../lib/fold-indent';
  import { TAB_DND_MIME, PATH_DND_MIME } from '../../lib/dnd';
  import { search, searchKeymap, getSearchQuery, searchPanelOpen } from '@codemirror/search';
  import { matchCountBadge } from '../../lib/search-count';
  import { selectAllOccurrences } from '../../lib/select-occurrences';
  import { indentationMarkers } from '@replit/codemirror-indentation-markers';
  import { indentRainbow } from '../../lib/indent-rainbow';
  import { dotenvCloak, setCloak, cloakState } from '../../lib/dotenv-cloak';
  import { isDotenvFile } from '../../lib/lang-dotenv';
  import { wordHighlight, wordMatchRanges } from '../../lib/word-highlight';
  import { monokaiCodeBundle, monokaiCodeHighlight } from '../../lib/monokai-dimmed';

  import { outlineFromState } from '../../lib/code-outline';
  import type { OutlineNode } from '../../lib/code-outline';
  import { LANGS, describeFor } from '../../lib/lang-detect';
  import { expandSelection, shrinkSelection, resetSelectionHistory } from '../../lib/expand-selection';
  import { formatDocumentText } from '../../lib/format-doc';
  import { wrapFor, toggleWrapFor, tabViewOf, patchTabView } from '../../lib/tab-view-state.svelte';
  import { readScrollAnchor, applyScrollAnchor } from '../../lib/cm-scroll-anchor';
  import { highlightToLines, scopeForFilename } from '../../lib/diff-highlight';
  import type { Tok } from '../../lib/diff-highlight';


  // --- inline change gutter ---------------------------------------------------
  // VS Code's dirty-diff, built on CodeMirror's merge machinery. That package
  // supplies the part worth reusing — a chunk model that re-diffs itself on
  // every keystroke — but not its presentation: it renders every deleted chunk
  // as an always-visible block, which turns a lightly-edited file into a wall
  // of text. So all of its visuals are switched off, its deleted-chunk widgets
  // are hidden in CSS, and what is left is the diff, the original document and
  // revert. The gutter and the peek panel below are this file's own.
  const diffCompartment = new Compartment();

  // `gutter` is read by the implementation but missing from the published
  // option type, hence the cast. The config type itself is declared but never
  // exported, so it is reached through the function's own signature.
  const mergeOff = (original: string) => ({
    original,
    highlightChanges: false,
    mergeControls: false,
    allowInlineDiffs: false,
    gutter: false,
  }) as unknown as Parameters<typeof unifiedMergeView>[0];

  // Where the original text came from, for the peek panel's label.
  const originalSource = Facet.define<string, string>({ combine: (v) => v[0] ?? 'index' });

  // Chunk starts (positions in the CURRENT document) whose original text is
  // expanded. A set rather than a single position: having to close one change
  // to read another is exactly the friction that stops people using this.
  // A brief tint on the symbol a navigation resolved to. A state field rather
  // than a static decoration so the range maps through edits — a jump landing
  // moments before a save-format would otherwise leave a stale offset behind.
  const setNavFlash = StateEffect.define<{ from: number; to: number } | null>();
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const navFlashField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(set, tr) {
      let next = set.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setNavFlash)) continue;
        next = e.value
          ? Decoration.set([Decoration.mark({ class: 'cm-navFlash' }).range(e.value.from, e.value.to)])
          : Decoration.none;
      }
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const toggleChangePeek = StateEffect.define<number>();

  const changePeeks = StateField.define<Set<number>>({
    create: () => new Set<number>(),
    update(open, tr) {
      // Any edit re-runs the diff, so these positions stop naming the same
      // chunks — including the revert a panel just performed on itself.
      if (tr.docChanged) return open.size ? new Set<number>() : open;
      let next = open;
      for (const e of tr.effects) {
        if (!e.is(toggleChangePeek)) continue;
        next = new Set(next);
        if (next.has(e.value)) next.delete(e.value);
        else next.add(e.value);
      }
      return next;
    },
  });

  class OriginalTextWidget extends WidgetType {
    text: string;
    pos: number;
    label: string;
    // Written out rather than declared as constructor parameter properties:
    // Svelte parses TypeScript in a component without that extension and
    // rejects it outright.
    constructor(text: string, pos: number, label: string) {
      super();
      this.text = text;
      this.pos = pos;
      this.label = label;
    }
    eq(other: OriginalTextWidget) {
      return other.text === this.text && other.pos === this.pos && other.label === this.label;
    }
    toDOM(vw: EditorView) {
      const wrap = document.createElement('div');
      wrap.className = 'gmd-peek';
      const bar = wrap.appendChild(document.createElement('div'));
      bar.className = 'gmd-peek-bar';
      const label = bar.appendChild(document.createElement('span'));
      label.className = 'gmd-peek-label';
      label.textContent = this.text ? `in ${this.label}` : `added — not in ${this.label}`;
      const revert = bar.appendChild(document.createElement('button'));
      revert.type = 'button';
      revert.className = 'gmd-peek-btn';
      revert.textContent = 'Revert';
      revert.title = this.text ? 'Put this chunk back to the version shown' : 'Remove these added lines';
      const close = bar.appendChild(document.createElement('button'));
      close.type = 'button';
      close.className = 'gmd-peek-btn';
      close.textContent = 'Close';
      // mousedown is how CodeMirror moves the selection into a widget; swallowing
      // it leaves the cursor where the user left it.
      for (const b of [revert, close]) b.addEventListener('mousedown', (e) => e.preventDefault());
      // Client-side revert, not the server's patch route: this is an ordinary
      // document edit, so it joins the undo history and is saved like any other.
      revert.addEventListener('click', () => { rejectChunk(vw, this.pos); vw.focus(); });
      close.addEventListener('click', () => { vw.dispatch({ effects: toggleChangePeek.of(this.pos) }); vw.focus(); });
      if (this.text) {
        const pre = wrap.appendChild(document.createElement('pre'));
        pre.className = 'gmd-peek-text';
        pre.textContent = this.text;
      }
      return wrap;
    }
    ignoreEvent() { return false; }
  }

  function buildPeeks(state: EditorState): DecorationSet {
    const open = state.field(changePeeks, false);
    if (!open || open.size === 0) return Decoration.none;
    const info = getChunks(state);
    if (!info) return Decoration.none;
    const orig = getOriginalDoc(state);
    const label = state.facet(originalSource);
    const out = [];
    for (const ch of info.chunks) {
      if (!open.has(ch.fromB)) continue;
      out.push(
        Decoration.widget({
          widget: new OriginalTextWidget(orig.sliceString(ch.fromA, Math.max(ch.fromA, ch.endA)), ch.fromB, label),
          block: true,
          side: -1,
        }).range(ch.fromB),
      );
    }
    return Decoration.set(out, true);
  }

  const changePeekDecorations = StateField.define<DecorationSet>({
    create: (state) => buildPeeks(state),
    update(deco, tr) {
      // Effects are checked as well: swapping in a new original document is a
      // reconfigure, which changes the chunks without touching the document.
      if (
        !tr.docChanged && tr.effects.length === 0 &&
        tr.startState.field(changePeeks, false) === tr.state.field(changePeeks, false)
      ) return deco;
      return buildPeeks(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  class ChangeMarker extends GutterMarker {
    elementClass: string;
    constructor(cls: string) {
      super();
      this.elementClass = cls;
    }
    eq(other: ChangeMarker) { return other.elementClass === this.elementClass; }
  }
  const MOD_MARKER = new ChangeMarker('gmd-chg gmd-chg-mod');
  const ADD_MARKER = new ChangeMarker('gmd-chg gmd-chg-add');
  const DEL_MARKER = new ChangeMarker('gmd-chg gmd-chg-del');

  const changeGutter = gutter({
    class: 'gmd-change-gutter',
    markers: (vw) => {
      const info = getChunks(vw.state);
      if (!info) return RangeSet.empty;
      const doc = vw.state.doc;
      const b = new RangeSetBuilder<GutterMarker>();
      for (const ch of info.chunks) {
        // Nothing was added: the chunk exists only in the original, so there is
        // no line of ours to paint. Mark where it was removed from instead.
        if (ch.fromB === ch.toB) {
          b.add(ch.fromB, ch.fromB, DEL_MARKER);
          continue;
        }
        const marker = ch.fromA === ch.toA ? ADD_MARKER : MOD_MARKER;
        for (let line = doc.lineAt(ch.fromB); ; ) {
          b.add(line.from, line.from, marker);
          if (line.to >= ch.endB || line.to + 1 > doc.length) break;
          line = doc.lineAt(line.to + 1);
        }
      }
      return b.finish();
    },
    // Without a spacer the column has no width until the first change lands,
    // and the whole document shifts sideways the moment one does.
    initialSpacer: () => MOD_MARKER,
    domEventHandlers: {
      mousedown: (vw, line, event) => {
        const info = getChunks(vw.state);
        if (!info) return false;
        const hit = info.chunks.find((ch) => ch.fromB <= line.to && ch.endB >= line.from);
        if (!hit) return false;
        event.preventDefault();
        vw.dispatch({ effects: toggleChangePeek.of(hit.fromB) });
        return true;
      },
    },
  });

  // --- blame gutter -----------------------------------------------------------
  // Who last touched each line, in a column of its own to the left of the line
  // numbers. Off by default, and toggled for the whole window rather than per
  // tab: turning it on while reading one file and finding it off in the next
  // reads as a bug.
  const blameCompartment = new Compartment();

  interface BlameCommit {
    sha: string;
    short: string;
    author: string;
    // Milliseconds — the server has already scaled git's seconds.
    authorTime: number;
    summary: string;
    uncommitted: boolean;
  }
  interface BlameData { commits: BlameCommit[]; lines: number[] }

  const MONTH = 30 * 24 * 3600 * 1000;
  // Ages, not dates: the useful question at a glance is whether a line is old
  // or new, and the exact timestamp is one hover away.
  function ago(ms: number) {
    const d = Date.now() - ms;
    if (d < 3600_000) return `${Math.max(1, Math.round(d / 60_000))}m ago`;
    if (d < 86400_000) return `${Math.round(d / 3600_000)}h ago`;
    if (d < MONTH) return `${Math.round(d / 86400_000)}d ago`;
    if (d < 12 * MONTH) return `${Math.round(d / MONTH)}mo ago`;
    return `${Math.round(d / (12 * MONTH))}y ago`;
  }

  class BlameMarker extends GutterMarker {
    text: string;
    hint: string;
    cls: string;
    constructor(text: string, hint: string, cls: string) {
      super();
      this.text = text;
      this.hint = hint;
      this.cls = cls;
    }
    eq(other: BlameMarker) {
      return other.text === this.text && other.hint === this.hint && other.cls === this.cls;
    }
    toDOM() {
      const el = document.createElement('span');
      el.className = this.cls;
      el.textContent = this.text;
      el.title = this.hint;
      return el;
    }
  }
  // Sizes the column before the first marker renders, so switching blame on
  // shoves the text sideways once rather than twice. Anything longer than this
  // is clipped rather than allowed to widen the column further.
  const BLAME_SPACER = new BlameMarker('Somebody 00mo ago', '', 'gmd-blame');

  function blameGutter(data: BlameData) {
    const markers: (BlameMarker | null)[] = [];
    let prev = -1;
    for (const ci of data.lines) {
      const c = data.commits[ci];
      if (!c) { markers.push(null); prev = -1; continue; }
      const hint = c.uncommitted
        ? 'Not committed yet'
        : `${c.summary}\n\n${c.sha}\n${c.author} — ${new Date(c.authorTime).toLocaleString()}`;
      // A run of lines from one commit is labelled once. Forty repeats of the
      // same name is noise, and suppressing them is what makes the boundaries
      // between commits legible at a glance.
      if (ci === prev) markers.push(new BlameMarker('', hint, 'gmd-blame gmd-blame-run'));
      else if (c.uncommitted) markers.push(new BlameMarker('Uncommitted', hint, 'gmd-blame gmd-blame-new'));
      // Name and age only. The sha and the full message are what the hover is
      // for — spending a fifth of the editor's width on a column that is read
      // in passing is the trade GitLens gets right.
      else markers.push(new BlameMarker(`${c.author.split(' ')[0]} ${ago(c.authorTime)}`, hint, 'gmd-blame'));
      prev = ci;
    }
    return gutter({
      class: 'gmd-blame-gutter',
      // Blame is line-indexed rather than position-indexed: it was computed
      // against the file on disk, so it is looked up by line number and simply
      // runs out at the end of a buffer that has grown since.
      lineMarker: (vw, block) => markers[vw.state.doc.lineAt(block.from).number - 1] ?? null,
      initialSpacer: () => BLAME_SPACER,
    });
  }

  // --- inline blame -----------------------------------------------------------
  // The other half of what GitLens does: one faint annotation trailing the line
  // the cursor is on. The column answers "who owns this region"; this answers
  // "who wrote the line I am looking at right now", without spending any width
  // to do it — the annotation sits past the end of the text, where nothing else
  // is competing for the space.
  const inlineCompartment = new Compartment();

  class InlineBlameWidget extends WidgetType {
    commit: BlameCommit;
    constructor(c: BlameCommit) {
      super();
      this.commit = c;
    }
    eq(other: InlineBlameWidget) {
      return other.commit.sha === this.commit.sha;
    }
    // Never focusable and never part of the document: the annotation must not
    // be selectable, copyable, or reachable by the caret.
    ignoreEvent() {
      return false;
    }
    toDOM() {
      const c = this.commit;
      const el = document.createElement('span');
      el.className = 'gmd-blame-inline';
      el.textContent = c.uncommitted
        ? '    You • uncommitted changes'
        : `    ${c.author}, ${ago(c.authorTime)} • ${c.summary}`;
      if (c.uncommitted) return el;
      // The full record on hover, rather than crammed into the annotation. A
      // native title tooltip would do for the gutter, where the text is short,
      // but a commit message wants line breaks and a monospaced sha.
      el.addEventListener('mouseenter', () => {
        closeBlameCards();
        const card = document.createElement('div');
        card.className = 'gmd-blame-card';
        card.style.cssText = [
          'position:fixed', 'z-index:60', 'max-width:520px', 'padding:8px 10px',
          'background:#232323', 'border:1px solid #505050', 'border-radius:4px',
          'color:#c5c8c6', 'font-size:12px', 'line-height:1.5',
          'box-shadow:0 4px 16px rgba(0,0,0,0.45)', 'pointer-events:none',
          'white-space:pre-wrap',
        ].join(';');
        const summary = document.createElement('div');
        summary.textContent = c.summary;
        summary.style.cssText = 'color:#e6e6e6;margin-bottom:6px';
        const who = document.createElement('div');
        who.textContent = `${c.author} — ${new Date(c.authorTime).toLocaleString()}`;
        who.style.cssText = 'color:#949494';
        const sha = document.createElement('div');
        sha.textContent = c.sha;
        sha.style.cssText = 'color:#949494;font-family:monospace;font-size:11px;margin-top:4px';
        card.append(summary, who, sha);
        document.body.appendChild(card);
        const r = el.getBoundingClientRect();
        const w = card.getBoundingClientRect();
        // Flip above the line when there is no room below, and keep the whole
        // card on screen when the annotation is near the right edge.
        const below = r.bottom + 6;
        card.style.top = `${below + w.height > window.innerHeight ? Math.max(4, r.top - w.height - 6) : below}px`;
        card.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w.width - 8))}px`;
      });
      el.addEventListener('mouseleave', closeBlameCards);
      return el;
    }
    destroy() {
      closeBlameCards();
    }
  }

  // The card lives on document.body — outside the editor, so it is never
  // clipped by the scroller — which means nothing removes it implicitly.
  function closeBlameCards() {
    for (const n of document.querySelectorAll('.gmd-blame-card')) n.remove();
  }

  function inlineBlame(data: BlameData) {
    function build(vw: EditorView) {
      const sel = vw.state.selection.main;
      // A selection, rather than a cursor, means the user is working with a
      // range; an annotation pinned to one end of it is just noise.
      if (!sel.empty) return Decoration.none;
      const line = vw.state.doc.lineAt(sel.head);
      const c = data.commits[data.lines[line.number - 1]];
      if (!c) return Decoration.none;
      return Decoration.set([
        Decoration.widget({ widget: new InlineBlameWidget(c), side: 1 }).range(line.to),
      ]);
    }
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(vw: EditorView) {
          this.decorations = build(vw);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
        }
        destroy() {
          closeBlameCards();
        }
      },
      { decorations: (v) => v.decorations }
    );
  }

  let { value = $bindable(''), filename, gitPath = '', reveal = null, marks = [], readOnly = false, viewKey = '' }: {
    value?: string;
    filename: string;
    // Which tab this editor belongs to, for the state the tab remembers on its
    // behalf: word wrap, and the scroll position. Empty outside the IDE shell
    // (and for the merge view's Result pane, which passes its host tab's key),
    // in which case wrap falls back to the app-wide preference.
    viewKey?: string;
    // A snapshot of a file as it was at a commit has nowhere to save back to,
    // so the buffer refuses edits instead of collecting ones that vanish.
    readOnly?: boolean;
    // Workspace-relative path, empty for an unsaved buffer. Used only to ask
    // git what this file looked like before the current edits — the editor
    // itself stays path-agnostic.
    gitPath?: string;
    // Search-result jump. `seq` is what makes a repeat click on the same line
    // fire again — a bare line number would compare equal and do nothing.
    // `select` carries a range to highlight instead of just placing the cursor,
    // which is how an outline double-click selects a whole declaration.
    // `word` is the identifier a navigation resolved to. Given one, the jump
    // lands on the symbol itself rather than on the start of whatever line the
    // resolver happened to report — and an import-resolved jump has no line at
    // all, only a name.
    reveal?: { line: number; seq: number; select?: { from: number; to: number }; word?: string } | null;
    // Regions the host wants tinted — conflict blocks, in the merge view.
    // Purely decorative: nothing here changes the document.
    marks?: { from: number; to: number; cls: string }[];
  } = $props();

  let host: HTMLDivElement;
  // $state so the reveal effect below re-runs once the view actually exists;
  // a plain let would leave a jump requested at open time silently dropped.
  let view = $state<EditorView | null>(null);

  // Sidebar outline feed. Debounced because a parse-tree walk on every
  // keystroke is wasted work, and deferred into a timer so the read of
  // `filename` never lands inside the editor-creation effect's tracking scope.
  let outlineTimer: ReturnType<typeof setTimeout> | undefined;
  function pushOutline(vw: EditorView) {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(() => {
      const nodes = outlineFromState(vw.state);
      outlineNodes = nodes;
      window.dispatchEvent(new CustomEvent('gmd:outline', {
        detail: { name: filename, nodes },
      }));
      syncCrumbs(vw);
      void refreshLens(vw, nodes);
    }, 200);
  }

  // --- reference lens --------------------------------------------------------
  // The `N references` row above every declaration. Counts come from a single
  // ripgrep over the workspace per outline settle rather than one per symbol —
  // the endpoint takes every name in one alternation, which is the only reason
  // this is affordable without a language server.
  interface Lens { line: number; name: string; n: number }

  class LensWidget extends WidgetType {
    name: string;
    n: number;
    indent: number;
    constructor(name: string, n: number, indent: number) {
      super();
      this.name = name;
      this.n = n;
      this.indent = indent;
    }
    // Equality keeps an unchanged row's DOM alive across recomputes, so a click
    // landing while the outline re-settles is not thrown away mid-gesture.
    eq(o: LensWidget) { return o.name === this.name && o.n === this.n && o.indent === this.indent; }
    toDOM() {
      const wrap = document.createElement('div');
      wrap.className = this.n ? 'cm-refLens' : 'cm-refLens empty';
      // Aligned with the declaration it belongs to, not with the left margin —
      // a nested method's lens hanging at column zero reads as belonging to the
      // class above it.
      wrap.style.paddingLeft = `${this.indent}ch`;
      const link = document.createElement('span');
      link.className = 'cm-refLensLink';
      link.textContent = this.n === 1 ? '1 reference' : `${this.n} references`;
      if (this.n) {
        link.setAttribute('role', 'button');
        link.dataset.name = this.name;
      }
      wrap.appendChild(link);
      return wrap;
    }
    // The lens is interactive; letting CodeMirror ignore its events would eat
    // the click.
    ignoreEvent() { return false; }
  }

  const setLens = StateEffect.define<Lens[]>();
  const refLensField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(set, tr) {
      let next = set.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setLens)) continue;
        const doc = tr.state.doc;
        const b = new RangeSetBuilder<Decoration>();
        for (const l of e.value) {
          if (l.line < 1 || l.line > doc.lines) continue;
          const ln = doc.line(l.line);
          const indent = /^[ \t]*/.exec(ln.text)?.[0].length ?? 0;
          b.add(ln.from, ln.from, Decoration.widget({
            widget: new LensWidget(l.name, l.n, indent),
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

  const refLensClicks = EditorView.domEventHandlers({
    mousedown(e) {
      const link = (e.target as HTMLElement | null)?.closest('.cm-refLensLink') as HTMLElement | null;
      const name = link?.dataset.name;
      if (!name) return false;
      // Without this the click also places the caret, which scrolls the buffer
      // out from under the panel about to open over it.
      e.preventDefault();
      void openPeek(name);
      return true;
    },
  });

  // What the reference endpoints search. The workspace folder rather than the
  // whole server root: a root holding a dozen sibling checkouts would report
  // matches from projects the reader never opened.
  function searchScope(): string {
    const cut = gitPath.indexOf('/');
    return cut > 0 ? gitPath.slice(0, cut) : (gitPath || '.');
  }

  const LENS_NAME_CAP = 120;
  let lensCounts = new Map<string, number>();
  let lensKey = '';

  // Only declarations that create something callable or nameable from another
  // file. A word count for a variable is a fiction whatever its scope: `const
  // n` reported four hundred hits from every unrelated `n` in the workspace,
  // and a top-level `let error` in a component reported four hundred more. A
  // CSS rule has the same problem for the opposite reason — the selector is
  // not an identifier anyone refers to by name.
  const LENS_KINDS: ReadonlySet<string> = new Set(['function', 'class', 'interface', 'enum', 'module']);

  function lensTargets(nodes: OutlineNode[], out: OutlineNode[] = []): OutlineNode[] {
    for (const n of nodes) {
      if (n.name && LENS_KINDS.has(n.kind ?? '') && /^[A-Za-z_$][\w$]{0,127}$/.test(n.name)) out.push(n);
      lensTargets(n.children, out);
    }
    return out;
  }

  function paintLens(vw: EditorView, targets: OutlineNode[]) {
    const seen = new Set<number>();
    const rows: Lens[] = [];
    for (const t of targets) {
      const total = lensCounts.get(t.name as string);
      if (total === undefined || seen.has(t.line)) continue;
      seen.add(t.line);
      // The declaration is itself one of the matches ripgrep counted, and a
      // symbol that is only declared has zero references, not one.
      rows.push({ line: t.line, name: t.name as string, n: Math.max(0, total - 1) });
    }
    rows.sort((a, b) => a.line - b.line);
    vw.dispatch({ effects: setLens.of(rows) });
  }

  async function refreshLens(vw: EditorView, nodes: OutlineNode[]) {
    // An unsaved buffer has no path to search from, and nothing on disk refers
    // to it yet anyway.
    if (!gitPath) return;
    const targets = lensTargets(nodes).slice(0, LENS_NAME_CAP);
    const names = [...new Set(targets.map((t) => t.name as string))];
    const key = `${gitPath}\u0000${names.join(',')}`;
    if (!names.length) {
      lensKey = key;
      lensCounts = new Map();
      vw.dispatch({ effects: setLens.of([]) });
      return;
    }
    // Typing inside a body moves the rows without changing the symbol set, so
    // the counts are refetched only when that set actually changes. Repainting
    // is cheap; a workspace-wide ripgrep per keystroke-settle is not.
    if (key === lensKey) { paintLens(vw, targets); return; }
    lensKey = key;
    try {
      const r = await fetch(
        `/api/refcounts?names=${encodeURIComponent(names.join(','))}&path=${encodeURIComponent(searchScope())}`,
      );
      const j = (await r.json()) as { counts?: Record<string, number> };
      if (untrack(() => view) !== vw || lensKey !== key) return;
      lensCounts = new Map(Object.entries(j.counts ?? {}));
      paintLens(vw, targets);
    } catch { /* an unreachable counter just leaves the rows off */ }
  }

  // --- peek references -------------------------------------------------------
  // Every mention of a symbol, at a glance, without leaving the file being
  // read: a preview of the surrounding lines on the left, the locations grouped
  // by file on the right. Escape closes it.
  interface PeekHit { path: string; line: number; text: string; cols?: [number, number][] }
  interface PeekLine { n: number; toks: Tok[]; hit: boolean }

  const PEEK_CTX = 4;

  let peek = $state<{
    name: string;
    loading: boolean;
    hits: PeekHit[];
    truncated: boolean;
    sel: number;
    preview: { path: string; lines: PeekLine[] } | null;
  } | null>(null);

  // Grouped by file with the parent folder beside the name, because two files
  // of the same name in different directories is the normal case in a tree
  // carrying worktrees or a vendored copy. Hits arrive sorted by path, so the
  // running index here matches the flat array the keyboard walks.
  const peekGroups = $derived.by(() => {
    const p = peek;
    if (!p) return [];
    const by = new Map<string, PeekHit[]>();
    for (const h of p.hits) {
      const arr = by.get(h.path);
      if (arr) arr.push(h);
      else by.set(h.path, [h]);
    }
    let i = 0;
    return [...by].map(([path, hits]) => {
      const cut = path.lastIndexOf('/');
      return {
        path,
        base: cut < 0 ? path : path.slice(cut + 1),
        dir: cut < 0 ? '' : path.slice(0, cut),
        hits: hits.map((h) => {
          // Leading indentation is dropped so the matched word sits as far left
          // as the list can put it; the column range rides in from the server
          // rather than being re-found here.
          const lead = h.text.length - h.text.trimStart().length;
          const c = h.cols?.[0];
          const from = c ? Math.max(lead, c[0]) : lead;
          const to = c ? Math.max(from, c[1]) : from;
          return {
            i: i++,
            line: h.line,
            pre: h.text.slice(lead, from),
            mid: h.text.slice(from, to),
            post: h.text.slice(to),
          };
        }),
      };
    });
  });

  // Which file groups are folded shut. A peek over a busy symbol opens with a
  // dozen files in it, and the first question is usually "which files", not
  // "which lines" — folding is how that view is reached without scrolling past
  // the hits to find out.
  let peekFolded = $state<string[]>([]);

  const peekAllFolded = $derived(peekGroups.length > 0 && peekFolded.length >= peekGroups.length);

  function toggleGroup(p: string) {
    peekFolded = peekFolded.includes(p) ? peekFolded.filter((x) => x !== p) : [...peekFolded, p];
  }

  function toggleAllGroups() {
    peekFolded = peekAllFolded ? [] : peekGroups.map((g) => g.path);
  }

  // Arrow keys walk what is on screen. A hit inside a folded group is not on
  // screen, so stepping into it would move the preview to a location the list
  // is no longer showing.
  function visibleHits(): number[] {
    return peekGroups.filter((g) => !peekFolded.includes(g.path)).flatMap((g) => g.hits.map((h) => h.i));
  }

  function closePeek() {
    peek = null;
    view?.focus();
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }

  async function openPeek(name: string) {
    if (!gitPath) return;
    peekFolded = [];
    peek = { name, loading: true, hits: [], truncated: false, sel: 0, preview: null };
    try {
      const r = await fetch(
        `/api/refs?name=${encodeURIComponent(name)}&path=${encodeURIComponent(searchScope())}`,
      );
      const j = (await r.json()) as { hits?: PeekHit[]; truncated?: boolean; error?: string };
      if (peek?.name !== name) return;
      if (j.error) { peek = null; showNotice(`References: ${j.error}`); return; }
      const hits = (j.hits ?? []).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      if (!hits.length) { peek = null; showNotice(`No references to “${name}”`); return; }
      peek = { name, loading: false, hits, truncated: !!j.truncated, sel: 0, preview: null };
      void loadPreview(0);
    } catch {
      peek = null;
      showNotice('Reference lookup failed');
    }
  }

  async function loadPreview(i: number) {
    const p = peek;
    const hit = p?.hits[i];
    if (!p || !hit) return;
    peek = { ...p, sel: i, preview: null };
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(hit.path)}`);
      const j = (await r.json()) as { content?: string };
      if (peek?.name !== p.name || peek.sel !== i) return;
      const all = (j.content ?? '').split('\n');
      const from = Math.max(1, hit.line - PEEK_CTX);
      const to = Math.min(all.length, hit.line + PEEK_CTX);
      // Only the window is highlighted, not the whole file: a grammar run over
      // a 10k-line module to colour nine lines is the wrong trade, and the
      // window is self-contained enough to colour convincingly.
      const scope = await scopeForFilename(hit.path);
      const toks = scope ? await highlightToLines(all.slice(from - 1, to).join('\n'), scope) : [];
      if (peek?.name !== p.name || peek.sel !== i) return;
      const lines: PeekLine[] = [];
      for (let n = from; n <= to; n++) {
        lines.push({
          n,
          toks: toks[n - from] ?? [{ cls: null, text: all[n - 1] ?? '' }],
          hit: n === hit.line,
        });
      }
      peek = { ...peek, preview: { path: hit.path, lines } };
    } catch { /* the preview is a nicety; the locations list is the answer */ }
  }

  function peekOpen(i: number) {
    const hit = peek?.hits[i];
    const word = peek?.name;
    if (!hit) return;
    closePeek();
    window.dispatchEvent(new CustomEvent('gmd:open-request', {
      detail: { kind: 'file', path: hit.path, line: hit.line, word },
    }));
  }

  function peekKey(e: KeyboardEvent) {
    const p = peek;
    if (!p) return;
    if (e.key === 'Escape') {
      // Stopped here so the same keystroke does not also close the search panel
      // or clear the selection in the editor underneath.
      e.preventDefault();
      e.stopPropagation();
      closePeek();
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); peekOpen(p.sel); return; }
    // Left folds the group holding the selection, right unfolds it — the same
    // pair every tree in this app answers to.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const g = peekGroups.find((x) => x.hits.some((h) => h.i === p.sel));
      if (!g) return;
      e.preventDefault();
      const folded = peekFolded.includes(g.path);
      if (e.key === 'ArrowLeft' ? !folded : folded) toggleGroup(g.path);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const vis = visibleHits();
    if (!vis.length) return;
    const at = vis.indexOf(p.sel);
    // A selection hidden by a fold has no neighbour to step from, so the walk
    // restarts at the top of what is visible.
    const next = at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : vis.length - 1)) % vis.length;
    void loadPreview(vis[next]);
  }

  // --- symbol breadcrumb -----------------------------------------------------
  // The strip above the editor naming the declaration the caret sits inside.
  // It reads the same outline the sidebar does, and that outline comes from the
  // editor's active grammar rather than from the filename — which is what makes
  // it work on an unsaved buffer whose language was picked by hand from the
  // corner dropdown, where there is no extension to detect.
  let outlineNodes: OutlineNode[] = [];
  let crumbs = $state<OutlineNode[]>([]);
  let crumbFrame = 0;

  function chainAt(nodes: OutlineNode[], pos: number): OutlineNode[] {
    for (const n of nodes) {
      if (pos < n.from || pos > n.to) continue;
      return [n, ...chainAt(n.children, pos)];
    }
    return [];
  }

  // What the strip reports on: the caret while it is on screen, the top visible
  // line once the reader has scrolled away from it. Following the caret alone
  // leaves the strip naming a symbol nowhere near what is being read.
  function anchorPos(vw: EditorView): number {
    const box = vw.scrollDOM.getBoundingClientRect();
    const head = vw.state.selection.main.head;
    const onScreen = head >= vw.viewport.from && head <= vw.viewport.to;
    const coords = onScreen ? vw.coordsAtPos(head) : null;
    if (coords && coords.top >= box.top && coords.bottom <= box.bottom) return head;
    return vw.posAtCoords({ x: box.left + 4, y: box.top + 2 }) ?? vw.viewport.from;
  }

  // Coalesced to one frame: this runs on every cursor move and scroll tick, and
  // stays cheap only because it walks the already-debounced outline rather than
  // re-parsing. A stale walk for one debounce interval is invisible; a parse per
  // scroll frame would not be.
  function syncCrumbs(vw: EditorView) {
    cancelAnimationFrame(crumbFrame);
    crumbFrame = requestAnimationFrame(() => {
      syncSticky(vw);
      const next = outlineNodes.length ? chainAt(outlineNodes, anchorPos(vw)) : [];
      // An unchanged path returns the same node objects, so an identity check
      // keeps a long scroll from re-rendering the strip on every frame.
      if (next.length === crumbs.length && next.every((n, i) => n === crumbs[i])) return;
      crumbs = next;
    });
  }

  // Scrolling inside an already-rendered viewport produces no view update, so
  // the pinned rows would only refresh when CodeMirror happened to re-render.
  // The same listener is where the tab's remembered position gets written back,
  // debounced because one wheel gesture fires this dozens of times.
  $effect(() => {
    const v = view;
    if (!v) return;
    const key = untrack(() => viewKey);
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      syncSticky(v);
      if (!key) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const anchor = readScrollAnchor(v);
        if (anchor) patchTabView(key, { anchor });
      }, 150);
    };
    v.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(saveTimer);
      v.scrollDOM.removeEventListener('scroll', onScroll);
    };
  });

  // Put the reader back where they were. Once per mounted editor — and since a
  // tab switch destroys this component, that means once per visit to the tab,
  // not once per session. Waits for the buffer to actually have content: a tab
  // restored from the session cache is created empty and filled by the fetch
  // that follows. A reveal request from a search hit or an outline click arrives
  // later and deliberately wins.
  let scrollRestored = false;
  $effect(() => {
    const v = view;
    const hasDoc = value.length > 0;
    const key = untrack(() => viewKey);
    if (!v || !key || scrollRestored || !hasDoc) return;
    scrollRestored = true;
    const anchor = untrack(() => tabViewOf(key))?.anchor;
    if (anchor) applyScrollAnchor(v, anchor);
  });

  // --- go to definition ------------------------------------------------------
  // Ctrl/Cmd+click, the VS Code chord. Alt+click stays multi-cursor, which is
  // the split the markdown editor already documents.
  function localDef(
    nodes: OutlineNode[],
    word: string,
    state: EditorState,
    clicked: number,
  ): OutlineNode | null {
    for (const n of nodes) {
      const header = state.doc.lineAt(n.from);
      // Clicking the declaration itself should not jump to the declaration.
      const onItself = clicked >= header.from && clicked <= header.to;
      if (n.name === word && !onItself) return n;
      const nested = localDef(n.children, word, state, clicked);
      if (nested) return nested;
    }
    return null;
  }

  // Where a jump should actually come to rest. The requested line is a hint:
  // a reference carries the exact line worth looking at, an import-resolved
  // jump carries none, and in both cases what the reader wants in front of
  // them is the identifier, not a row number that happens to contain it.
  function wordColIn(text: string, word: string): number {
    const re = new RegExp(`(?:^|[^\\w$])(${word})(?![\\w$])`);
    const m = re.exec(text);
    return m ? m.index + m[0].length - word.length : -1;
  }

  const DECL_KEYWORDS = 'function|class|interface|type|enum|struct|impl|trait|module|namespace|def|fn|func|const|let|var';

  function findSymbol(
    state: EditorState,
    word: string,
    hintLine: number,
  ): { from: number; to: number } | null {
    if (!/^[A-Za-z_$][\w$]*$/.test(word)) return null;
    const doc = state.doc;
    // A hinted line that really holds the word wins outright — that is the
    // occurrence the caller meant.
    const hint = doc.line(Math.min(Math.max(1, hintLine), doc.lines));
    const atHint = wordColIn(hint.text, word);
    if (atHint >= 0) return { from: hint.from + atHint, to: hint.from + atHint + word.length };
    // Otherwise prefer a line that declares the name over one that merely
    // mentions it: landing on `export default function HeroSplit()` is the
    // point, landing on an unrelated call site is noise.
    const decl = new RegExp(`(?:^|[^\\w$.])(?:${DECL_KEYWORDS})\\s+${word}\\b`);
    let first: { from: number; to: number } | null = null;
    const cap = Math.min(doc.lines, 5000);
    for (let i = 1; i <= cap; i++) {
      const ln = doc.line(i);
      const col = wordColIn(ln.text, word);
      if (col < 0) continue;
      const range = { from: ln.from + col, to: ln.from + col + word.length };
      if (decl.test(ln.text)) return range;
      if (!first) first = range;
    }
    return first;
  }

  function landOn(vw: EditorView, range: { from: number; to: number }) {
    vw.dispatch({
      selection: EditorSelection.single(range.from, range.to),
      effects: [
        EditorView.scrollIntoView(range.from, { y: 'center' }),
        setNavFlash.of(range),
      ],
    });
    vw.focus();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      try { vw.dispatch({ effects: setNavFlash.of(null) }); } catch { /* view gone */ }
    }, 1400);
  }

  // The import statement that brings `word` into this file, if there is one.
  // A workspace-wide declaration scan is a guess; an import is a fact, and in
  // a tree carrying worktrees or vendored copies the guess routinely resolves
  // to the wrong copy. Both clause forms allow newlines inside the binding
  // list, because a named-import block is commonly wrapped across lines.
  const IMPORT_CLAUSE = /(?:^|[\n;])\s*import\s+([^;'"]*?)\s*from\s*['"]([^'"\n]+)['"]/g;
  const REQUIRE_CLAUSE = /(?:^|[\n;])\s*(?:const|let|var)\s+([^=;]+?)\s*=\s*require\(\s*['"]([^'"\n]+)['"]\s*\)/g;

  function importSpecFor(head: string, word: string): string | null {
    const bound = new RegExp(`(?:^|[^\\w$.])${word}(?![\\w$])`);
    for (const re of [IMPORT_CLAUSE, REQUIRE_CLAUSE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(head)) !== null) {
        // `X as Y` binds Y locally, and the clause carries both — matching
        // either is right, since both name this module.
        if (bound.test(m[1])) return m[2];
      }
    }
    return null;
  }

  // Resolution order, cheapest and most certain first: a declaration in this
  // very file, then the module this file imports the name from, then a
  // workspace-wide scan for anything shaped like a declaration.
  async function goToDefinition(vw: EditorView, pos: number) {
    const w = vw.state.wordAt(pos);
    if (!w) return;
    const word = vw.state.sliceDoc(w.from, w.to);
    if (!/^[A-Za-z_$][\w$]*$/.test(word)) return;
    const here = localDef(outlineNodes, word, vw.state, pos);
    if (here) {
      const at = findSymbol(vw.state, word, vw.state.doc.lineAt(here.from).number);
      landOn(vw, at ?? { from: here.from, to: here.from });
      return;
    }

    // Imports live at the top of a file by construction; scanning the whole
    // buffer for them would be paying for the tail of a 10k-line file on every
    // click.
    const doc = vw.state.doc;
    const spec = gitPath ? importSpecFor(doc.sliceString(0, Math.min(doc.length, 20000)), word) : null;
    if (spec) {
      try {
        const r = await fetch(
          `/api/resolveimport?spec=${encodeURIComponent(spec)}&from=${encodeURIComponent(gitPath)}`,
        );
        const j = (await r.json()) as { path?: string | null };
        if (j.path) {
          window.dispatchEvent(new CustomEvent('gmd:open-request', {
            detail: { kind: 'file', path: j.path, word },
          }));
          return;
        }
      } catch { /* an unreachable resolver is not a reason to give up */ }
    }

    try {
      const r = await fetch(`/api/defs?name=${encodeURIComponent(word)}`);
      const j = (await r.json()) as { hits?: { path: string; line: number }[]; error?: string };
      const hits = j.hits ?? [];
      if (!hits.length) {
        showNotice(j.error ? `Definition lookup: ${j.error}` : `No definition found for “${word}”`);
        return;
      }
      window.dispatchEvent(new CustomEvent('gmd:open-request', {
        detail: { kind: 'file', path: hits[0].path, line: hits[0].line, word },
      }));
      // Opening the first and saying so beats a picker for the common case of
      // one real definition plus a re-export.
      if (hits.length > 1) showNotice(`${hits.length} candidates for “${word}” — opened the first`);
    } catch {
      showNotice('Definition lookup failed');
    }
  }

  // --- sticky scroll ---------------------------------------------------------
  // The enclosing declarations, pinned over the top of the viewport once their
  // own lines have scrolled past. Deliberately translucent: these rows cover
  // real code, and being able to read what is underneath is what keeps them
  // from feeling like the editor has lost two lines.
  const STICKY_ROW_H = 20;
  const STICKY_MAX = 5;
  let stickyRows = $state<{ line: number; html: string }[]>([]);
  let stickyKey = '';
  let stickyFont = $state('');
  let stickyPad = $state(8);

  const escHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Re-run the editor's own highlighter over one line so a pinned row looks
  // like the code it stands for. The class names come from the same
  // HighlightStyle the view is using, and CodeMirror registers those rules
  // document-wide, so they apply outside .cm-editor too.
  function stickyHtml(state: EditorState, from: number, to: number): string {
    const tree = syntaxTree(state);
    const style = isDark ? monokaiCodeHighlight : defaultHighlightStyle;
    let out = '';
    let pos = from;
    try {
      highlightTree(tree, style, (f, t, classes) => {
        if (f > pos) out += escHtml(state.doc.sliceString(pos, f));
        out += `<span class="${classes}">${escHtml(state.doc.sliceString(f, t))}</span>`;
        pos = t;
      }, from, to);
    } catch {
      return escHtml(state.doc.sliceString(from, to));
    }
    if (pos < to) out += escHtml(state.doc.sliceString(pos, to));
    return out;
  }

  function syncSticky(vw: EditorView) {
    if (!outlineNodes.length) {
      if (stickyRows.length) { stickyRows = []; stickyKey = ''; }
      return;
    }
    const box = vw.scrollDOM.getBoundingClientRect();
    // Probe below the rows already pinned, not at the very top: probing the
    // covered line makes a row hide itself and reappear on the next frame.
    const probeY = box.top + stickyRows.length * STICKY_ROW_H + 2;
    const topPos = vw.posAtCoords({ x: box.left + 4, y: probeY }) ?? vw.viewport.from;
    const topLine = vw.state.doc.lineAt(topPos);
    const rows: { line: number; html: string }[] = [];
    for (const n of chainAt(outlineNodes, topPos)) {
      const dl = vw.state.doc.line(Math.min(Math.max(1, n.line), vw.state.doc.lines));
      // Its own line is still on screen — pinning a copy of a visible line is
      // just covering the line below it for nothing.
      if (dl.from >= topLine.from) break;
      rows.push({ line: dl.number, html: stickyHtml(vw.state, dl.from, dl.to) });
      if (rows.length >= STICKY_MAX) break;
    }
    const key = rows.map((r) => r.line).join(',');
    if (key === stickyKey) return;
    stickyKey = key;
    stickyRows = rows;
    if (rows.length) {
      // Match the editor's metrics exactly, read from the live view rather than
      // duplicated in CSS: the theme owns the font and the gutter owns its own
      // width, and a pinned row that does not line up reads as a rendering bug.
      const cs = getComputedStyle(vw.contentDOM);
      stickyFont = `font-family:${cs.fontFamily};font-size:${cs.fontSize}`;
      const gutters = vw.dom.querySelector('.cm-gutters') as HTMLElement | null;
      stickyPad = (gutters?.offsetWidth ?? 0) + 4;
    }
  }

  function gotoLine(line: number) {
    const vw = view;
    if (!vw) return;
    const pos = vw.state.doc.line(Math.min(Math.max(1, line), vw.state.doc.lines)).from;
    vw.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
    vw.focus();
  }

  function gotoCrumb(n: OutlineNode) {
    const vw = view;
    if (!vw) return;
    vw.dispatch({ selection: EditorSelection.cursor(n.from), scrollIntoView: true });
    vw.focus();
  }

  // The shell asks for a fresh push whenever the active tab changes.
  $effect(() => {
    const on = () => {
      const vw = view;
      if (vw) pushOutline(vw);
    };
    window.addEventListener('gmd:outline-request', on);
    return () => window.removeEventListener('gmd:outline-request', on);
  });

  // Palette toggle for the value cloak. Lives on a window event because a code
  // tab has no toolbar of its own to hang a button from.
  $effect(() => {
    const on = () => {
      const vw = view;
      if (!vw) return;
      const current = vw.state.field(cloakState, false)?.on ?? false;
      vw.dispatch({ effects: setCloak.of(!current) });
    };
    window.addEventListener('gmd:toggle-cloak', on);
    return () => window.removeEventListener('gmd:toggle-cloak', on);
  });

  // Format Document. A refusal (wrong language, unparseable buffer) is
  // surfaced as a notice rather than thrown, so the chord never looks dead.
  let notice = $state('');
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function showNotice(msg: string) {
    notice = msg;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = ''; }, 3000);
  }

  function formatDocument(vw: EditorView): boolean {
    const before = vw.state.doc.toString();
    const outcome = formatDocumentText(before, filename);
    if (!outcome.ok) { showNotice(outcome.message); return true; }
    if (outcome.text === before) { showNotice('Already formatted'); return true; }
    // Reindenting shifts every offset in the document, so the cursor is
    // restored by line number instead — the closest thing to "where you
    // were" that survives a whole-document replace.
    const line = vw.state.doc.lineAt(vw.state.selection.main.head).number;
    vw.dispatch({ changes: { from: 0, to: vw.state.doc.length, insert: outcome.text } });
    const doc = vw.state.doc;
    const at = doc.line(Math.min(line, doc.lines));
    vw.dispatch({ selection: EditorSelection.cursor(at.from), scrollIntoView: true });
    return true;
  }

  // Same command, reached from the palette instead of the keyboard.
  $effect(() => {
    const on = () => {
      const vw = view;
      if (vw) formatDocument(vw);
    };
    window.addEventListener('gmd:format-document', on);
    return () => window.removeEventListener('gmd:format-document', on);
  });

  // Same command, reached from the palette instead of the keyboard.
  $effect(() => {
    const on = () => {
      const vw = view;
      if (vw) selectAllOccurrences(vw);
    };
    window.addEventListener('gmd:select-all-occurrences', on);
    return () => window.removeEventListener('gmd:select-all-occurrences', on);
  });

  const languageCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const markCompartment = new Compartment();

  // Word wrap belongs to the tab, falling back to the app-wide preference for a
  // tab nobody has toggled yet. Alt/Opt+Z here settles every pane of THIS tab
  // and leaves the others alone, and the choice survives a reload. `applied` is
  // what this editor last reconfigured to, so the effect below ignores the echo
  // of our own toggle.
  let appliedWrap = untrack(() => wrapFor(viewKey));

  function toggleWrap(vw: EditorView) {
    toggleWrapFor(viewKey);
    appliedWrap = wrapFor(viewKey);
    vw.dispatch({ effects: wrapCompartment.reconfigure(appliedWrap ? EditorView.lineWrapping : []) });
  }

  const PLAIN = 'plain text';
  const languageNames = [PLAIN, ...LANGS.map((l) => l.name).sort((a, b) => a.localeCompare(b))];
  let selectedLanguage = $state(PLAIN);

  const lightTheme = EditorView.theme({}, { dark: false });

  // Chrome and token colours both live in monokai-dimmed.ts, shared with the
  // markdown pane. Without an explicit syntaxHighlighting() extension
  // CodeMirror parses but never paints — basicSetup normally supplies one,
  // and this hand-rolled setup has to as well; the bundle carries it.
  const darkBundle = monokaiCodeBundle;
  const lightBundle = [lightTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true })];

  // Shell is dark-by-default (VS Code-like); only the markdown cockpit keeps
  // system-based theming. Compartment retained for a future theme setting.
  let isDark = $state(true);

  // v0.9.0: scrollbar tick rail, same pattern as Editor.svelte. Layers:
  // word (blue, double-click whole word — cmd_f port), match (amber, Cmd+F),
  // current (orange). These fns only WRITE state — called from the
  // updateListener/ResizeObserver, so the creation effect below keeps its
  // zero-reactive-READS discipline (the stacked-editor freeze lesson).
  let matchTicks = $state<number[]>([]);
  let currentTickY = $state<number | null>(null);
  let wordTicks = $state<number[]>([]);
  // Find-box visibility mirrored out of CodeMirror state: the language picker
  // and the find box both want the top-right corner, so the picker steps aside
  // while the box is up. Written from recomputeMatchTicks, read only by markup.
  let searchOpen = $state(false);

  function docPosToGutterY(vw: EditorView, pos: number): number | null {
    const scroller = vw.scrollDOM;
    const sh = scroller.scrollHeight;
    const ch = scroller.clientHeight;
    if (sh === 0 || ch === 0) return null;
    try {
      const block = vw.lineBlockAt(pos);
      return (block.top / sh) * ch;
    } catch { return null; }
  }

  function recomputeMatchTicks(vw: EditorView) {
    // Gated on the panel, not just on the query. CodeMirror drops its own
    // inline match decorations the instant the panel unmounts, but the query
    // object survives — so ticks keyed off the query alone outlive the box that
    // produced them. Escape now clears text highlights and ticks together, and
    // Cmd+F brings both back with the query untouched. Double-click word
    // highlights are a separate layer and are unaffected either way.
    const panelOpen = searchPanelOpen(vw.state);
    searchOpen = panelOpen;
    const q = panelOpen ? getSearchQuery(vw.state) : null;
    if (!q || !q.search || !q.valid) {
      matchTicks = [];
      currentTickY = null;
      return;
    }
    const cur = q.getCursor(vw.state.doc);
    const ticks: number[] = [];
    const ranges: { from: number; to: number }[] = [];
    let safety = 5000;
    let next = cur.next();
    while (!next.done && safety-- > 0) {
      const r = next.value;
      ranges.push({ from: r.from, to: r.to });
      const y = docPosToGutterY(vw, r.from);
      if (y != null) ticks.push(y);
      next = cur.next();
    }
    matchTicks = ticks;
    const head = vw.state.selection.main.head;
    let nearest: { from: number; to: number } | null = null;
    for (const r of ranges) {
      if (r.from <= head && head <= r.to) { nearest = r; break; }
      if (r.from >= head) { nearest = r; break; }
    }
    currentTickY = nearest ? docPosToGutterY(vw, nearest.from) : null;
  }

  function recomputeWordTicks(vw: EditorView) {
    const ranges = wordMatchRanges(vw.state);
    if (ranges.length < 2) { wordTicks = []; return; }
    const ticks: number[] = [];
    for (const r of ranges) {
      const y = docPosToGutterY(vw, r.from);
      if (y != null) ticks.push(y);
    }
    wordTicks = ticks;
  }

  function recomputeTicks(vw: EditorView) {
    queueMicrotask(() => {
      try {
        recomputeMatchTicks(vw);
        recomputeWordTicks(vw);
      } catch { /* swallow — ticks are non-critical */ }
    });
  }

  async function applyLanguage(name: string) {
    if (!view) return;
    if (name === PLAIN) {
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      return;
    }
    const desc = LANGS.find((l) => l.name === name);
    if (!desc) return;
    const support = await desc.load();
    // Re-check the picker hasn't moved on while the grammar was loading.
    if (view && selectedLanguage === name) {
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    }
  }

  // The committed version of this file, as the gutter measures against. Null
  // means "no diff": untracked, binary, or not in a repository at all.
  let originalText: string | null = null;

  async function loadOriginal() {
    const vw = untrack(() => view);
    const p = gitPath;
    if (!vw) return;
    let text: string | null = null;
    let source = 'index';
    if (p) {
      try {
        const r = await fetch(`/api/git/show?path=${encodeURIComponent(p)}`);
        const d = await r.json();
        if (r.ok && d.tracked && !d.binary) {
          text = d.content as string;
          source = d.source ?? 'index';
        }
      } catch {
        return; // offline or mid-restart: the next refresh tries again
      }
    }
    // The tab may have been pointed somewhere else while this was in flight.
    if (untrack(() => view) !== vw || gitPath !== p) return;
    // Reconfiguring rebuilds the chunk model from scratch, which closes every
    // open peek panel — so an unchanged original is left alone. This is what
    // makes the refresh on window focus invisible.
    if (text === originalText) return;
    originalText = text;
    vw.dispatch({
      effects: diffCompartment.reconfigure(
        text === null ? [] : [originalSource.of(source), changeGutter, unifiedMergeView(mergeOff(text))],
      ),
    });
  }

  $effect(() => {
    if (!host) return;
    const initialDoc = untrack(() => value);

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        // Read at creation like the document itself: a tab never changes from
        // editable to frozen, it opens as one or the other.
        EditorState.readOnly.of(untrack(() => readOnly)),
        // Before the line numbers on purpose — extension order is gutter
        // order, and blame belongs at the far left where GitLens puts it,
        // outside the numbers rather than between them and the text.
        blameCompartment.of([]),
        inlineCompartment.of([]),
        lineNumbers(),
        codeFolding(),
        foldGutter(),
        // Registered before the grammar's own fold info is consulted, so it
        // defers to it internally. Covers grammars with no fold metadata.
        foldService.of(indentFoldService),
        highlightActiveLine(),
        history(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        indentationMarkers({
          highlightActiveBlock: true,
          hideFirstIndent: false,
          colors: { light: '#d0d7de', dark: '#3c3c3c', activeLight: '#606060', activeDark: '#949494' },
        }),
        // Beside the guides, not instead of them: the guides say which block a
        // line belongs to, the tint says how deep it is.
        indentRainbow,
        // Inert until the filename effect below arms it for a .env file.
        dotenvCloak,
        search({ top: true }),
        matchCountBadge,
        wordHighlight,
        // Empty until the file turns out to be tracked, and it carries the
        // change gutter with it — declared here so that gutter lands to the
        // right of the fold arrows and immediately left of the text, where VS
        // Code puts it. Extension order IS gutter order.
        diffCompartment.of([]),
        changePeeks,
        changePeekDecorations,
        navFlashField,
        refLensField,
        refLensClicks,
        wrapCompartment.of(untrack(() => wrapFor(viewKey)) ? EditorView.lineWrapping : []),
        markCompartment.of([]),
        languageCompartment.of([]),
        themeCompartment.of(untrack(() => isDark) ? darkBundle : lightBundle),
        // After the theme compartment on purpose: the syntax bundles ship their
        // own faint .cm-matchingBracket rule, and later extensions win. Click a
        // bracket and BOTH boundaries need to be obvious at a glance.
        EditorView.theme({
          '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
            backgroundColor: 'rgba(229, 133, 32, 0.35)',
            outline: '1px solid rgba(84, 122, 255, 0.9)',
            borderRadius: '2px',
          },
          '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
            backgroundColor: 'rgba(248, 81, 73, 0.25)',
            outline: '1px solid rgba(248, 81, 73, 0.9)',
            borderRadius: '2px',
          },
          // Host-supplied marks. Faint for every conflict still in the buffer,
          // stronger for the one the merge toolbar is pointing at.
          // Where a go-to-definition landed. Loud enough to find with the eye
          // on arrival, gone before it can be mistaken for a selection.
          '.cm-navFlash': {
            backgroundColor: 'rgba(229, 192, 32, 0.3)',
            outline: '1px solid rgba(229, 192, 32, 0.55)',
            borderRadius: '2px',
          },
          // The reference lens. Deliberately quiet — it sits above every
          // declaration in the file, so anything louder would out-shout the
          // code it annotates.
          '.cm-refLens': {
            paddingTop: '2px',
            fontSize: '11px',
            lineHeight: '1.3',
            color: '#7a7a7a',
            userSelect: 'none',
          },
          '.cm-refLensLink': { cursor: 'pointer' },
          '.cm-refLensLink:hover': { color: '#4daafc', textDecoration: 'underline' },
          '.cm-refLens.empty .cm-refLensLink': { cursor: 'default', opacity: '0.65' },
          '.cm-conflictBlock': { backgroundColor: 'rgba(229, 133, 32, 0.09)' },
          '.cm-conflictBlockActive': {
            backgroundColor: 'rgba(229, 133, 32, 0.2)',
            outline: '1px solid rgba(229, 133, 32, 0.5)',
          },
        }),
        // Alt/Opt+Z toggles wrap. Firefox on macOS delivers `Ω` as event.key
        // for Alt+Z, so a keymap entry alone never fires — match event.code at
        // the DOM level and keep the keymap entry as a backup.
        // drop/dragover: tab drags carry a custom MIME, but preventDefault here
        // guarantees CodeMirror never treats a tab drag as text insertion.
        EditorView.domEventHandlers({
          mousedown: (event, vw) => {
            if (event.button !== 0 || event.altKey || event.shiftKey) return false;
            if (!event.metaKey && !event.ctrlKey) return false;
            const pos = vw.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            // CodeMirror's own Mod+click adds a second cursor. Claim the event
            // before that runs, or the jump lands with a stray caret behind it.
            event.preventDefault();
            void goToDefinition(vw, pos);
            return true;
          },
          keydown: (event, vw) => {
            if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyZ') {
              event.preventDefault();
              toggleWrap(vw);
              return true;
            }
            return false;
          },
          dragover: (event) => {
            const ty = event.dataTransfer?.types;
            if (ty && (ty.includes(TAB_DND_MIME) || ty.includes(PATH_DND_MIME))) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          drop: (event) => {
            const ty = event.dataTransfer?.types;
            if (ty && (ty.includes(TAB_DND_MIME) || ty.includes(PATH_DND_MIME))) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        }),
        // No Mod-s here — the shell owns save.
        keymap.of([
          // Structural selection. Declared before defaultKeymap so these win
          // the chord outright rather than depending on list order luck.
          // Deliberately NOT bound to Mod-, which is Cmd on macOS and would
          // shadow the platform-native select-to-line-start/end.
          { key: 'Ctrl-Shift-ArrowLeft', preventDefault: true, run: expandSelection },
          { key: 'Ctrl-Shift-ArrowRight', preventDefault: true, run: shrinkSelection },
          // VS Code's own chord for the same pair on Windows/Linux. Left off
          // macOS, where Alt+Shift+Arrow is native select-word-left/right.
          { win: 'Alt-Shift-ArrowLeft', linux: 'Alt-Shift-ArrowLeft', preventDefault: true, run: expandSelection },
          { win: 'Alt-Shift-ArrowRight', linux: 'Alt-Shift-ArrowRight', preventDefault: true, run: shrinkSelection },
          // macOS swallows Ctrl+Shift+Arrow at the window-server level, so the
          // chord above never reaches the page there. Adding Cmd clears it
          // while keeping left = expand on every platform — deliberately the
          // inverse of VS Code's mac default, because one mental model across
          // three operating systems beats matching each one's local habit.
          { mac: 'Cmd-Ctrl-Shift-ArrowLeft', preventDefault: true, run: expandSelection },
          { mac: 'Cmd-Ctrl-Shift-ArrowRight', preventDefault: true, run: shrinkSelection },
          // Select all occurrences of the selection, the all-at-once form of
          // Mod-d. Bound twice on purpose: Shift+D is the chord asked for, and
          // Shift+L is VS Code's own — some browsers claim Shift+D for
          // "bookmark all tabs" and never let the page see the keystroke.
          // Declared here so it beats searchKeymap's own Mod-Shift-l below.
          { key: 'Mod-Shift-d', preventDefault: true, run: selectAllOccurrences },
          { key: 'Mod-Shift-l', preventDefault: true, run: selectAllOccurrences },
          // Tab indents, Shift-Tab outdents. Without this nothing consumes Tab,
          // so the browser falls back to native focus traversal and lands on the
          // language picker in the corner instead of touching the document.
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          // Mod-g / Shift-Mod-g are dropped: CodeMirror calls preventDefault on
          // them but never stops propagation, so the window-level panel toggle
          // would fire in the same keystroke. Enter and Shift-Enter inside the
          // find field still step through matches, so nothing is lost.
          ...searchKeymap.filter((b) => b.key !== 'Mod-g' && b.key !== 'Shift-Mod-g'),
          ...foldKeymap,
          { key: 'Alt-z', preventDefault: true, run: (vw) => { toggleWrap(vw); return true; } },
          // VS Code's Format Document chord, same on every platform.
          { key: 'Shift-Alt-f', preventDefault: true, run: formatDocument },
          // VS Code's Find All References chord.
          {
            key: 'Shift-Alt-F12',
            preventDefault: true,
            run: (vw) => {
              const w = vw.state.wordAt(vw.state.selection.main.head);
              if (w) void openPeek(vw.state.sliceDoc(w.from, w.to));
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            value = u.state.doc.toString();
            pushOutline(u.view);
            // The ladder holds document offsets; an edit invalidates them.
            resetSelectionHistory(u.view);
          }
          if (
            u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged ||
            u.transactions.some((tr) => tr.effects.length > 0)
          ) {
            recomputeTicks(u.view);
            syncCrumbs(u.view);
          }
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': {
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            overflow: 'auto',
          },
          // Float the find box instead of docking it. Left in the flex flow a
          // panel shrinks .cm-scroller, which both pushes the text down and
          // desyncs the tick rail: docPosToGutterY scales by scroller
          // clientHeight while the rail spans the full container, so every tick
          // lands short by the panel's height. Out of flow fixes both at once.
          // Ported from the markdown pane, which has floated since v0.7.0.
          // Colors live in editor-theme.ts (Compartment-swapped light/dark).
          '.cm-panels': { backgroundColor: 'transparent', border: 'none' },
          '.cm-panels.cm-panels-top': { borderBottom: 'none' },
          '.cm-panel.cm-search': {
            position: 'absolute',
            top: '8px',
            right: '30px',
            maxWidth: '460px',
            padding: '6px 8px',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '4px',
            fontSize: '12px',
            zIndex: '15',
          },
          '.cm-panel.cm-search input.cm-textfield': {
            padding: '2px 6px',
            fontSize: '12px',
            minWidth: '180px',
            borderRadius: '4px',
          },
          '.cm-panel.cm-search button[name]': {
            padding: '2px 8px',
            fontSize: '11px',
            border: '1px solid transparent',
            borderRadius: '3px',
            background: 'transparent',
            cursor: 'pointer',
            color: 'inherit',
          },
          '.cm-panel.cm-search label': {
            fontSize: '11px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '2px',
          },
          '.cm-panel.cm-search br': { display: 'none' },
        }),
        // Change gutter + peek panel. In the editor theme rather than the
        // component stylesheet because every element it targets is rendered by
        // CodeMirror, including the widget's own DOM.
        EditorView.theme({
          // The one piece of @codemirror/merge's presentation that cannot be
          // switched off by configuration. The peek panel replaces it, on
          // demand, instead of every deleted chunk being permanently on screen.
          '.cm-deletedChunk': { display: 'none' },
          '.gmd-blame-gutter': {
            padding: '0 6px 0 4px',
            fontSize: '90%',
            whiteSpace: 'pre',
            userSelect: 'none',
            borderRight: '1px solid rgba(128, 128, 128, 0.25)',
          },
          '.gmd-blame': {
            display: 'inline-block',
            // Fixed rather than content-sized: the column is then the same
            // width in every file, and one unusually long name cannot push the
            // text of a whole document sideways.
            minWidth: '20ch',
            maxWidth: '20ch',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            verticalAlign: 'bottom',
            color: '#767676',
            cursor: 'default',
          },
          '.gmd-blame-new': { color: '#e2c08d' },
          '.gmd-blame-inline': {
            color: '#6a6a6a',
            fontStyle: 'italic',
            whiteSpace: 'pre',
            cursor: 'default',
            userSelect: 'none',
          },
          // Wider than the 3px bar it draws: a 3px click target is pixel-sniping.
          '.gmd-change-gutter': { width: '10px', cursor: 'pointer' },
          '.gmd-change-gutter .cm-gutterElement': { position: 'relative' },
          '.gmd-chg': { boxShadow: 'inset 3px 0 0 0 currentColor' },
          '.gmd-chg-mod': { color: '#1b81a8' },
          '.gmd-chg-add': { color: '#487e02' },
          // A deletion occupies no line of this document, so it gets a stub at
          // the top edge of the line that closed over it, not a full-height bar.
          '.gmd-chg-del': { color: 'transparent' },
          '.gmd-chg-del::before': {
            content: '""',
            position: 'absolute',
            left: '0',
            top: '0',
            width: '3px',
            height: '7px',
            background: '#f14c4c',
          },
          '.gmd-peek': {
            margin: '2px 0',
            border: '1px solid #505050',
            borderRadius: '4px',
            background: '#232323',
            overflow: 'hidden',
          },
          '.gmd-peek-bar': {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '3px 8px',
            background: '#272727',
            borderBottom: '1px solid #404040',
            fontSize: '11px',
            color: '#949494',
          },
          '.gmd-peek-label': { flex: '1 1 auto' },
          '.gmd-peek-btn': {
            font: 'inherit',
            padding: '1px 8px',
            borderRadius: '3px',
            border: '1px solid #505050',
            background: '#2d2d2d',
            color: '#c5c8c6',
            cursor: 'pointer',
          },
          '.gmd-peek-btn:hover': { background: '#3a3a3a' },
          '.gmd-peek-text': {
            margin: '0',
            padding: '4px 8px',
            whiteSpace: 'pre-wrap',
            color: '#c5c8c6',
            background: 'rgba(248, 81, 73, 0.10)',
          },
        }),
      ],
    });

    // This effect must have ZERO reactive dependencies. It writes `view`, so
    // any tracked read of `view` inside it (applyLanguage's guard used to run
    // right here) makes it self-invalidating: every run schedules the next,
    // stacking a fresh EditorView into the host each cycle — observed as 1001
    // stacked editors / 36k DOM lines from a 60-line file, i.e. the freeze on
    // opening any non-markdown file. Language detection lives in its own
    // effect below, keyed on `filename`.
    const created = new EditorView({ state, parent: host });
    untrack(() => {
      view = created;
    });
    pushOutline(created);

    // Opening a file should leave the caret in the editor. Without this the
    // document keeps body focus, so the first Mod-F after a click reaches the
    // browser's own find bar instead of the editor's. Deferred a frame so the
    // view is laid out before it takes focus.
    const focusFrame = requestAnimationFrame(() => created.focus());

    // Ticks on container resize (splitter drag) + initial pass. `created` is
    // a local and the tick fns only write state — no tracked reads added.
    const ro = new ResizeObserver(() => recomputeTicks(created));
    ro.observe(created.scrollDOM);
    recomputeTicks(created);

    return () => {
      cancelAnimationFrame(focusFrame);
      cancelAnimationFrame(crumbFrame);
      ro.disconnect();
      created.destroy();
      untrack(() => {
        if (view === created) view = null;
      });
    };
  });

  // Detect + apply the grammar for the current filename. Runs at mount (the
  // creation effect above is declared first, so `view` exists) and again when
  // a preview tab is reused for a different file — which previously kept the
  // old file's grammar. Only `filename` is tracked.
  $effect(() => {
    const name = filename;
    if (!untrack(() => view)) return;
    const detected = describeFor(name);
    untrack(() => {
      // Env files open covered. Anything else opens clear — including a preview
      // tab reused for a different file, which is why this is unconditional
      // rather than only armed on a match.
      view?.dispatch({ effects: setCloak.of(isDotenvFile(name)) });
      // A grammar picked by hand outranks the one the filename implies, and is
      // remembered per tab. Validated against the current list so a name left in
      // the cache by an older version cannot send applyLanguage hunting for a
      // grammar that no longer exists.
      const picked = viewKey ? tabViewOf(viewKey)?.lang : undefined;
      selectedLanguage = picked && languageNames.includes(picked)
        ? picked
        : detected ? detected.name : PLAIN;
      void applyLanguage(selectedLanguage).then(() => {
        const vw = view;
        if (vw) pushOutline(vw);
      });
    });
  });

  // Refetch when the tab is pointed at a different file. `originalText` is
  // cleared first so the no-op guard in loadOriginal cannot mistake the
  // previous file's content for this one's.
  $effect(() => {
    const p = gitPath;
    if (!untrack(() => view)) return;
    untrack(() => {
      originalText = null;
      void loadOriginal();
    });
    void p;
  });

  // Staging, reverting or committing moves the index the gutter is measured
  // against; `focus` covers the same things done outside this window. Both
  // no-op when the original is unchanged, which is the common case.
  $effect(() => {
    const on = () => { void loadOriginal(); void loadBlame(); };
    window.addEventListener('gmd:git-refresh', on);
    window.addEventListener('focus', on);
    return () => {
      window.removeEventListener('gmd:git-refresh', on);
      window.removeEventListener('focus', on);
    };
  });

  // The window-wide preference, read once at open so a tab created while blame
  // is on comes up with it on.
  let blameOn = $state(typeof localStorage !== 'undefined' && localStorage.getItem('ghmd.blame') === '1');

  $effect(() => {
    const on = (e: Event) => { blameOn = !!(e as CustomEvent).detail?.on; };
    window.addEventListener('gmd:toggle-blame', on);
    return () => window.removeEventListener('gmd:toggle-blame', on);
  });

  // Independent of the column: the annotation is the cheaper of the two to
  // leave on permanently, and plenty of people want one without the other.
  let inlineBlameOn = $state(typeof localStorage !== 'undefined' && localStorage.getItem('ghmd.blameInline') === '1');

  $effect(() => {
    const on = (e: Event) => { inlineBlameOn = !!(e as CustomEvent).detail?.on; };
    window.addEventListener('gmd:toggle-blame-inline', on);
    return () => window.removeEventListener('gmd:toggle-blame-inline', on);
  });

  async function loadBlame() {
    const vw = untrack(() => view);
    if (!vw) return;
    const p = gitPath;
    // One fetch feeds both the column and the annotation, so it runs when
    // either is on and is torn down only when both are off.
    if ((!untrack(() => blameOn) && !untrack(() => inlineBlameOn)) || !p) {
      closeBlameCards();
      vw.dispatch({ effects: [blameCompartment.reconfigure([]), inlineCompartment.reconfigure([])] });
      return;
    }
    let data: BlameData | null = null;
    try {
      const r = await fetch(`/api/git/blame?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (r.ok && d.tracked) data = d as BlameData;
    } catch {
      return; // offline or mid-restart: the next refresh tries again
    }
    // The tab may have been pointed elsewhere, or blame switched off, while
    // this was in flight.
    if (untrack(() => view) !== vw || gitPath !== p) return;
    if (!untrack(() => blameOn) && !untrack(() => inlineBlameOn)) return;
    closeBlameCards();
    vw.dispatch({
      effects: [
        blameCompartment.reconfigure(data && untrack(() => blameOn) ? blameGutter(data) : []),
        inlineCompartment.reconfigure(data && untrack(() => inlineBlameOn) ? inlineBlame(data) : []),
      ],
    });
  }

  $effect(() => {
    void blameOn;
    void inlineBlameOn;
    void gitPath;
    if (!untrack(() => view)) return;
    untrack(() => { void loadBlame(); });
  });

  $effect(() => {
    const w = wrapFor(viewKey);
    const v = view;
    if (!v || w === appliedWrap) return;
    appliedWrap = w;
    v.dispatch({ effects: wrapCompartment.reconfigure(w ? EditorView.lineWrapping : []) });
  });

  $effect(() => {
    const ms = marks;
    const v = view;
    if (!v) return;
    const doc = v.state.doc;
    const ranges = [];
    for (const m of ms) {
      // Clamped: the host recomputes marks from its own copy of the text, so
      // a mark can briefly describe a document that has already shrunk.
      const from = Math.min(Math.max(0, m.from), doc.length);
      const to = Math.min(Math.max(from, m.to), doc.length);
      if (to <= from) continue;
      ranges.push(Decoration.mark({ class: m.cls }).range(from, to));
    }
    v.dispatch({ effects: markCompartment.reconfigure(EditorView.decorations.of(RangeSet.of(ranges, true))) });
  });

  $effect(() => {
    const r = reveal;
    const v = view;
    if (!r || !v) return;
    const doc = v.state.doc;
    const pos = doc.line(Math.min(Math.max(1, r.line), doc.lines)).from;
    // A resolved identifier outranks the line it was reported on: the caller
    // asked to see a symbol, and the line is only how it found it.
    const found = r.word ? findSymbol(v.state, r.word, r.line) : null;
    if (found) {
      landOn(v, found);
    } else if (r.select) {
      // Clamp: the outline is pushed asynchronously, so its offsets can
      // describe a document that has since shrunk.
      const from = Math.min(Math.max(0, r.select.from), doc.length);
      const to = Math.min(Math.max(from, r.select.to), doc.length);
      v.dispatch({
        selection: EditorSelection.single(from, to),
        // Anchor on the start: for a long declaration, seeing where it begins
        // is more useful than seeing where it ends.
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
    } else {
      v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    }
    v.focus();
    // A view created in this same tick has not measured its viewport yet, so
    // the scroll above can leave CodeMirror painting stranded rows from the
    // old position above the new ones. Re-measure once layout settles.
    // Deliberately NOT cancelled on cleanup: the effect re-runs while the view
    // is being set up, and cancelling there is exactly what loses the repair.
    requestAnimationFrame(() => {
      try { v.requestMeasure(); } catch {}
    });
  });

  // External value change (e.g. conflict reload): replace the whole doc. The
  // updateListener echo makes doc.toString() === value on our own edits, so
  // this only fires for genuinely external content.
  $effect(() => {
    const v = value;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== v) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: v } });
    }
  });

  // Hot-swap chrome when the OS scheme flips.
  $effect(() => {
    const dark = isDark;
    if (!view) return;
    view.dispatch({ effects: themeCompartment.reconfigure(dark ? darkBundle : lightBundle) });
  });
</script>

<div class="code-container">
  <!-- Always present, whether or not the grammar yields an outline: the strip
       carries the language picker too, and one that appeared and vanished with
       the parse would shift the editor down a row mid-typing. Height is
       reserved for the whole file rather than per-position for the same
       reason — a strip that only shows where a symbol encloses the caret makes
       the editor jump a row on every scroll past a top-level gap. -->
  <div class="code-head">
    <div class="symbol-crumbs" aria-label="Symbol path">
      {#each crumbs as c, i (c.from + ':' + i)}
        {#if i > 0}<span class="crumb-sep" aria-hidden="true">›</span>{/if}
        <button type="button" class="crumb" title={c.text} onclick={() => gotoCrumb(c)}>
          {c.name ?? c.text}
        </button>
      {/each}
    </div>
    <select
      class="lang-picker"
      class:hidden={searchOpen}
      bind:value={selectedLanguage}
      onchange={() => {
        // Remembered for this tab so it survives switching away and back.
        if (viewKey) patchTabView(viewKey, { lang: selectedLanguage });
        void applyLanguage(selectedLanguage).then(() => {
          // A hand-picked grammar has to re-feed the outline itself. Nothing
          // else fires on this path, and on an unsaved buffer the filename
          // effect — the only other feeder — never will, so the strip would
          // stay empty.
          const vw = view;
          if (vw) pushOutline(vw);
        });
      }}
      title="Syntax language"
      aria-label="Syntax language"
    >
      {#each languageNames as name (name)}
        <option value={name}>{name}</option>
      {/each}
    </select>
  </div>
  <div class="code-body">
    <div class="code-host" bind:this={host}></div>
    <div class="sticky-stack" style={stickyFont}>
      {#each stickyRows as r (r.line)}
        <button
          type="button"
          class="sticky-row"
          title="Line {r.line}"
          onclick={() => gotoLine(r.line)}
        ><span class="sticky-ln" style="width: {stickyPad}px">{r.line}</span>{@html r.html}</button>
      {/each}
    </div>
    <div class="editor-tick-rail" aria-hidden="true">
      {#each wordTicks as y, i (i + ':cword')}
        <span class="tick word" style="top: {y}px"></span>
      {/each}
      {#each matchTicks as y, i (i + ':cmatch')}
        <span class="tick match" style="top: {y}px"></span>
      {/each}
      {#if currentTickY !== null}
        <span class="tick current" style="top: {currentTickY}px"></span>
      {/if}
    </div>
    {#if peek}
      <!-- Over the editor rather than beside it: the point of a peek is that
           the file being read stays where it was, so closing the panel returns
           to exactly the same view. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="peek pl-dark" role="dialog" aria-label="References" tabindex="-1" use:autofocus onkeydown={peekKey}>
        <div class="peek-head">
          <span class="peek-title">{peek.name}</span>
          <span class="peek-count">
            {peek.loading ? 'searching…' : `${peek.hits.length}${peek.truncated ? '+' : ''} references`}
          </span>
          {#if peekGroups.length > 1}
            <button
              type="button"
              class="peek-fold"
              title={peekAllFolded ? 'Show every hit again' : 'Fold every file shut — file names and counts only'}
              onclick={toggleAllGroups}
            >{peekAllFolded ? 'expand all' : 'collapse all'}</button>
          {/if}
          <button type="button" class="peek-close" title="Close (Esc)" onclick={closePeek}>✕</button>
        </div>
        <div class="peek-body">
          <div class="peek-preview">
            {#if peek.preview}
              <div class="peek-path">{peek.preview.path}</div>
              {#each peek.preview.lines as l (l.n)}
                <div class="peek-line" class:hit={l.hit}>
                  <span class="peek-ln">{l.n}</span><span class="peek-code">{#each l.toks as t, i (i)}<span class={t.cls ?? ''}>{t.text}</span>{/each}</span>
                </div>
              {/each}
            {:else}
              <div class="peek-empty">{peek.loading ? 'Searching…' : 'Loading preview…'}</div>
            {/if}
          </div>
          <div class="peek-locs">
            {#each peekGroups as g (g.path)}
              {@const folded = peekFolded.includes(g.path)}
              <div class="peek-group">
                <button
                  type="button"
                  class="peek-file"
                  aria-expanded={!folded}
                  title={folded ? 'Show these hits' : 'Fold this file shut'}
                  onclick={() => toggleGroup(g.path)}
                >
                  <span class="peek-chev" class:folded>⌄</span>
                  <span class="peek-base">{g.base}</span>
                  <span class="peek-dir" title={g.dir}>{g.dir}</span>
                  <span class="peek-n">{g.hits.length}</span>
                </button>
                {#if !folded}
                  {#each g.hits as h (h.i)}
                    <button
                      type="button"
                      class="peek-hit"
                      class:sel={peek?.sel === h.i}
                      title="Enter or double-click to open"
                      onclick={() => void loadPreview(h.i)}
                      ondblclick={() => peekOpen(h.i)}
                    >
                      <span class="peek-hln">{h.line}</span><span class="peek-htext">{h.pre}<mark>{h.mid}</mark>{h.post}</span>
                    </button>
                  {/each}
                {/if}
              </div>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
{#if notice}
  <div class="notice">{notice}</div>
{/if}

<style>
  .code-container {
    position: relative;
    height: 100%;
    width: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  /* The tick rail is positioned against this box, not against the container,
     so the strip above cannot skew it. */
  .code-body {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  /* Anchored to the bottom of the editor box, the way VS Code's peek grows up
     from the line you invoked it on — close enough to that, and it costs no
     per-line widget bookkeeping. */
  .peek {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 45%;
    min-height: 160px;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    border-top: 1px solid #007acc;
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.4);
    z-index: 8;
    outline: none;
  }
  .peek-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 24px;
    padding: 0 4px 0 10px;
    background: #252526;
    border-bottom: 1px solid #333;
    font-size: 12px;
  }
  .peek-title {
    color: #d4d4d4;
    font-weight: 600;
  }
  .peek-count {
    flex: 1 1 auto;
    color: #8a8a8a;
    font-size: 11px;
  }
  .peek-close {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 3px;
    background: none;
    color: #949494;
    cursor: pointer;
    line-height: 1;
  }
  .peek-close:hover {
    background: #3a3a3a;
    color: #e6e6e6;
  }
  .peek-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .peek-preview {
    flex: 1 1 0;
    min-width: 0;
    overflow: auto;
    padding: 4px 0 6px;
    font-family: var(--gmd-code-font, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    line-height: 1.45;
  }
  .peek-path {
    padding: 0 10px 4px;
    color: #7a7a7a;
    font-size: 11px;
  }
  .peek-line {
    display: flex;
    white-space: pre;
  }
  /* The line the match is on. Everything else in the window is context, and
     without this the reader has to count rows to find it. */
  .peek-line.hit {
    background: rgba(0, 122, 204, 0.18);
  }
  .peek-ln {
    flex: 0 0 auto;
    width: 46px;
    padding-right: 10px;
    text-align: right;
    color: #5a5a5a;
    user-select: none;
  }
  .peek-code {
    flex: 1 1 auto;
    padding-right: 10px;
  }
  .peek-empty {
    padding: 10px;
    color: #7a7a7a;
    font-size: 12px;
  }
  .peek-locs {
    flex: 0 0 38%;
    min-width: 220px;
    overflow: auto;
    border-left: 1px solid #333;
    background: #1b1b1b;
    padding: 2px 0 6px;
  }
  .peek-fold {
    flex: 0 0 auto;
    border: none;
    background: none;
    padding: 0 4px;
    color: #8a8a8a;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .peek-fold:hover {
    color: #d4d4d4;
    text-decoration: underline;
  }
  .peek-file {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 3px 8px 2px;
    border: none;
    background: none;
    text-align: left;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .peek-file:hover {
    background: #232323;
  }
  /* Points down at an open group, right at a folded one — the direction the
     hits would travel, which is the convention every tree here already uses. */
  .peek-chev {
    flex: 0 0 auto;
    display: inline-block;
    width: 9px;
    color: #8a8a8a;
    font-size: 10px;
    line-height: 1;
    transform-origin: 50% 40%;
    transition: transform 90ms linear;
  }
  .peek-chev.folded {
    transform: rotate(-90deg);
  }
  .peek-base {
    color: #d4d4d4;
  }
  /* The parent folder, faint and truncated from the left where it matters —
     two files named the same are told apart by the tail of their directory,
     not the head. */
  .peek-dir {
    flex: 1 1 auto;
    min-width: 0;
    color: #6e6e6e;
    direction: rtl;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .peek-n {
    flex: 0 0 auto;
    color: #8a8a8a;
  }
  .peek-hit {
    display: flex;
    width: 100%;
    gap: 8px;
    padding: 1px 8px 1px 16px;
    border: none;
    background: none;
    color: #b0b0b0;
    font-family: var(--gmd-code-font, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    white-space: pre;
    overflow: hidden;
  }
  .peek-hit:hover {
    background: #2a2d2e;
  }
  .peek-hit.sel {
    background: #04395e;
    color: #e6e6e6;
  }
  .peek-hln {
    flex: 0 0 auto;
    width: 34px;
    text-align: right;
    color: #5a5a5a;
  }
  .peek-htext {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .peek-htext mark {
    background: rgba(229, 192, 32, 0.32);
    color: inherit;
    border-radius: 2px;
  }
  /* One row above the editor holding the symbol path and the language picker.
     The picker used to float over the top-right of the text, which put it on
     top of any line long enough to reach there. */
  .code-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 22px;
    padding: 0 8px;
    background: #232323;
    border-bottom: 1px solid #404040;
  }
  /* Not `.crumbs`: the tab header already owns that name for the file path, and
     two breadcrumbs on one screen are confusing enough without sharing one. */
  .symbol-crumbs {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    overflow-y: hidden;
    white-space: nowrap;
    scrollbar-width: none;
  }
  .symbol-crumbs::-webkit-scrollbar {
    display: none;
  }
  .crumb {
    background: none;
    border: none;
    padding: 1px 3px;
    border-radius: 3px;
    font: inherit;
    font-size: 11px;
    line-height: 1.4;
    color: #949494;
    cursor: pointer;
  }
  .crumb:hover {
    color: #c5c8c6;
    background: #2d2d2d;
  }
  .symbol-crumbs .crumb:last-child {
    color: #c5c8c6;
  }
  .crumb-sep {
    color: #6e7681;
    font-size: 11px;
  }
  /* Right edge stops short of the tick rail so scrollbar marks stay readable. */
  .sticky-stack {
    position: absolute;
    top: 0;
    left: 0;
    right: 24px;
    z-index: 4;
    pointer-events: none;
  }
  .sticky-row {
    display: block;
    width: 100%;
    box-sizing: border-box;
    height: 20px;
    line-height: 20px;
    text-align: left;
    white-space: pre;
    overflow: hidden;
    border: none;
    /* Translucent on purpose — enough of the covered code shows through to
       stay oriented, not so much that either layer becomes hard to read. */
    background: rgba(30, 30, 30, 0.78);
    color: #c5c8c6;
    font: inherit;
    cursor: pointer;
    pointer-events: auto;
  }
  .sticky-row:hover {
    background: rgba(45, 45, 45, 0.92);
  }
  /* The gutter underneath shows the numbers of the lines being covered, which
     are not these lines. Carry each pinned row's own number instead. */
  .sticky-ln {
    display: inline-block;
    box-sizing: border-box;
    padding-right: 8px;
    text-align: right;
    color: #6e7681;
    /* Opaque, unlike the rest of the row: the gutter beneath is showing the
       numbers of the covered lines, and two sets of digits in one cell is
       unreadable. Transparency is worth having over code, not over numbers. */
    background: #1e1e1e;
  }
  .sticky-stack .sticky-row:last-child {
    box-shadow: 0 1px 0 rgba(80, 80, 80, 0.45);
  }
  .code-host {
    height: 100%;
    width: 100%;
    overflow: hidden;
  }
  .code-host :global(.cm-editor) {
    height: 100%;
  }
  .code-host :global(.cm-scroller) {
    overflow: auto;
  }
  /* v0.9.0: scrollbar tick rail, same chrome as the markdown editor (24px). */
  .editor-tick-rail {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 24px;
    pointer-events: none;
    z-index: 5;
  }
  .editor-tick-rail .tick {
    position: absolute;
    right: 2px;
    width: 20px;
    height: 3px;
    border-radius: 1px;
  }
  .notice {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    background: #272727;
    border: 1px solid #505050;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    color: #c5c8c6;
    z-index: 120;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }
  .editor-tick-rail .tick.word { background: rgba(84, 122, 255, 0.9); }
  .editor-tick-rail .tick.match { background: rgba(255, 195, 0, 0.85); }
  .editor-tick-rail .tick.current {
    background: #ff6b00;
    height: 4px;
    width: 22px;
    right: 1px;
  }
  .lang-picker {
    flex: 0 0 auto;
    font-size: 11px;
    line-height: 1.4;
    padding: 0 2px;
    border-radius: 3px;
    border: 1px solid rgba(64, 64, 64, 0.7);
    background: #272727;
    color: #949494;
    max-width: 150px;
  }
  .lang-picker:hover {
    color: #c5c8c6;
  }
  /* Still yields while the find box is open: a live dropdown beside a query
     field reads as part of it. */
  .lang-picker.hidden {
    display: none;
  }
</style>
