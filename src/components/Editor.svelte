<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
  import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
  import { history, historyKeymap, defaultKeymap, indentWithTab, selectParentSyntax } from '@codemirror/commands';
  import { indentOnInput, bracketMatching, syntaxTree, LanguageDescription } from '@codemirror/language';
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
  import { editorThemeExtensions } from '../lib/editor-theme';
  import type { EffectiveTheme, ThemeChoice } from '../lib/theme';
  import ThemeToggle from './ThemeToggle.svelte';

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
    themeChoice = 'auto',
    effectiveTheme = 'light',
    onThemeToggle,
    onZoomIn,
    onZoomOut,
  }: {
    value?: string;
    view?: EditorView | null;
    topLine?: number;
    onRevealRequest?: (line: number) => void;
    themeChoice?: ThemeChoice;
    effectiveTheme?: EffectiveTheme;
    onThemeToggle?: () => void;
    onZoomIn?: () => void;
    onZoomOut?: () => void;
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

  // v0.7.0: theme moved out to ../lib/editor-theme.ts and surfaced through a
  // Compartment so per-pane light/dark toggle can hot-swap without rebuilding
  // the state. Fixes the washed-out token colors that pre-v0.7 displayed when
  // the OS was dark but the editor still ran its light-only highlight style.
  const themeCompartment = new Compartment();

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

  // v0.6.6: editor-pane-only font size (Cmd+= / Cmd+- / Cmd+0) via Compartment-
  // reconfigure of EditorView.theme. Persists across reloads. Preview pane is
  // intentionally unaffected — the request was for per-pane control so heading
  // hierarchy stays readable in the rendered side while you bump editor text.
  const fontSizeCompartment = new Compartment();
  const DEFAULT_FONT_SIZE = 13;
  const MIN_FONT_SIZE = 9;
  const MAX_FONT_SIZE = 32;
  const FONT_SIZE_KEY = 'gmd:editor-font-size';
  let currentFontSize = DEFAULT_FONT_SIZE;
  try {
    const stored = localStorage.getItem(FONT_SIZE_KEY);
    if (stored) {
      const n = parseInt(stored, 10);
      if (!isNaN(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) currentFontSize = n;
    }
  } catch { /* noop */ }

  function makeFontSizeTheme(px: number) {
    // v0.2.2: scale by --app-zoom CSS variable (set on App-vscode.svelte's
    // <main class="shell">). Composition: per-pane editor font-size (Cmd+=
    // inside CM6) * app-level zoom (Cmd+= outside CM6, or +/- buttons).
    // Browser auto-recomputes when --app-zoom changes — no JS reconfigure
    // needed on app-zoom toggle. var() defaults to 1 in the web app where
    // --app-zoom is never set, so existing behavior there is unchanged.
    return EditorView.theme({
      '.cm-content': { fontSize: `calc(${px}px * var(--app-zoom, 1))` },
      '.cm-gutters': { fontSize: `calc(${px}px * var(--app-zoom, 1))` },
    });
  }

  function applyFontSize(vw: EditorView, px: number) {
    currentFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, px));
    try { localStorage.setItem(FONT_SIZE_KEY, String(currentFontSize)); } catch { /* noop */ }
    vw.dispatch({ effects: fontSizeCompartment.reconfigure(makeFontSizeTheme(currentFontSize)) });
  }

  function bumpFontSize(vw: EditorView, delta: number) {
    applyFontSize(vw, currentFontSize + delta);
  }

  function resetFontSize(vw: EditorView) {
    applyFontSize(vw, DEFAULT_FONT_SIZE);
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
  // v0.5.1 fix: ASCEND to enclosing shallower-level section. v0.5.0 fell
  // back to selectParentSyntax once bounds matched, which walks SIDEWAYS
  // to the next sibling block instead of UP to the parent section.
  function findEnclosingSectionBounds(state: EditorState, currentBounds: {from: number; to: number}): {from: number; to: number} | null {
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
    let curIdx = -1;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].from === currentBounds.from) { curIdx = i; break; }
    }
    if (curIdx < 0) return null;
    const curLevel = headings[curIdx].level;
    let parentIdx = -1;
    for (let i = curIdx - 1; i >= 0; i--) {
      if (headings[i].level < curLevel) { parentIdx = i; break; }
    }
    if (parentIdx < 0) return null;
    const start = headings[parentIdx].from;
    const lvl = headings[parentIdx].level;
    let end = state.doc.length;
    for (let i = parentIdx + 1; i < headings.length; i++) {
      if (headings[i].level <= lvl) { end = headings[i].from; break; }
    }
    return { from: start, to: end };
  }

  function selectParentOrSection(vw: EditorView): boolean {
    const state = vw.state;
    const before = state.selection.main;
    const bounds = findSectionBounds(state, before.head);

    // Selection already exactly equals the current section bounds:
    // ASCEND to the enclosing shallower-level section.
    if (bounds && before.from === bounds.from && before.to === bounds.to) {
      const parent = findEnclosingSectionBounds(state, bounds);
      if (parent) {
        vw.dispatch({
          selection: EditorSelection.single(parent.from, parent.to),
          scrollIntoView: true,
        });
        return true;
      }
      // No shallower heading → expand to whole document.
      if (before.from > 0 || before.to < state.doc.length) {
        vw.dispatch({
          selection: EditorSelection.single(0, state.doc.length),
          scrollIntoView: true,
        });
        return true;
      }
      return false;
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
        // v0.5.1: enable multi-cursor support. Cmd/Ctrl+D (selectNextOccurrence
        // from searchKeymap) now actually spawns additional cursors at next
        // match, and Alt/Opt+Left-click drops a cursor at the pointer position
        // (drawSelection handles the click natively when this flag is true).
        EditorState.allowMultipleSelections.of(true),
        highlightActiveLine(),
        highlightSelectionMatches({ minSelectionLength: 1, highlightWordAroundCursor: true }),
        search({ top: true }),
        // Theme + highlight (Compartment, swappable on per-pane toggle). The
        // returned Extension bundles the light/dark HighlightStyle plus the
        // defaultHighlightStyle fallback (covers fenced-code nested grammars
        // that emit tags our markdown style doesn't claim) plus editor chrome.
        themeCompartment.of(editorThemeExtensions(effectiveTheme)),
        wrapCompartment.of(wrapEnabled ? EditorView.lineWrapping : []),
        fontSizeCompartment.of(makeFontSizeTheme(currentFontSize)),
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
          mousedown: (event, vw) => {
            // v0.5.2: Alt/Opt+Left-click → add cursor at pointer position.
            // CodeMirror 6's built-in Alt+click multi-cursor (gated on
            // EditorState.allowMultipleSelections, enabled in v0.5.1) does NOT
            // fire on Firefox/macOS — Firefox intercepts Option+click for its
            // own purposes (word-select drag, accessibility shortcut). Bypass
            // by handling mousedown at the DOM level and dispatching the
            // cursor-add transaction ourselves. Works uniformly across
            // Chromium / Firefox / WebKit on Mac + Linux + Windows.
            //
            // Modifier policy: ONLY plain Alt+Left-click. Reject if Shift/Ctrl/Meta
            // also held — those are reserved for native CM6 chords (Shift+click =
            // extend selection, Meta+click on macOS = native, etc).
            if (event.button !== 0) return false;
            if (!event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return false;
            const pos = vw.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            event.preventDefault();
            const existing = vw.state.selection;
            const newCursor = EditorSelection.cursor(pos);
            // Append the new range and make it primary (VS Code parity:
            // typing happens at the most-recently-added cursor).
            vw.dispatch({
              selection: EditorSelection.create(
                [...existing.ranges, newCursor],
                existing.ranges.length,
              ),
            });
            return true;
          },
          keydown: (event, vw) => {
            if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyZ') {
              event.preventDefault();
              toggleWrap(vw);
              return true;
            }
            // v0.6.6: editor-pane font-size shortcuts. Intercept at the DOM
            // level BEFORE the browser's native Cmd+= / Cmd+- zoom fires.
            // event.code is layout-independent ('Equal' / 'Minus' / 'Digit0'),
            // so this works whether the user is on Mac (metaKey) or Win/Linux
            // (ctrlKey). Shift is tolerated because most Mac keyboards send
            // Shift+Cmd+= for the literal '+' key character.
            const mod = event.metaKey || event.ctrlKey;
            if (mod && !event.altKey) {
              if (event.code === 'Equal') {
                event.preventDefault();
                bumpFontSize(vw, +1);
                return true;
              }
              if (event.code === 'Minus') {
                event.preventDefault();
                bumpFontSize(vw, -1);
                return true;
              }
              if (event.code === 'Digit0') {
                event.preventDefault();
                resetFontSize(vw);
                return true;
              }
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
          // v0.6.6: editor-pane font size. Belt-and-suspenders with the DOM
          // keydown intercept above (DOM handler catches browser-zoom first;
          // keymap entries here are the idiomatic CM6 fallback).
          { key: 'Mod-=', preventDefault: true, run: (vw) => { bumpFontSize(vw, +1); return true; } },
          { key: 'Mod-Equal', preventDefault: true, run: (vw) => { bumpFontSize(vw, +1); return true; } },
          { key: 'Mod--', preventDefault: true, run: (vw) => { bumpFontSize(vw, -1); return true; } },
          { key: 'Mod-Minus', preventDefault: true, run: (vw) => { bumpFontSize(vw, -1); return true; } },
          { key: 'Mod-0', preventDefault: true, run: (vw) => { resetFontSize(vw); return true; } },
          { key: 'Mod-Shift-ArrowRight', preventDefault: true, run: selectParentOrSection },
          // v0.5.1: literal Ctrl variant for Mac users with VS Code muscle
          // memory who reach for Ctrl+Shift+→ rather than Cmd+Shift+→.
          { key: 'Ctrl-Shift-ArrowRight', preventDefault: true, run: selectParentOrSection },
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
          '&': { height: '100%' },
          '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' },
          '.cm-panels': { backgroundColor: 'transparent', border: 'none' },
          '.cm-panels.cm-panels-top': { borderBottom: 'none' },
          // Layout-only rules for search panel — colors live in editor-theme.ts
          // (light/dark variant), Compartment-swapped per pane theme.
          '.cm-panel.cm-search': {
            position: 'absolute',
            top: '8px',
            right: '24px',
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

  // v0.7.0: hot-swap editor theme on per-pane toggle. The Compartment was
  // configured at editor creation — reconfiguring it dispatches the new
  // syntaxHighlighting + EditorView.theme bundle without rebuilding state.
  $effect(() => {
    const t = effectiveTheme;
    if (!localView) return;
    localView.dispatch({
      effects: themeCompartment.reconfigure(editorThemeExtensions(t)),
    });
  });
</script>

<div class="editor-container theme-{effectiveTheme}">
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
  {#if onThemeToggle}
    <div class="theme-toggle-slot">
      {#if onZoomOut}
        <button type="button" class="control-btn" onclick={onZoomOut} title="Zoom out (Cmd+−)" aria-label="Zoom out">−</button>
      {/if}
      {#if onZoomIn}
        <button type="button" class="control-btn" onclick={onZoomIn} title="Zoom in (Cmd+=)" aria-label="Zoom in">+</button>
      {/if}
      <ThemeToggle choice={themeChoice} onclick={onThemeToggle} pane="Editor" />
    </div>
  {/if}
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

  /* v0.5.1: scrollbar gutter widened 12 -> 18px so highlight ticks read at a
     glance — the previous 12px / 8px-tick combo was visible only when squinting. */
  .editor-tick-rail {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 18px;
    pointer-events: none;
    z-index: 5;
  }
  .editor-tick-rail .tick {
    position: absolute;
    right: 2px;
    width: 14px;
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
    width: 16px;
    right: 1px;
  }

  /* v0.7.0: search-panel theming moved to editor-theme.ts Compartment;
     no more prefers-color-scheme @media here. Per-pane toggle won the
     OS-pref override race. */

  /* Theme toggle docked top-right of pane, above tick rail (z:5) and the
     CM search panel (z:15 when open). The toggle is z:20 so it stays
     reachable even with search open; gap from the right edge clears the
     18px tick gutter. */
  .theme-toggle-slot {
    position: absolute;
    top: 6px;
    right: 24px;
    z-index: 20;
    display: flex;
    gap: 4px;
    align-items: center;
  }

  /* v0.2.1: zoom +/- buttons docked next to the theme toggle. Matches
     ThemeToggle.svelte chrome (24px square, rounded, blur bg, theme-dark
     variant). Optional onZoomIn/onZoomOut props -> buttons hidden in web app. */
  .control-btn {
    width: 24px;
    height: 24px;
    border: 1px solid rgba(208, 215, 222, 0.7);
    background: rgba(246, 248, 250, 0.86);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-radius: 4px;
    cursor: pointer;
    color: #1f2328;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font: 600 14px/1 system-ui, -apple-system, sans-serif;
  }
  .control-btn:hover { background: rgba(208, 215, 222, 0.7); }
  :global(.theme-dark) .control-btn {
    background: rgba(22, 27, 34, 0.86);
    border-color: rgba(48, 54, 61, 0.7);
    color: #c9d1d9;
  }
  :global(.theme-dark) .control-btn:hover {
    background: rgba(48, 54, 61, 0.8);
  }
</style>
