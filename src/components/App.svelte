<script lang="ts">
  import { untrack } from 'svelte';
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
  import Splitter from './Splitter.svelte';
  import Outline from './Outline.svelte';
  import ShortcutsDialog from './ShortcutsDialog.svelte';
  import { parseMarkdown, extractOutline, type OutlineNode } from '../lib/markdown';
  import { loadDoc, saveDocDebounced } from '../lib/persistence';
  import { revealPreview, revealEditor } from '../lib/reveal';
  import { EditorView } from '@codemirror/view';

  let doc = $state(loadDoc() || sampleDoc());
  let html = $state(untrack(() => parseMarkdown(doc)));
  let splitPct = $state(50);
  // outlineSplitterPct = splitter position from LEFT of shell, %. Outline pane is
  // RIGHT of splitter, so its width = 100 - outlineSplitterPct.
  let outlineSplitterPct = $state(80);
  let editorView: EditorView | null = $state(null);
  let previewHost: HTMLElement | null = $state(null);
  let showShortcuts = $state(false);

  let outline = $derived<OutlineNode[]>(extractOutline(doc));
  let activeHeadingLine = $state(0);
  let editorTopLine = $state(1);

  // Path of headings (root -> deepest) whose .line <= editorTopLine.
  // At each level pick the LAST heading (closest to topLine) and recurse.
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

  // Hide sticky-header stack at the very top of the document — the first
  // heading is already visible, no point duplicating it.
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

  // Track which heading is currently visible at the top of the preview pane.
  // CRITICAL bug fix in v0.4.0: skip elements whose `offsetParent === null` —
  // those are inside closed <details> (display:none). Their getBoundingClientRect()
  // returns zeros, which the previous code interpreted as 'above threshold' and
  // set as active, causing the outline highlight to wrongly jump to headings
  // inside collapsed sections while the user had actually scrolled past them.
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
        // Skip headings inside closed <details>. offsetParent is null when
        // an ancestor has display:none, which is exactly what closed <details>
        // does to its non-summary children. Their bounding rect would be (0,0)
        // and falsely satisfy top <= threshold.
        if (el.offsetParent === null) continue;
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

    // Observe the article's DIRECT children (not the whole subtree). subtree:true
    // used to fire hundreds of mutation records per morphdom diff (one per
    // text-node tweak inside a code block or SVG); childList on the article is
    // enough since every heading we care about is a top-level child.
    const article = ph.querySelector<HTMLElement>('article.markdown-body') ?? ph;
    const mo = new MutationObserver(schedule);
    mo.observe(article, { childList: true });

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
      '- **Bold**, *italic*, `inline code` — each rendered in a distinct colour in the editor pane',
      '- Sticky-scroll header stack at the top of the editor (VS Code style)',
      '- GitHub-style alerts (Note / Tip / Important / Warning / Caution)',
      '- Mermaid diagrams + starry-night syntax highlighting in fenced code blocks',
      '- Reveal counterpart: right-click on EITHER side to flash the matching block on the other',
      '- Outline sidebar tracks the heading at the top of the preview viewport',
      '- Press `?` (outline focused) or click the `?` button in the outline header for shortcuts',
      '',
      '> [!NOTE]',
      '> Useful information that users should know, even when skimming.',
      '',
      '> [!TIP]',
      '> Helpful advice for doing things better or more easily.',
      '',
      '> [!IMPORTANT]',
      '> Key information users need to know to achieve their goal.',
      '',
      '> [!WARNING]',
      '> Urgent info that needs immediate user attention to avoid problems.',
      '',
      '> [!CAUTION]',
      '> Advises about risks or negative outcomes of certain actions.',
      '',
      '## Collapsible section (regression test)',
      '',
      '<details>',
      '<summary>Click to expand — try right-clicking the editor on a line inside</summary>',
      '',
      '### Hidden heading 1',
      '',
      'Paragraph inside the collapsed block. Right-clicking a corresponding line in the editor',
      'now auto-expands the section and flashes the block. The outline highlight no longer',
      'jumps to these hidden headings when the user has scrolled past them.',
      '',
      '### Hidden heading 2',
      '',
      'Another paragraph inside the details.',
      '',
      '</details>',
      '',
      '## Auto-pairs',
      '',
      'Select any text and type `` ` ``, `*`, `_`, `~`, `(`, `[`, `{`, `"` or `\'` to wrap',
      'the selection. `Cmd/Ctrl + Shift + →` expands the selection to the enclosing syntax node.',
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
      '  B --> C[Morph DOM]',
      '  C --> D[Render]',
      '  D --> A',
      '```',
      '',
      '## Table',
      '',
      '| Phase | Status |',
      '|---|---|',
      '| MVP | done |',
      '| Outline | done |',
      '| Sticky scroll, alerts, autopairs, morph-diff flicker fix | this turn |',
      '',
      '> Edit me. Your changes persist in localStorage.',
      '',
    ].join('\n');
  }
