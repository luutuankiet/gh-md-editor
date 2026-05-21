<script lang="ts">
  import { untrack } from 'svelte';
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
  import Splitter from './Splitter.svelte';
  import Outline from './Outline.svelte';
  import ShortcutsDialog from './ShortcutsDialog.svelte';
  import { parseMarkdown, extractOutline, type OutlineNode } from '../lib/markdown';
  import { loadDoc, saveDocDebounced, clearDoc } from '../lib/persistence';
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
  // v0.5.1: track preview scrollTop so we can hide the sticky stack when the
  // user is at the very top (parity with editor's `topLine > 1` suppression).
  let previewScrollTop = $state(0);

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

  // v0.5.1: preview pane gets the same sticky-header treatment. Drives off
  // activeHeadingLine (already tracked via the existing scroll listener) and
  // hides when scrolled near the top.
  let previewBreadcrumb = $derived<OutlineNode[]>(
    previewScrollTop > 20 && activeHeadingLine > 0
      ? computeBreadcrumb(outline, activeHeadingLine)
      : []
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

    const onScroll = () => {
      previewScrollTop = ph.scrollTop;
      requestAnimationFrame(compute);
    };
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
    //
    // We ALSO subtree-watch the `open` attribute on <details>: when the user
    // expands a previously-collapsed section, headings inside flip from
    // offsetParent === null to visible, so the active-heading calculation
    // needs to re-run. attributeFilter:['open'] keeps the mutation traffic
    // bounded — only user clicks on <summary> fire it; morphdom doesn't
    // touch `open` because Preview.svelte's onBeforeElUpdated aligns it first.
    const article = ph.querySelector<HTMLElement>('article.markdown-body') ?? ph;
    const mo = new MutationObserver(schedule);
    mo.observe(article, {
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
      subtree: true,
    });

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
      '# gh-md-editor — markdown that follows you',
      '',
      'A side-by-side markdown editor with the one thing every other side-by-side',
      'markdown editor refuses to do: **never lose your place when switching panes**.',
      '',
      '**Why this exists.** Writing markdown blind in a plain textarea is a guessing',
      'game (does that table align? is that actually a heading?). Writing in WYSIWYG',
      'locks you out of your own source. This sits in the middle: every keystroke',
      'renders next to its source, and the outline + sticky breadcrumb keep you',
      'oriented in long documents.',
      '',
      '**Drive it like VS Code.** `Cmd/Ctrl+F` finds in either pane, `Cmd/Ctrl+Shift+→`',
      'grows the selection, **right-click in either pane jumps the other** (the novel',
      'feature this editor exists for). `Cmd+D` spawns a cursor at the next match;',
      '`Alt+Click` drops one wherever you point. Full shortcut sheet behind the `?`',
      'in the outline header — the **VS Code** badges flag muscle-memory bindings.',
      '',
      '**What it is NOT.** No collaboration, no cloud sync, no account. Your draft',
      'lives in this browser localStorage. Refresh — still here. Close the laptop —',
      'still here when you come back. Append `?reset=1` to the URL to restore THIS',
      'sample doc at any time.',
      '',
      '---',
      '',
      '## Try these first',
      '',
      '1. **Right-click any line in the editor** → preview flashes the matching block (auto-expanding `<details>` if needed). Then right-click any paragraph in the preview → editor caret jumps. THIS is the feature this app exists for.',
      '2. Press `Cmd/Ctrl+F` in either pane → search overlay opens. The **preview** one is the VS Code muscle-memory port via the CSS Custom Highlight API.',
      '3. Click any word in the preview → matching occurrences light up faintly, both inline and on the scrollbar (now an 18px gutter, visible from across the room).',
      '4. Press `Cmd/Ctrl+Shift+→` repeatedly → selection grows: word → fence → MARKDOWN SECTION → ENCLOSING PARENT SECTION → document. Mac: `Ctrl+Shift+→` also bound.',
      '5. Select a word and press `Cmd/Ctrl+D` repeatedly → spawn cursors at every next match. Type once, type everywhere.',
      '6. Hold `Alt/Opt` and left-click anywhere → drop another cursor at the click point.',
      '7. Click the trash icon in the outline header (top-right) → wipes localStorage and reloads, restoring this tour.',
      '',
      '## Headings stack as you scroll — both panes',
      '',
      '> [!TIP]',
      '> Scroll either pane down a few headings. The top of the pane stacks',
      '> `# → ## → ###` translucently so you always see where you are. Click any sticky',
      '> row to jump back. **New in v0.5.1:** the preview pane gets the same treatment',
      '> — sticky breadcrumb mirrors what the editor pane has always done.',
      '',
      '### A nested third-level heading',
      '',
      '#### A fourth, for the road',
      '',
      '…and back to the top of the section.',
      '',
      '## Outline tracks what you read — and auto-expands',
      '',
      'The outline on the right highlights the heading you are currently scrolled to.',
      '**New in v0.5.1:** if that heading is inside a collapsed branch, the outline',
      'walks ancestors and auto-expands them so the active row stays visible. No more',
      'hunting collapsed parents to find where the highlight went.',
      '',
      '## Alerts, the GitHub way',
      '',
      'Five flavors — same syntax GitHub uses on issues and PRs.',
      '',
      '> [!NOTE]',
      '> A friendly aside. Useful but not urgent.',
      '',
      '> [!TIP]',
      '> A keyboard shortcut, or a better way to do something.',
      '',
      '> [!IMPORTANT]',
      '> Something the reader genuinely needs to know.',
      '',
      '> [!WARNING]',
      '> Something that can go wrong if ignored.',
      '',
      '> [!CAUTION]',
      '> Something that WILL go wrong. Stop and read.',
      '',
      '## Collapsible sections',
      '',
      '<details>',
      '<summary>Click to expand — try right-clicking on a line inside</summary>',
      '',
      'The load-bearing trick here: right-clicking an editor line that lives inside a',
      'closed `<details>` block makes the preview auto-open the block before scrolling',
      'to the target. No more "where did my reveal go?"',
      '',
      '### A heading hidden inside',
      '',
      'Nested headings inside a collapsed section stay correctly tracked — the outline',
      'on the right does NOT mark them as active while they are invisible.',
      '',
      '</details>',
      '',
      '## Diagrams (mermaid)',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Source markdown] --> B[parse]',
      '  B --> C[morphdom diff]',
      '  C --> D[Preview DOM]',
      '  D -.->|right-click| A',
      '```',
      '',
      'Source-content keying means edits elsewhere on the page never force the diagram',
      'to re-render. Only changes to THIS fenced block touch the SVG.',
      '',
      '## Fenced code, syntax-highlighted',
      '',
      'SQL — new in v0.5.0. The grammar was not loaded before, so SQL fences rendered',
      'as plain black text. Try it with Postgres, Snowflake, BigQuery:',
      '',
      '```sql',
      'WITH recent AS (',
      '  SELECT user_id, MAX(created_at) AS last_seen',
      '  FROM events',
      "  WHERE created_at > CURRENT_DATE - INTERVAL '30 days'",
      '  GROUP BY 1',
      ')',
      'SELECT u.id, u.email, r.last_seen',
      'FROM users u',
      'LEFT JOIN recent r ON r.user_id = u.id',
      'WHERE r.last_seen IS NULL;',
      '```',
      '',
      'TypeScript:',
      '',
      '```ts',
      'async function greet(name: string): Promise<void> {',
      '  const greeting = `Hello, ${name}!`;',
      '  console.log(greeting);',
      '}',
      '```',
      '',
      'Bash:',
      '',
      '```bash',
      'git log --oneline -10 | rg "feat:" | wc -l',
      '```',
      '',
      '## Tables — now flash by row',
      '',
      '| Feature | Editor pane | Preview pane |',
      '|---|---|---|',
      '| Right-click reveal | flashes matching block on the other side | flashes matching line in editor |',
      '| Search overlay (Cmd+F) | floating panel top-right (CodeMirror) | floating panel top-right (custom) |',
      '| Scrollbar match ticks | 18px gutter, yellow query / blue word-at-cursor | same shades, same gutter |',
      '| Click a word | grows selection via `Cmd+Shift+→` | implicit highlight (inline + scrollbar) |',
      '| Multi-cursor | `Cmd+D` at next match; `Alt+Click` at pointer | n/a — preview is read-only |',
      '| Sticky breadcrumb | yes | yes (new in v0.5.1) |',
      '',
      'Right-click any row above. v0.5.0 added per-row reveal; before, you got the',
      'whole table flashed instead of just the line you pointed at.',
      '',
      '## Auto-pairs',
      '',
      'Select any text in this paragraph and press `` ` ``, `*`, `_`, `(`, `[`, `{`, `"` or `\'`:',
      'the selection gets wrapped with the matching pair. Selecting "auto-pairs" above',
      'and pressing `` ` `` turns it into `` `auto-pairs` ``.',
      '',
      '## Selection growth, VS Code-style',
      '',
      'Put the cursor inside the SQL block earlier and press `Cmd/Ctrl+Shift+→`',
      'repeatedly:',
      '',
      '1. token → SQL identifier',
      '2. → expression',
      '3. → statement',
      '4. → whole fenced block',
      '5. → the WHOLE `## Fenced code…` section',
      '6. → the ENCLOSING parent section (`# gh-md-editor`)',
      '7. → the entire document',
      '',
      'Step 5 is the v0.5.0 fix (clamp to section). Step 6 is the v0.5.1 fix: after',
      'clamping, the NEXT press ascends to the enclosing parent section instead of',
      'walking sideways to the next sibling.',
      '',
      'Mac users: `Ctrl+Shift+→` works the same as `Cmd+Shift+→` — both bound.',
      '',
      '---',
      '',
      '> Your changes persist in localStorage. Refresh — they are still here. The',
      '> keyboard cheat-sheet lives behind the `?` in the outline header (top-right).',
      '> The **trash icon** next to it wipes the draft and restores this tour at any',
      '> time. `?reset=1` in the URL does the same thing.',
      '',
    ].join('\n');
  }
</script>

<main class="shell">
  <div class="editor-preview">
    <div
      class="pane editor-pane"
      style="flex-basis: {splitPct}%;"
      oncontextmenu={(e) => e.preventDefault()}
      role="presentation"
    >
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
        breadcrumb={previewBreadcrumb}
        onHeaderJump={handleOutlineJump}
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
      onClear={clearDoc}
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
