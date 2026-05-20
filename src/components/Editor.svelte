<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
  import { indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
  import { highlightSelectionMatches, searchKeymap, search } from '@codemirror/search';
  import { markdown as markdownLang, markdownLanguage } from '@codemirror/lang-markdown';
  import { languages as codeLanguages } from '@codemirror/language-data';

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
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        // codeLanguages: language-data ships LanguageDescription[] for ~100 languages,
        // each loading its CodeMirror grammar package on demand. Fenced ```sql / ```ts / ```py /
        // etc. now get syntactic colouring inside the editor pane.
        markdownLang({ base: markdownLanguage, addKeymap: true, codeLanguages }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        // Cmd/Ctrl + click on a line → reveal the matching block in the preview.
        // Swapped from a Mod-Alt-r keymap because Firefox hijacks that shortcut ("Send Tab to Device").
        // Plain click (no modifier) keeps default cursor placement; Alt/Shift modifiers also pass through
        // so they don't conflict with future rectangular-select / extend-selection extensions.
        EditorView.domEventHandlers({
          mousedown: (event, view) => {
            if (!(event.metaKey || event.ctrlKey)) return false;
            if (event.altKey || event.shiftKey) return false;
            if (event.button !== 0) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const line = view.state.doc.lineAt(pos).number;
            onRevealRequest?.(line);
            return false;
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
        }),
      ],
    });

    localView = new EditorView({ state, parent: host });
    view = localView;

    // Track topmost-visible line for the sticky breadcrumb. CM6's updateListener does NOT
    // fire on pure scroll, so we listen on scrollDOM directly. posAtCoords at the top edge
    // of the visible viewport gives us the doc offset, which lineAt resolves to a line number.
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
</style>
