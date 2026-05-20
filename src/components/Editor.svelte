<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
  import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
  import { history, historyKeymap, defaultKeymap, indentWithTab, selectParentSyntax } from '@codemirror/commands';
  import { indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, defaultHighlightStyle, syntaxTree, LanguageDescription } from '@codemirror/language';
  import { highlightSelectionMatches, searchKeymap, search, getSearchQuery } from '@codemirror/search';
  import { markdown as markdownLang, markdownLanguage } from '@codemirror/lang-markdown';
  import { languages as codeLanguages } from '@codemirror/language-data';
  import { sql } from '@codemirror/lang-sql';
  import { javascript } from '@codemirror/lang-javascript';
  import { python } from '@codemirror/lang-python';
  import { json } from '@codemirror/lang-json';
  import { yaml } from '@codemirror/lang-yaml';
  import { html as htmlLang } from '@codemirror/lang-html';
  import { css as cssLang } from '@codemirror/lang-css';
  import { tags as t } from '@lezer/highlight';

  // v0.5.0: pre-resolved LanguageDescription entries for the common fenced-code
  // languages we expect in markdown drafts. language-data's lazy LanguageDescriptions
  // load on demand but the initial parse pass treats the fence as plain text — the
  // re-decorate after load is unreliable for already-parsed fences in this stack.
  // Pre-resolving means highlight applies on first paint.
  const PRELOADED_LANGS = [
    LanguageDescription.of({ name: 'sql', alias: ['postgresql', 'mysql'], extensions: ['sql'], support: sql() }),
    LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], extensions: ['ts', 'tsx'], support: javascript({ typescript: true, jsx: true }) }),
    LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx', 'node'], extensions: ['js', 'jsx', 'mjs', 'cjs'], support: javascript({ jsx: true }) }),
    LanguageDescription.of({ name: 'python', alias: ['py'], extensions: ['py'], support: python() }),
    LanguageDescription.of({ name: 'json', extensions: ['json'], support: json() }),
    LanguageDescription.of({ name: 'yaml', alias: ['yml'], extensions: ['yaml', 'yml'], support: yaml() }),
    LanguageDescription.of({ name: 'html', alias: ['htm'], extensions: ['html', 'htm'], support: htmlLang() }),
    LanguageDescription.of({ name: 'css', extensions: ['css'], support: cssLang() }),
  ];
  // Concat with the lazy descriptors from language-data so any OTHER language
  // (Go, Rust, Java, etc.) still works via the standard async load path.
  const MARKDOWN_CODE_LANGS = [...PRELOADED_LANGS, ...codeLanguages];

  let {
    value = $bindable(''),
    view = $bindable<EditorView | null>(null),
    topLine = $bindable(1),
    onRevealRequest,
  }: {
    value?: string;
    view?: EditorView | null;
    topLine?: number;
    onRevealRequest?: (line: number) => void;
  } = $props();

  let host: HTMLDivElement;
  let localView: EditorView | null = null;

  // v0.5.0: scrollbar match-tick state (rendered in template, updated via
  // updateListener inside the CM6 setup). Three layers: implicit (word at
  // cursor, light shade), match (explicit Cmd+F query, brighter), current
  // (the active match, accent color).
  let matchTicks = $state<number[]>([]);
  let implicitTicks = $state<number[]>([]);
  let currentTickY = $state<number | null>(null);

  const githubMarkdownHighlight = HighlightStyle.define([
    // Markdown-level tags
    { tag: t.heading1, color: '#cf222e', fontWeight: '700', fontSize: '1.18em' },
    { tag: t.heading2, color: '#0550ae', fontWeight: '700', fontSize: '1.10em' },
    { tag: t.heading3, color: '#6639ba', fontWeight: '600' },
    { tag: t.heading4, color: '#953800', fontWeight: '600' },
    { tag: t.heading5, color: '#0a3069', fontWeight: '500' },
    { tag: t.heading6, color: '#3b2300', fontWeight: '500' },
    { tag: t.strong, color: '#1f2328', fontWeight: '700' },
    { tag: t.emphasis, color: '#1f2328', fontStyle: 'italic' },
    { tag: t.monospace, color: '#953800', backgroundColor: 'rgba(175,184,193,0.20)' },
    { tag: t.link, color: '#0969da', textDecoration: 'underline' },
    { tag: t.url, color: '#0969da' },
    { tag: t.meta, color: '#6e7681' },
    { tag: t.quote, color: '#6e7681', fontStyle: 'italic' },
    { tag: t.list, color: '#1f2328' },
    // Nested-language tags (SQL, TypeScript, Python, etc. inside fenced code).
    // Without these, fence contents render uniformly black because our markdown
    // style only covers markdown tags. GitHub palette mapping below.
    { tag: t.keyword, color: '#cf222e', fontWeight: '600' },
    { tag: t.controlKeyword, color: '#cf222e', fontWeight: '600' },
    { tag: t.operatorKeyword, color: '#cf222e' },
    { tag: t.definitionKeyword, color: '#cf222e', fontWeight: '600' },
    { tag: t.modifier, color: '#cf222e' },
    { tag: t.string, color: '#0a3069' },
    { tag: t.special(t.string), color: '#0a3069' },
    { tag: t.regexp, color: '#0a3069' },
    { tag: t.number, color: '#0550ae' },
    { tag: t.atom, color: '#0550ae' },
    { tag: t.bool, color: '#0550ae' },
    { tag: t.null, color: '#0550ae' },
    { tag: t.comment, color: '#6e7681', fontStyle: 'italic' },
    { tag: t.lineComment, color: '#6e7681', fontStyle: 'italic' },
    { tag: t.blockComment, color: '#6e7681', fontStyle: 'italic' },
    { tag: t.typeName, color: '#0550ae' },
    { tag: t.className, color: '#0550ae', fontWeight: '500' },
    { tag: t.variableName, color: '#1f2328' },
    { tag: t.propertyName, color: '#6639ba' },
    { tag: t.function(t.variableName), color: '#6639ba' },
    { tag: t.function(t.propertyName), color: '#6639ba' },
    { tag: t.definition(t.variableName), color: '#1f2328' },
    { tag: t.standard(t.variableName), color: '#0550ae' },
    { tag: t.attributeName, color: '#6639ba' },
    { tag: t.attributeValue, color: '#0a3069' },
    { tag: t.tagName, color: '#116329' },
    { tag: t.namespace, color: '#0550ae' },
    { tag: t.operator, color: '#cf222e' },
    { tag: t.punctuation, color: '#1f2328' },
    { tag: t.bracket, color: '#1f2328' },
    { tag: t.escape, color: '#0550ae' },
    { tag: t.invalid, color: '#cf222e', textDecoration: 'underline wavy' },
  ]);

  const wrapCompartment = new Compartment();
  let wrapEnabled = true;
  try { wrapEnabled = localStorage.getItem('gmd:wrap') !== 'off'; } catch { /* noop */ }

  function toggleWrap(vw: EditorView) {
    wrapEnabled = !wrapEnabled;
    try { localStorage.setItem('gmd:wrap', wrapEnabled ? 'on' : 'off'); } catch { /* noop */ }
    vw.dispatch({
      effects: wrapCompartment.reconfigure(wrapEnabled ? EditorView.lineWrapping : []),
    });
  }

  const PAIRS: Record<string, string> = {
    '`': '`', '*': '*', '_': '_', '~': '~',
    '(': ')', '[': ']', '{': '}',
    '"': '"', "'": "'",
  };
  const markdownAutoPair = EditorView.inputHandler.of((v, from, to, text) => {
    if (from === to) return false;
    if (!(text in PAIRS)) return false;
    const closing = PAIRS[text];
    const selected = v.state.sliceDoc(from, to);
    v.dispatch({
      changes: { from, to, insert: text + selected + closing },
      selection: { anchor: from + text.length, head: from + text.length + selected.length },
      userEvent: 'input.type.markdownPair',
    });
    return true;
  });

  // --- Heading-section selection escalation (v0.5.0) ---
  // selectParentSyntax is great inside a block (line → fence → block) but in
  // flat markdown it walks SIDEWAYS into the next block rather than wrapping the
  // enclosing heading section. Clamp: once selectParentSyntax overshoots the
  // heading-section bounds (heading → next-heading-at-same-or-shallower-level),
  // snap to those bounds. Next press from there resumes selectParentSyntax
  // (typically jumping to whole document).
  const HEADING_NAMES = new Set([
    'ATXHeading1','ATXHeading2','ATXHeading3','ATXHeading4','ATXHeading5','ATXHeading6',
    'SetextHeading1','SetextHeading2',
  ]);
  function headingLevel(name: string): number {
    const m = name.match(/Heading(\d)$/);
    return m ? Number(m[1]) : 0;
  }
  function findSectionBounds(state: EditorState, pos: number): {from: number; to: number} | null {
    const tree = syntaxTree(state);
    const headings: {from: number; level: number}[] = [];
    tree.iterate({
      enter: (node) => {
        if (HEADING_NAMES.has(node.name)) {
          headings.push({ from: node.from, level: headingLevel(node.name) });
        }
      },
    });
    if (headings.length === 0) return null;
    let idx = -1;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].from <= pos) idx = i;
      else break;
    }
    if (idx < 0) return null;
    const start = headings[idx].from;
    const lvl = headings[idx].level;
    let end = state.doc.length;
    for (let i = idx + 1; i < headings.length; i++) {
      if (headings[i].level <= lvl) { end = headings[i].from; break; }
    }
    return { from: start, to: end };
  }
  function selectParentOrSection(vw: EditorView): boolean {
    const state = vw.state;
    const before = state.selection.main;
    const bounds = findSectionBounds(state, before.head);
    if (bounds && before.from === bounds.from && before.to === bounds.to) {
      return selectParentSyntax(vw);
    }
    selectParentSyntax(vw);
    const after = vw.state.selection.main;
    const grew = after.from !== before.from || after.to !== before.to;
    const overshoot = bounds && (after.from < bounds.from || after.to > bounds.to);
    if (bounds && (overshoot || !grew)) {
      vw.dispatch({
        selection: EditorSelection.single(bounds.from, bounds.to),
        scrollIntoView: true,
      });
      return true;
    }
    return grew;
  }

  // --- Scrollbar tick computation (v0.5.0) ---
  // Convert a doc position into a Y offset inside the scrollbar gutter.
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
    const q = getSearchQuery(vw.state);
    if (!q || !q.search || !q.valid) {
      matchTicks = [];
      currentTickY = null;
      return;
    }
    const cur = q.getCursor(vw.state.doc);
    const ticks: number[] = [];
    const ranges: {from: number; to: number}[] = [];
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
    // Current match = the one containing or nearest after cursor head.
    const head = vw.state.selection.main.head;
    let nearest: {from: number; to: number} | null = null;
    for (const r of ranges) {
      if (r.from <= head && head <= r.to) { nearest = r; break; }
      if (r.from >= head) { nearest = r; break; }
    }
    currentTickY = nearest ? docPosToGutterY(vw, nearest.from) : null;
  }

  function recomputeImplicitTicks(vw: EditorView) {
    const state = vw.state;
    const sel = state.selection.main;
    let needle = '';
    if (!sel.empty) {
      // Use the actual selection text as the implicit highlight target
      // — mirrors highlightSelectionMatches' inline behavior on the scrollbar.
      const sub = state.sliceDoc(sel.from, sel.to);
      if (sub.length >= 1 && sub.length <= 200 && !/\n/.test(sub)) needle = sub;
    } else {
      const word = state.wordAt(sel.head);
      if (word) {
        const wt = state.sliceDoc(word.from, word.to);
        if (wt.length >= 2) needle = wt;
      }
    }
    if (!needle) { implicitTicks = []; return; }
    const doc = state.doc.toString();
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    const out: number[] = [];
    let m: RegExpExecArray | null;
    let safety = 5000;
    while ((m = re.exec(doc)) && safety-- > 0) {
      // Skip the exact selection range itself (don't tick what cursor is on)
      if (!sel.empty && m.index === sel.from) { continue; }
      const y = docPosToGutterY(vw, m.index);
      if (y != null) out.push(y);
      // Avoid zero-length match infinite loop
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    implicitTicks = out;
  }

  function recomputeTicks(vw: EditorView) {
    queueMicrotask(() => {
      try {
        recomputeMatchTicks(vw);
        recomputeImplicitTicks(vw);
      } catch { /* swallow — ticks are non-critical */ }
    });
  }

  $effect(() => {
    if (!host) return;
    const initialDoc = untrack(() => value);

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        history(),
        lineNumbers(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches({ minSelectionLength: 1, highlightWordAroundCursor: true }),
        search({ top: true }),
        // Layer order: custom markdown style WINS for tags it covers (headings,
        // strong, em, code, link). defaultHighlightStyle is the fallback for any
        // tag NOT in our custom set — critical for nested languages (SQL, TS, etc.)
        // whose grammars emit keyword/string/number tags we haven't styled.
        syntaxHighlighting(githubMarkdownHighlight),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        wrapCompartment.of(wrapEnabled ? EditorView.lineWrapping : []),
        markdownLang({ base: markdownLanguage, addKeymap: true, codeLanguages: MARKDOWN_CODE_LANGS }),
        markdownAutoPair,
        // Mac Opt+Z workaround (v0.5.0): Firefox on macOS emits the composed
        // character `Ω` for Alt+Z; CM6's `key: 'Alt-z'` checks event.key === 'z'
        // and never matches. Intercept at the DOM level BEFORE CM6's input handler
        // converts the keystroke into a `Ω` character insertion.
        EditorView.domEventHandlers({
          contextmenu: (event, vw) => {
            event.preventDefault();
            const pos = vw.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return true;
            const line = vw.state.doc.lineAt(pos).number;
            onRevealRequest?.(line);
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
        }),
        keymap.of([
          {
            key: 'Alt-z',
            preventDefault: true,
            run: (vw) => { toggleWrap(vw); return true; },
          },
          { key: 'Mod-Shift-ArrowRight', preventDefault: true, run: selectParentOrSection },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            value = u.state.doc.toString();
          }
          if (
            u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged ||
            u.transactions.some((tr) => tr.effects.length > 0)
          ) {
            recomputeTicks(u.view);
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' },
          '.cm-panels': { backgroundColor: 'transparent', border: 'none' },
          '.cm-panels.cm-panels-top': { borderBottom: 'none' },
          '.cm-panel.cm-search': {
            position: 'absolute',
            top: '8px',
            right: '24px',
            maxWidth: '460px',
            padding: '6px 8px',
            background: 'rgba(255,255,255,0.96)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: '1px solid #d0d7de',
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
            border: '1px solid #d0d7de',
            borderRadius: '4px',
            background: '#ffffff',
            color: '#1f2328',
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
          '.cm-panel.cm-search button[name]:hover': {
            background: 'rgba(9,105,218,0.10)',
            borderColor: '#d0d7de',
          },
          '.cm-panel.cm-search label': {
            fontSize: '11px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '2px',
          },
          '.cm-panel.cm-search br': { display: 'none' },
        }),
      ],
    });

    localView = new EditorView({ state, parent: host });
    view = localView;

    const scroller = localView.scrollDOM;
    const updateTop = () => {
      if (!localView) return;
      const rect = scroller.getBoundingClientRect();
      const pos = localView.posAtCoords({ x: rect.left + 12, y: rect.top + 4 });
      if (pos != null) {
        topLine = localView.state.doc.lineAt(pos).number;
      }
    };
    const onScroll = () => requestAnimationFrame(updateTop);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(updateTop);

    // Recompute ticks on container resize too (wrap toggle, splitter drag).
    const ro = new ResizeObserver(() => {
      if (localView) recomputeTicks(localView);
    });
    ro.observe(scroller);

    // Initial pass
    if (localView) recomputeTicks(localView);

    return () => {
      ro.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      localView?.destroy();
      localView = null;
      view = null;
    };
  });

  $effect(() => {
    if (!localView) return;
    const current = localView.state.doc.toString();
    if (current !== value) {
      localView.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  });
</script>

<div class="editor-container">
  <div class="editor-host" bind:this={host}></div>
  <div class="editor-tick-rail" aria-hidden="true">
    {#each implicitTicks as y, i (i + ':eimpl')}
      <span class="tick implicit" style="top: {y}px"></span>
    {/each}
    {#each matchTicks as y, i (i + ':ematch')}
      <span class="tick match" style="top: {y}px"></span>
    {/each}
    {#if currentTickY !== null}
      <span class="tick current" style="top: {currentTickY}px"></span>
    {/if}
  </div>
</div>

<style>
  .editor-container {
    position: relative;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }
  .editor-host {
    height: 100%;
    width: 100%;
    overflow: hidden;
  }
  .editor-host :global(.cm-editor) {
    height: 100%;
  }
  .editor-host :global(.cm-scroller) {
    overflow: auto;
  }

  .editor-tick-rail {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 12px;
    pointer-events: none;
    z-index: 5;
  }
  .editor-tick-rail .tick {
    position: absolute;
    right: 2px;
    width: 8px;
    height: 2px;
    border-radius: 1px;
  }
  .editor-tick-rail .tick.match {
    background: rgba(255, 195, 0, 0.85);
  }
  .editor-tick-rail .tick.implicit {
    background: rgba(132, 165, 200, 0.65);
  }
  .editor-tick-rail .tick.current {
    background: #ff6b00;
    height: 3px;
    width: 10px;
    right: 1px;
  }

  @media (prefers-color-scheme: dark) {
    .editor-host :global(.cm-panel.cm-search) {
      background: rgba(22, 27, 34, 0.96);
      border-color: #30363d;
      color: #c9d1d9;
    }
    .editor-host :global(.cm-panel.cm-search input.cm-textfield) {
      background: #0d1117;
      border-color: #30363d;
      color: #c9d1d9;
    }
    .editor-host :global(.cm-panel.cm-search button[name]:hover) {
      background: rgba(56, 139, 253, 0.16);
      border-color: #30363d;
    }
  }
</style>
