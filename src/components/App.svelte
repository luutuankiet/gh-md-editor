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
  // outlineSplitterPct is the splitter's position from the LEFT of the shell, as a %.
  // The outline pane sits to the RIGHT of the splitter, so its width = 100 - outlineSplitterPct.
  // Dragging the splitter LEFT → outlineSplitterPct decreases → outline grows.
  let outlineSplitterPct = $state(80);
  let editorView: EditorView | null = $state(null);
  let previewHost: HTMLElement | null = $state(null);

  let outline = $derived<OutlineNode[]>(extractOutline(doc));
  let activeHeadingLine = $state(0);
  let editorTopLine = $state(1);

  // Breadcrumb = the path of headings (root -> deepest) whose .line <= editorTopLine.
  // At each level we pick the LAST heading (closest to topLine) and recurse into its children.
  function computeBreadcrumb(roots: OutlineNode[], topLine: number): OutlineNode[] {
    const out: OutlineNode[] = [];
    let level = roots;
    while (true) {
      let best: OutlineNode | null = null;
      for (const n of level) {
        if (n.line <= topLine && (!best || n.line > best.line)) best = n;
      }
      if (!best) break;
      out.push(best);
      level = best.children;
    }
    return out;
  }

  // Hide breadcrumb at very top of document — the first heading is already visible, no point
  // showing it duplicated. Once user scrolls past line 1, breadcrumb becomes useful context.
  let editorBreadcrumb = $derived<OutlineNode[]>(
    editorTopLine > 1 ? computeBreadcrumb(outline, editorTopLine) : []
  );

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
  // previewHost = the <div.preview-wrap> scrolling container (fixed in v0.2.1 —
  // was previously the inner <article> which doesn't scroll, so scroll events
  // never fired and the active heading was stuck on the first one).
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
      '- Outline sidebar on the **right** with preview-viewport tracking (done)',
      '- Per-pane search (Phase 4)',
      '',
      '## Outline sidebar',
      '',
      'The **right** panel tracks the heading currently visible at the top of the preview.',
      'Click any row to jump both panes there — the full row is the click target, and if the row has children it also toggles fold/unfold.',
      'Press `−` / `+` while the outline is focused to fold or unfold the whole tree.',
      '',
      '### Heading hierarchy',
      '',
      'Levels render with `H1` through `H8`. Markdown standard caps at H6, but the outline extractor sweeps the source for deeper levels.',
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
      '- **Editor → Preview:** `Cmd` / `Ctrl` + click any line in the editor. The matching preview block flashes and scrolls into view.',
      '- **Preview → Editor:** right-click or double-click any preview block to jump the editor caret there.',
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
      '| 3: Outline (right side, viewport-follow, full-row click) | done |',
      '',
      '> Edit me. Refresh the page. Your changes persist.',
      '',
      '## Long-section stress test',
      '',
      'Below are intentionally many short paragraphs so you can scroll deep into the preview and watch the outline highlight follow your viewport down through the lower headings (regression test for the v0.2.1 fix to the scroll listener target).',
      '',
      'Paragraph one for the long-section test. Paragraph one for the long-section test. Paragraph one for the long-section test. Paragraph one for the long-section test.',
      '',
      'Paragraph two for the long-section test. Paragraph two for the long-section test. Paragraph two for the long-section test. Paragraph two for the long-section test.',
      '',
      'Paragraph three for the long-section test. Paragraph three for the long-section test. Paragraph three for the long-section test. Paragraph three for the long-section test.',
      '',
      'Paragraph four for the long-section test. Paragraph four for the long-section test. Paragraph four for the long-section test. Paragraph four for the long-section test.',
      '',
      '## Final heading',
      '',
      'When you scroll the preview all the way to here, the outline should highlight **Final heading** on the right.',
      '',
    ].join('\n');
  }
</script>

<main class="shell">
  <div class="editor-preview">
    <div class="pane editor-pane" style="flex-basis: {splitPct}%;">
      {#if editorBreadcrumb.length > 0}
        <div class="editor-breadcrumb">
          {#each editorBreadcrumb as item, i (item.line)}
            {#if i > 0}<span class="separator" aria-hidden="true">›</span>{/if}
            <button
              type="button"
              class="crumb level-{item.level}"
              onclick={() => handleOutlineJump(item.line)}
              title={`Jump to line ${item.line}`}
            >{item.text}</button>
          {/each}
        </div>
      {/if}
      <Editor
        bind:value={doc}
        bind:view={editorView}
        bind:topLine={editorTopLine}
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
  <Splitter bind:pct={outlineSplitterPct} />
  <div class="pane outline-host" style="flex-basis: {100 - outlineSplitterPct}%;">
    <Outline nodes={outline} activeLine={activeHeadingLine} onJump={handleOutlineJump} />
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
  .editor-pane {
    position: relative;
  }
  .editor-breadcrumb {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 5;
    padding: 4px 12px;
    background: rgba(246, 248, 250, 0.94);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid #d0d7de;
    display: flex;
    gap: 2px;
    align-items: center;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    font-size: 11px;
    color: #57606a;
    white-space: nowrap;
    height: 26px;
    box-sizing: border-box;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  .editor-breadcrumb .separator {
    color: #afb8c1;
    flex: 0 0 auto;
    padding: 0 1px;
  }
  .editor-breadcrumb .crumb {
    background: transparent;
    border: none;
    padding: 1px 5px;
    font: inherit;
    color: inherit;
    cursor: pointer;
    border-radius: 3px;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .editor-breadcrumb .crumb:hover {
    background: rgba(9, 105, 218, 0.08);
    color: #0969da;
  }
  @media (prefers-color-scheme: dark) {
    .editor-breadcrumb {
      background: rgba(13, 17, 23, 0.94);
      border-bottom-color: #30363d;
      color: #8b949e;
    }
    .editor-breadcrumb .separator { color: #484f58; }
    .editor-breadcrumb .crumb:hover {
      background: rgba(56, 139, 253, 0.12);
      color: #58a6ff;
    }
  }
</style>
