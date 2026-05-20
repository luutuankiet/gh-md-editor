<script lang="ts">
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
  import Splitter from './Splitter.svelte';
  import { parseMarkdown } from '../lib/markdown';
  import { loadDoc, saveDocDebounced } from '../lib/persistence';
  import { revealPreview, revealEditor } from '../lib/reveal';
  import type { EditorView } from '@codemirror/view';

  let doc = $state(loadDoc() || sampleDoc());
  let html = $state(parseMarkdown(doc));
  let splitPct = $state(50);
  let editorView: EditorView | null = $state(null);
  let previewHost: HTMLElement | null = $state(null);

  let parseTimer: ReturnType<typeof setTimeout> | null = null;
  let firstRun = true;
  $effect(() => {
    const current = doc;
    if (firstRun) {
      firstRun = false;
      return;
    }
    if (parseTimer) clearTimeout(parseTimer);
    parseTimer = setTimeout(() => {
      html = parseMarkdown(current);
    }, 80);
    return () => {
      if (parseTimer) clearTimeout(parseTimer);
    };
  });

  $effect(() => {
    saveDocDebounced(doc);
  });

  function handleEditorReveal(line: number) {
    if (previewHost) revealPreview(previewHost, line);
  }

  function handlePreviewReveal(node: HTMLElement) {
    if (editorView) revealEditor(editorView, node);
  }

  function sampleDoc(): string {
    return [
      '# gh-md-editor',
      '',
      'A GitHub-flavored markdown editor with live side-by-side preview.',
      '',
      '## Features',
      '',
      '- **Bold** and *italic* and `inline code`',
      '- Lists, tables, blockquotes',
      '- Mermaid diagrams (done)',
      '- Reveal-counterpart commands (done)',
      '- Outline sidebar (Phase 3)',
      '- Per-pane search (Phase 4)',
      '',
      '## Reveal counterpart',
      '',
      'Press **Cmd/Ctrl + Alt + R** in the editor to flash the matching preview block.',
      'Right-click or double-click any preview block to jump the editor caret there.',
      '',
      '## Code',
      '',
      '```ts',
      'function hello(name: string) {',
      '  console.log(`Hello, ${name}!`);',
      '}',
      '```',
      '',
      '## Diagram',
      '',
      '```mermaid',
      'graph LR',
      '  A[Edit] --> B[Parse]',
      '  B --> C[Render]',
      '  C --> D[Reveal]',
      '  D --> A',
      '```',
      '',
      '## Table',
      '',
      '| Phase | Status |',
      '|---|---|',
      '| 1: Skeleton | done |',
      '| 2: Reveal + Mermaid | done |',
      '| 3: Outline | next |',
      '',
      '> Edit me. Refresh the page. Your changes persist.',
      '',
    ].join('\n');
  }
</script>

<main class="shell">
  <div class="pane" style="flex-basis: {splitPct}%;">
    <Editor
      bind:value={doc}
      bind:view={editorView}
      onRevealRequest={handleEditorReveal}
    />
  </div>
  <Splitter bind:pct={splitPct} />
  <div class="pane" style="flex-basis: {100 - splitPct}%;">
    <Preview
      {html}
      bind:host={previewHost}
      onRevealRequest={handlePreviewReveal}
    />
  </div>
</main>

<style>
  .shell {
    display: flex;
    flex-direction: row;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .pane {
    flex-grow: 0;
    flex-shrink: 0;
    height: 100%;
    overflow: hidden;
    min-width: 0;
  }
</style>
