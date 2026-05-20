<script lang="ts">
  import { untrack } from 'svelte';
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
  import Splitter from './Splitter.svelte';
  import Outline from './Outline.svelte';
  import { parseMarkdown, extractOutline, type OutlineNode } from '../lib/markdown';
  import { loadDoc, saveDocDebounced } from '../lib/persistence';
  import { revealPreview, revealEditor } from '../lib/reveal';
  import { EditorView } from '@codemirror/view';

  let doc = $state(loadDoc() || sampleDoc());
  let html = $state(untrack(() => parseMarkdown(doc)));
  let splitPct = $state(50);
  let outlinePct = $state(20);
  let editorView: EditorView | null = $state(null);
  let previewHost: HTMLElement | null = $state(null);

  let outline = $derived<OutlineNode[]>(extractOutline(doc));
  let activeHeadingLine = $state(0);

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

  // Track which heading is currently scrolled to in the preview pane.
  // Re-runs whenever previewHost is mounted/unmounted; scroll + MutationObserver
  // keep activeHeadingLine fresh as user scrolls or content re-renders.
  $effect(() => {
    if (!previewHost) return;
    const ph = previewHost;

    const compute = () => {
      const flatLines: number[] = [];
      const flatten = (ns: OutlineNode[]) => {
        for (const n of ns) {
          flatLines.push(n.line);
          flatten(n.children);
        }
      };
      flatten(outline);

      if (flatLines.length === 0) {
        activeHeadingLine = 0;
        return;
      }
      const flatSet = new Set(flatLines);
      const hostRect = ph.getBoundingClientRect();
      const threshold = hostRect.top + 30;
      const all = ph.querySelectorAll<HTMLElement>('[data-source-line]');
      let active = 0;
      for (const el of all) {
        const ln = Number(el.dataset.sourceLine);
        if (!Number.isFinite(ln) || !flatSet.has(ln)) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= threshold) active = ln;
        else break;
      }
      activeHeadingLine = active || flatLines[0];
    };

    const onScroll = () => requestAnimationFrame(compute);
    ph.addEventListener('scroll', onScroll, { passive: true });

    let scheduleTimer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(scheduleTimer);
      scheduleTimer = setTimeout(compute, 100);
    };
    schedule();

    const mo = new MutationObserver(schedule);
    mo.observe(ph, { childList: true, subtree: true });

    return () => {
      clearTimeout(scheduleTimer);
      mo.disconnect();
      ph.removeEventListener('scroll', onScroll);
    };
  });

  function handleEditorReveal(line: number) {
    if (previewHost) revealPreview(previewHost, line);
  }

  function handlePreviewReveal(node: HTMLElement) {
    if (editorView) revealEditor(editorView, node);
  }

  function handleOutlineJump(line: number) {
    if (previewHost) revealPreview(previewHost, line);
    if (editorView) {
      const docState = editorView.state.doc;
      if (line >= 1 && line <= docState.lines) {
        const lineObj = docState.line(line);
        editorView.dispatch({
          selection: { anchor: lineObj.from },
          effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
        });
      }
    }
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
      '- Outline sidebar with **preview-viewport tracking** (done)',
      '- Per-pane search (Phase 4)',
      '',
      '## Outline sidebar',
      '',
      'The left panel tracks the heading currently visible at the top of the preview.',
      'Click any item to jump both panes there. Press `−` / `+` while the outline is focused to fold or unfold the whole tree.',
      '',
      '### Heading hierarchy',
      '',
      'Levels render with `H1` through `H8` (Markdown standard caps at H6, but the outline extractor sweeps the source for deeper levels).',
      '',
      '#### Deep nesting works',
      '',
      'Text wraps inside the main pane, but the outline never wraps — horizontal scroll only.',
      '',
      '##### Five levels deep',
      '',
      '###### Six levels deep',
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
      '| 3: Outline | done |',
      '',
      '> Edit me. Refresh the page. Your changes persist.',
      '',
    ].join('\n');
  }
</script>

<main class="shell">
  <div class="pane outline-host" style="flex-basis: {outlinePct}%;">
    <Outline nodes={outline} activeLine={activeHeadingLine} onJump={handleOutlineJump} />
  </div>
  <Splitter bind:pct={outlinePct} />
  <div class="editor-preview">
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
  .editor-preview {
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }
</style>
