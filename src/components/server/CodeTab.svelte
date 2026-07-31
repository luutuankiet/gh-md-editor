<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
  import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
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
  } from '@codemirror/language';
  import { indentFoldService } from '../../lib/fold-indent';
  import { TAB_DND_MIME, PATH_DND_MIME } from '../../lib/dnd';
  import { search, searchKeymap, getSearchQuery, searchPanelOpen } from '@codemirror/search';
  import { indentationMarkers } from '@replit/codemirror-indentation-markers';
  import { wordHighlight, wordMatchRanges } from '../../lib/word-highlight';
  import { languages } from '@codemirror/language-data';
  import { monokaiCodeBundle } from '../../lib/monokai-dimmed';

  import { outlineFromState } from '../../lib/code-outline';
  import { dotenvLanguage } from '../../lib/lang-dotenv';
  import { expandSelection, shrinkSelection, resetSelectionHistory } from '../../lib/expand-selection';
  import { formatDocumentText } from '../../lib/format-doc';

  // One list, three consumers: the picker's name list, the picker's lookup,
  // and filename auto-detection. Anything appended here has to be visible to
  // all three or the picker and the detector disagree about what exists.
  const LANGS = [dotenvLanguage, ...languages];

  let { value = $bindable(''), filename, reveal = null }: {
    value?: string;
    filename: string;
    // Search-result jump. `seq` is what makes a repeat click on the same line
    // fire again — a bare line number would compare equal and do nothing.
    // `select` carries a range to highlight instead of just placing the cursor,
    // which is how an outline double-click selects a whole declaration.
    reveal?: { line: number; seq: number; select?: { from: number; to: number } } | null;
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
      window.dispatchEvent(new CustomEvent('gmd:outline', {
        detail: { name: filename, nodes: outlineFromState(vw.state) },
      }));
    }, 200);
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
          colors: { light: '#d0d7de', dark: '#3c3c3c', activeLight: '#606060', activeDark: '#949494' },
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
            backgroundColor: 'rgba(229, 133, 32, 0.35)',
            outline: '1px solid rgba(84, 122, 255, 0.9)',
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
    const detected = LanguageDescription.matchFilename(LANGS, name);
    untrack(() => {
      selectedLanguage = detected ? detected.name : PLAIN;
      void applyLanguage(selectedLanguage).then(() => {
        const vw = view;
        if (vw) pushOutline(vw);
      });
    });
  });

  $effect(() => {
    const r = reveal;
    const v = view;
    if (!r || !v) return;
    const doc = v.state.doc;
    const pos = doc.line(Math.min(Math.max(1, r.line), doc.lines)).from;
    if (r.select) {
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
    class:hidden={searchOpen}
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
{#if notice}
  <div class="notice">{notice}</div>
{/if}

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
    position: absolute;
    top: 6px;
    right: 30px;
    z-index: 20;
    font-size: 11px;
    padding: 2px 4px;
    border-radius: 4px;
    border: 1px solid rgba(64, 64, 64, 0.7);
    background: rgba(39, 39, 39, 0.9);
    color: #c5c8c6;
    max-width: 160px;
  }
  /* The find box claims the same corner — yield to it, come back on Escape. */
  .lang-picker.hidden {
    display: none;
  }
</style>
