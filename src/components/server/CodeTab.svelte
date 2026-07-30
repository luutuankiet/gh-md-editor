<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
  import { EditorState, Compartment } from '@codemirror/state';
  import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
  import {
    indentOnInput,
    bracketMatching,
    LanguageDescription,
    syntaxHighlighting,
    HighlightStyle,
    defaultHighlightStyle,
    codeFolding,
    foldGutter,
    foldKeymap,
    foldService,
  } from '@codemirror/language';
  import { indentFoldService } from '../../lib/fold-indent';
  import { TAB_DND_MIME, PATH_DND_MIME } from '../../lib/dnd';
  import { search, searchKeymap, getSearchQuery } from '@codemirror/search';
  import { indentationMarkers } from '@replit/codemirror-indentation-markers';
  import { wordHighlight, wordMatchRanges } from '../../lib/word-highlight';
  import { languages } from '@codemirror/language-data';
  import { tags as t } from '@lezer/highlight';

  let { value = $bindable(''), filename, reveal = null }: {
    value?: string;
    filename: string;
    // Search-result jump. `seq` is what makes a repeat click on the same line
    // fire again — a bare line number would compare equal and do nothing.
    reveal?: { line: number; seq: number } | null;
  } = $props();

  let host: HTMLDivElement;
  // $state so the reveal effect below re-runs once the view actually exists;
  // a plain let would leave a jump requested at open time silently dropped.
  let view = $state<EditorView | null>(null);

  const languageCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const wrapCompartment = new Compartment();

  // Word wrap: off by default for code (VS Code parity, and the point of the
  // horizontal scrollbar), toggled with Alt/Opt+Z. Its own storage key — the
  // markdown cockpit owns `gmd:wrap` and wants the opposite default.
  const WRAP_KEY = 'ghmd.codeWrap';
  let wrapEnabled = false;
  try { wrapEnabled = localStorage.getItem(WRAP_KEY) === 'on'; } catch { /* noop */ }

  function toggleWrap(vw: EditorView) {
    wrapEnabled = !wrapEnabled;
    try { localStorage.setItem(WRAP_KEY, wrapEnabled ? 'on' : 'off'); } catch { /* noop */ }
    vw.dispatch({ effects: wrapCompartment.reconfigure(wrapEnabled ? EditorView.lineWrapping : []) });
  }

  const PLAIN = 'plain text';
  const languageNames = [PLAIN, ...languages.map((l) => l.name).sort((a, b) => a.localeCompare(b))];
  let selectedLanguage = $state(PLAIN);

  // Minimal dark chrome — oneDark is not a dependency, and syntax colors for
  // lazily-loaded grammars come from the default highlight style anyway.
  const darkTheme = EditorView.theme({
    '&': { backgroundColor: '#0d1117', color: '#c9d1d9' },
    '.cm-gutters': { backgroundColor: '#0d1117', color: '#6e7681', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(110, 118, 129, 0.12)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(110, 118, 129, 0.12)' },
    '.cm-cursor': { borderLeftColor: '#c9d1d9' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(56, 139, 253, 0.3)',
    },
  }, { dark: true });
  const lightTheme = EditorView.theme({}, { dark: false });

  // GitHub-Dark token palette, matched to the #0d1117 chrome above. Without an
  // explicit syntaxHighlighting() extension CodeMirror parses but never paints
  // — basicSetup normally supplies one; this hand-rolled setup must too.
  const darkHighlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#ff7b72' },
    { tag: [t.string, t.special(t.string), t.regexp], color: '#a5d6ff' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: '#8b949e', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#d2a8ff' },
    { tag: [t.number, t.bool, t.atom, t.null, t.constant(t.variableName)], color: '#79c0ff' },
    { tag: [t.typeName, t.className, t.namespace], color: '#ffa657' },
    { tag: [t.propertyName, t.attributeName], color: '#79c0ff' },
    { tag: t.tagName, color: '#7ee787' },
    { tag: [t.definition(t.variableName), t.variableName], color: '#c9d1d9' },
    { tag: [t.meta, t.processingInstruction], color: '#8b949e' },
    { tag: t.heading, color: '#79c0ff', fontWeight: 'bold' },
    { tag: t.link, color: '#a5d6ff', textDecoration: 'underline' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.invalid, color: '#f85149' },
  ]);

  // Theme + matching token colors travel together through one compartment.
  const darkBundle = [darkTheme, syntaxHighlighting(darkHighlight)];
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
    const desc = languages.find((l) => l.name === name);
    if (!desc) return;
    const support = await desc.load();
    // Re-check the picker hasn't moved on while the grammar was loading.
    if (view && selectedLanguage === name) {
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    }
  }

  $effect(() => {
    if (!host) return;
    const initialDoc = untrack(() => value);

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
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
          colors: { light: '#d0d7de', dark: '#2f353d', activeLight: '#57606a', activeDark: '#8b949e' },
        }),
        search({ top: true }),
        wordHighlight,
        wrapCompartment.of(wrapEnabled ? EditorView.lineWrapping : []),
        languageCompartment.of([]),
        themeCompartment.of(untrack(() => isDark) ? darkBundle : lightBundle),
        // After the theme compartment on purpose: the syntax bundles ship their
        // own faint .cm-matchingBracket rule, and later extensions win. Click a
        // bracket and BOTH boundaries need to be obvious at a glance.
        EditorView.theme({
          '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
            backgroundColor: 'rgba(56, 139, 253, 0.32)',
            outline: '1px solid rgba(56, 139, 253, 0.9)',
            borderRadius: '2px',
          },
          '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
            backgroundColor: 'rgba(248, 81, 73, 0.25)',
            outline: '1px solid rgba(248, 81, 73, 0.9)',
            borderRadius: '2px',
          },
        }),
        // Alt/Opt+Z toggles wrap. Firefox on macOS delivers `Ω` as event.key
        // for Alt+Z, so a keymap entry alone never fires — match event.code at
        // the DOM level and keep the keymap entry as a backup.
        // drop/dragover: tab drags carry a custom MIME, but preventDefault here
        // guarantees CodeMirror never treats a tab drag as text insertion.
        EditorView.domEventHandlers({
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
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          { key: 'Alt-z', preventDefault: true, run: (vw) => { toggleWrap(vw); return true; } },
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
          '.cm-scroller': {
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            overflow: 'auto',
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

    // Ticks on container resize (splitter drag) + initial pass. `created` is
    // a local and the tick fns only write state — no tracked reads added.
    const ro = new ResizeObserver(() => recomputeTicks(created));
    ro.observe(created.scrollDOM);
    recomputeTicks(created);

    return () => {
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
    const detected = LanguageDescription.matchFilename(languages, name);
    untrack(() => {
      selectedLanguage = detected ? detected.name : PLAIN;
      void applyLanguage(selectedLanguage);
    });
  });

  $effect(() => {
    const r = reveal;
    const v = view;
    if (!r || !v) return;
    const doc = v.state.doc;
    const pos = doc.line(Math.min(Math.max(1, r.line), doc.lines)).from;
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
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
  <div class="code-host" bind:this={host}></div>
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
  <select
    class="lang-picker"
    bind:value={selectedLanguage}
    onchange={() => void applyLanguage(selectedLanguage)}
    title="Syntax language"
    aria-label="Syntax language"
  >
    {#each languageNames as name (name)}
      <option value={name}>{name}</option>
    {/each}
  </select>
</div>

<style>
  .code-container {
    position: relative;
    height: 100%;
    width: 100%;
    overflow: hidden;
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
  .editor-tick-rail .tick.word { background: rgba(56, 139, 253, 0.9); }
  .editor-tick-rail .tick.match { background: rgba(255, 195, 0, 0.85); }
  .editor-tick-rail .tick.current {
    background: #ff6b00;
    height: 4px;
    width: 22px;
    right: 1px;
  }
  .lang-picker {
    position: absolute;
    top: 6px;
    right: 30px;
    z-index: 20;
    font-size: 11px;
    padding: 2px 4px;
    border-radius: 4px;
    border: 1px solid rgba(48, 54, 61, 0.7);
    background: rgba(22, 27, 34, 0.9);
    color: #c9d1d9;
    max-width: 160px;
  }
</style>
