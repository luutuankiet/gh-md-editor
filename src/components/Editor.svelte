<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
  import { indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
  import { highlightSelectionMatches, searchKeymap, search } from '@codemirror/search';
  import { markdown as markdownLang, markdownLanguage } from '@codemirror/lang-markdown';

  let {
    value = $bindable(''),
    view = $bindable<EditorView | null>(null),
    onRevealRequest,
  }: {
    value?: string;
    view?: EditorView | null;
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
        markdownLang({ base: markdownLanguage, addKeymap: true }),
        keymap.of([
          {
            key: 'Mod-Alt-r',
            preventDefault: true,
            run: (v) => {
              const pos = v.state.selection.main.head;
              const line = v.state.doc.lineAt(pos).number;
              onRevealRequest?.(line);
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
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

    return () => {
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
