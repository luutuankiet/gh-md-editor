<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
  import { EditorState, Compartment } from '@codemirror/state';
  import { history, historyKeymap, defaultKeymap, indentWithTab, selectParentSyntax } from '@codemirror/commands';
  import { indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
  import { highlightSelectionMatches, searchKeymap, search } from '@codemirror/search';
  import { markdown as markdownLang, markdownLanguage } from '@codemirror/lang-markdown';
  import { languages as codeLanguages } from '@codemirror/language-data';
  import { tags as t } from '@lezer/highlight';

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

  // ---------------------------------------------------------------------------
  // Distinct colour scheme for markdown source. Replaces CM6's defaultHighlight,
  // which collapses heading / strong / monospace to the same colour. Each header
  // level gets its own hue so the source pane is visually scannable.
  // ---------------------------------------------------------------------------
  const githubMarkdownHighlight = HighlightStyle.define([
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
  ]);

  // Compartment so Alt+Z can dynamically reconfigure line-wrapping at runtime.
  const wrapCompartment = new Compartment();
  // Closure-local toggle state. Persisted to localStorage so the next reload
  // honours the user's preference. Not a Svelte $state because the only reader
  // is the keymap callback below.
  let wrapEnabled = true;
  try { wrapEnabled = localStorage.getItem('gmd:wrap') !== 'off'; } catch { /* noop */ }

  // Markdown auto-pair: when the user types `, *, _, ~, (, [, {, ", ' over a
  // non-empty selection, wrap the selection with the matching closer instead
  // of replacing it (VS Code parity). For empty selections the keystroke
  // falls through to the default input handler, so single-char typing works
  // as normal.
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
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(githubMarkdownHighlight, { fallback: true }),
        wrapCompartment.of(wrapEnabled ? EditorView.lineWrapping : []),
        // codeLanguages: language-data ships LanguageDescription[] for ~100 languages,
        // each loading its CodeMirror grammar package on demand.
        markdownLang({ base: markdownLanguage, addKeymap: true, codeLanguages }),
        markdownAutoPair,
        keymap.of([
          // App-level shortcuts FIRST so they shadow any default conflicts.
          {
            key: 'Alt-z',
            preventDefault: true,
            run: (vw) => {
              wrapEnabled = !wrapEnabled;
              try { localStorage.setItem('gmd:wrap', wrapEnabled ? 'on' : 'off'); } catch { /* noop */ }
              vw.dispatch({
                effects: wrapCompartment.reconfigure(wrapEnabled ? EditorView.lineWrapping : []),
              });
              return true;
            },
          },
          // VS Code parity: Cmd/Ctrl+Shift+→ grows the selection to the
          // enclosing syntax node (markdown block, code-fence, list item, etc.).
          // selectParentSyntax is exported by @codemirror/commands.
          { key: 'Mod-Shift-ArrowRight', preventDefault: true, run: selectParentSyntax },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        // Right-click reveals the matching block in the preview. Replaces the
        // previous Cmd/Ctrl+click handler (Firefox steals Ctrl-click for tab
        // shortcuts on some platforms; right-click is now symmetric with the
        // preview pane which also uses right-click).
        EditorView.domEventHandlers({
          contextmenu: (event, vw) => {
            const pos = vw.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            event.preventDefault();
            const line = vw.state.doc.lineAt(pos).number;
            onRevealRequest?.(line);
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            value = u.state.doc.toString();
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' },
          // ----- VS Code-style find widget --------------------------------
          '.cm-panels': { backgroundColor: 'transparent', border: 'none' },
          '.cm-panels.cm-panels-top': { borderBottom: 'none' },
          '.cm-panel.cm-search': {
            position: 'absolute',
            top: '8px',
            right: '16px',
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

    // Track topmost-visible doc line for the sticky-header stack in App.svelte.
    // CM6's updateListener doesn't fire on pure scroll, so we listen on scrollDOM.
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

    return () => {
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

<div class="editor-host" bind:this={host}></div>

<style>
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