</script>

<main class="shell">
  <div class="editor-preview">
    <div class="pane editor-pane" style="flex-basis: {splitPct}%;">
      {#if editorBreadcrumb.length > 0}
        <div class="sticky-headers" aria-hidden="false">
          {#each editorBreadcrumb as item, i (item.line)}
            <button
              type="button"
              class="sticky-header level-{item.level}"
              style="top: {i * 22}px; z-index: {20 - i}"
              onclick={() => handleOutlineJump(item.line)}
              title={`Jump to line ${item.line}`}
            >{'#'.repeat(item.level)} {item.text}</button>
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
    <Outline
      nodes={outline}
      activeLine={activeHeadingLine}
      onJump={handleOutlineJump}
      onHelp={() => (showShortcuts = true)}
    />
  </div>
</main>

<ShortcutsDialog bind:open={showShortcuts} />

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
  /* Sticky-header stack: one absolute row per breadcrumb level, cascading 22px each.
     Each row is translucent + blurred so the editor content underneath stays dimly
     visible (VS Code parity). The wrapper is pointer-events:none so the EMPTY space
     between rows passes clicks through to the editor; individual rows re-enable it. */
  .sticky-headers {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    pointer-events: none;
  }
  .sticky-header {
    position: absolute;
    left: 0;
    right: 0;
    height: 22px;
    pointer-events: auto;
    background: rgba(246, 248, 250, 0.86);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-top: none;
    border-left: none;
    border-right: none;
    border-bottom: 1px solid rgba(208, 215, 222, 0.5);
    padding: 0 12px;
    display: flex;
    align-items: center;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    line-height: 22px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    text-align: left;
    width: 100%;
    box-sizing: border-box;
  }
  .sticky-header:hover { background: rgba(9, 105, 218, 0.10); }
  .sticky-header.level-1 { color: #cf222e; font-weight: 700; }
  .sticky-header.level-2 { color: #0550ae; font-weight: 700; }
  .sticky-header.level-3 { color: #6639ba; font-weight: 600; }
  .sticky-header.level-4 { color: #953800; font-weight: 600; }
  .sticky-header.level-5 { color: #0a3069; font-weight: 500; }
  .sticky-header.level-6,
  .sticky-header.level-7,
  .sticky-header.level-8 { color: #1f2328; font-weight: 500; }
  @media (prefers-color-scheme: dark) {
    .sticky-header {
      background: rgba(13, 17, 23, 0.86);
      border-bottom-color: rgba(48, 54, 61, 0.5);
    }
    .sticky-header:hover { background: rgba(56, 139, 253, 0.12); }
    .sticky-header.level-1 { color: #ff7b72; }
    .sticky-header.level-2 { color: #79c0ff; }
    .sticky-header.level-3 { color: #d2a8ff; }
    .sticky-header.level-4 { color: #ffa657; }
    .sticky-header.level-5 { color: #a5d6ff; }
    .sticky-header.level-6,
    .sticky-header.level-7,
    .sticky-header.level-8 { color: #c9d1d9; }
  }
</style>
