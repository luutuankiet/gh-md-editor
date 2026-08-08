<script lang="ts">
  import { untrack } from 'svelte';
  import Editor from '../Editor.svelte';
  import Preview from '../Preview.svelte';
  import Splitter from '../Splitter.svelte';
  import Outline from '../Outline.svelte';
  import ShortcutsDialog from '../ShortcutsDialog.svelte';
  import { parseMarkdown, extractOutline, type OutlineNode } from '../../lib/markdown';
  import { revealPreview, revealEditor } from '../../lib/reveal';
  import {
    loadTheme, saveTheme, cycleTheme, systemPrefersDark, onSystemThemeChange,
    type ThemeChoice, type EffectiveTheme,
  } from '../../lib/theme';
  import { EditorView } from '@codemirror/view';

  import { tabViewOf, patchTabView } from '../../lib/tab-view-state.svelte';

  // Three-pane markdown cockpit hosted inside a tab of the server shell.
  // `value` is the tab's document content, owned by App-server.svelte.
  let { value = $bindable(''), name = '', reveal = null, viewKey = '' }: {
    value?: string;
    name?: string;
    // Which tab this cockpit is hosted in, for the state the tab remembers on
    // its behalf: word wrap, and the scroll position of both panes.
    viewKey?: string;
    // Sidebar-outline jump, same channel the code editor uses. `seq` makes a
    // repeat click on the same heading fire again.
    reveal?: { line: number; seq: number } | null;
  } = $props();

  // Per-pane theme state, localStorage-backed (same keys as the web app).
  let editorChoice = $state<ThemeChoice>(loadTheme('editor'));
  let previewChoice = $state<ThemeChoice>(loadTheme('preview'));
  let outlineChoice = $state<ThemeChoice>(loadTheme('outline'));
  let systemDark = $state(systemPrefersDark());
  $effect(() => onSystemThemeChange((dark) => { systemDark = dark; }));

  function resolve(c: ThemeChoice): EffectiveTheme {
    if (c === 'light') return 'light';
    if (c === 'dark') return 'dark';
    return systemDark ? 'dark' : 'light';
  }
  let editorEffective = $derived<EffectiveTheme>(resolve(editorChoice));
  let previewEffective = $derived<EffectiveTheme>(resolve(previewChoice));
  let outlineEffective = $derived<EffectiveTheme>(resolve(outlineChoice));

  function cycleEditor() {
    editorChoice = cycleTheme(editorChoice);
    saveTheme('editor', editorChoice);
  }
  function cyclePreview() {
    previewChoice = cycleTheme(previewChoice);
    saveTheme('preview', previewChoice);
  }
  function cycleOutline() {
    outlineChoice = cycleTheme(outlineChoice);
    saveTheme('outline', outlineChoice);
  }

  let doc = $state(untrack(() => value));
  let html = $state(untrack(() => parseMarkdown(doc)));
  // Pane ratios are a workspace preference, not a per-file one: resize once and
  // every markdown file opened afterwards inherits the layout. Keyed by the
  // workspace anchor so separate folders keep separate layouts.
  const wsKey = new URLSearchParams(location.search).get('folder') ?? '';
  function loadPct(key: string, fallback: number): number {
    try {
      const raw = localStorage.getItem(`ghmd.${key}:${wsKey}`);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) && n > 5 && n < 95 ? n : fallback;
    } catch {
      return fallback;
    }
  }
  function savePct(key: string, v: number) {
    try {
      localStorage.setItem(`ghmd.${key}:${wsKey}`, String(Math.round(v)));
    } catch {
      /* private mode / quota — layout just won't persist */
    }
  }

  let splitPct = $state(loadPct('mdSplit', 50));
  // outlineSplitterPct = splitter position from LEFT of shell, %. Outline pane is
  // RIGHT of splitter, so its width = 100 - outlineSplitterPct.
  let outlineSplitterPct = $state(loadPct('mdOutlineSplit', 80));
  $effect(() => { savePct('mdSplit', splitPct); });
  $effect(() => { savePct('mdOutlineSplit', outlineSplitterPct); });
  let editorView: EditorView | null = $state(null);
  let previewHost: HTMLElement | null = $state(null);
  let showShortcuts = $state(false);

  // --- Shell <-> editor document sync ---
  // `doc` is the editor's live document; `value` is the tab content bound to
  // the shell. `lastExternal` marks the most recent text the shell is known to
  // hold, so a shell-driven replacement (conflict-resolution reload) is
  // distinguishable from the echo of our own push.
  let lastExternal = untrack(() => value);
  let firstDocPush = true;
  $effect(() => {
    const d = doc;
    if (firstDocPush) { firstDocPush = false; return; }
    if (d === untrack(() => value)) return;
    lastExternal = d;
    value = d;
  });
  $effect(() => {
    const v = value;
    if (v === lastExternal) return;
    lastExternal = v;
    if (v === untrack(() => doc)) return;
    if (editorView) {
      // Full-doc replace through CM6 preserves cursor handling; the
      // updateListener writes back into `doc` via the $bindable chain.
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: v },
      });
    } else {
      doc = v;
    }
  });

  let outline = $derived<OutlineNode[]>(extractOutline(doc));

  // Feed the sidebar outline (shared with code tabs). Debounced so typing does
  // not spray events at the shell.
  $effect(() => {
    const nodes = outline;
    const nm = name;
    const t = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('gmd:outline', { detail: { name: nm, nodes } }));
    }, 200);
    return () => clearTimeout(t);
  });

  // …and answer the shell's request on tab switch, without waiting for an edit.
  $effect(() => {
    const on = () => {
      window.dispatchEvent(new CustomEvent('gmd:outline', { detail: { name, nodes: outline } }));
    };
    window.addEventListener('gmd:outline-request', on);
    return () => window.removeEventListener('gmd:outline-request', on);
  });

  // Sidebar clicked a heading — reuse the cockpit's own jump path.
  $effect(() => {
    const r = reveal;
    if (!r) return;
    untrack(() => handleOutlineJump(r.line));
  });

  let activeHeadingLine = $state(0);
  let editorTopLine = $state(1);
  // Track preview scrollTop so the sticky stack hides when the user is at the
  // very top (parity with editor's `topLine > 1` suppression).
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

  // Track which heading is currently visible at the top of the preview pane.
  // Skip elements whose `offsetParent === null` — those are inside closed
  // <details> (display:none); their getBoundingClientRect() returns zeros,
  // which would falsely satisfy the top-of-pane threshold.
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
        if (el.offsetParent === null) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= threshold) active = ln;
        else break;
      }
      activeHeadingLine = active || flatLines[0];
    };

    // The preview is its own scroller, so the tab remembers it separately from
    // the source pane. Pixels rather than a document anchor: the rendered
    // article has no line numbers to hold on to.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      previewScrollTop = ph.scrollTop;
      if (viewKey) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => patchTabView(viewKey, { px: ph.scrollTop }), 150);
      }
      requestAnimationFrame(compute);
    };
    ph.addEventListener('scroll', onScroll, { passive: true });

    // Restoring it has to wait for height. The article renders in stages — code
    // highlighting, then mermaid diagrams — so the first paint is often too
    // short to hold the saved offset at all. Retry as the document grows, with a
    // hard attempt budget so a genuinely shorter document stops the loop instead
    // of leaving it armed.
    // Untracked, for the reason the source pane untracks its own anchor: the
    // scroll handler above writes this very key, so a reactive read here tears
    // this effect down and re-arms the listener and MutationObserver on every
    // scroll - and re-asserts the saved offset while the reader is still moving.
    const wantPx = untrack(() => (viewKey ? tabViewOf(viewKey)?.px ?? 0 : 0));
    let restoreTries = wantPx > 0 ? 20 : 0;
    const tryRestore = () => {
      if (restoreTries <= 0) return;
      restoreTries--;
      if (ph.scrollHeight - ph.clientHeight < wantPx) return;
      ph.scrollTop = wantPx;
      restoreTries = 0;
    };

    let scheduleTimer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(scheduleTimer);
      scheduleTimer = setTimeout(() => { tryRestore(); compute(); }, 100);
    };
    schedule();

    // Observe the article's children plus the `open` attribute on <details>:
    // expanding a collapsed section flips headings from offsetParent === null
    // to visible, so the active-heading calculation must re-run.
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
      clearTimeout(saveTimer);
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
</script>

<main class="shell">
  <div class="editor-preview">
    <div
      class="pane editor-pane theme-{editorEffective}"
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
        {viewKey}
        bind:value={doc}
        bind:view={editorView}
        bind:topLine={editorTopLine}
        onRevealRequest={handleEditorReveal}
        themeChoice={editorChoice}
        effectiveTheme={editorEffective}
        onThemeToggle={cycleEditor}
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
        themeChoice={previewChoice}
        effectiveTheme={previewEffective}
        onThemeToggle={cyclePreview}
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
      onClear={() => { /* no-op: the server shell owns document lifecycle */ }}
      themeChoice={outlineChoice}
      effectiveTheme={outlineEffective}
      onThemeToggle={cycleOutline}
    />
  </div>
</main>

<ShortcutsDialog bind:open={showShortcuts} />

<style>
  .shell {
    display: flex;
    flex-direction: row;
    height: 100%;
    width: 100%;
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
  /* Sticky-header stack: one absolute row per breadcrumb level, cascading 22px
     each. Rows are translucent + blurred so editor content underneath stays
     dimly visible. The wrapper is pointer-events:none so empty space between
     rows passes clicks through; individual rows re-enable it. */
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
  .sticky-header:hover { background: rgba(255, 255, 255, 0.06); }
  .sticky-header.level-1 { color: #cf222e; font-weight: 700; }
  .sticky-header.level-2 { color: #0550ae; font-weight: 700; }
  .sticky-header.level-3 { color: #6639ba; font-weight: 600; }
  .sticky-header.level-4 { color: #953800; font-weight: 600; }
  .sticky-header.level-5 { color: #0a3069; font-weight: 500; }
  .sticky-header.level-6,
  .sticky-header.level-7,
  .sticky-header.level-8 { color: #232323; font-weight: 500; }

  /* Sticky-header dark variant keyed off the editor pane's theme class,
     mirroring the per-pane toggle. */
  .editor-pane.theme-dark .sticky-header {
    background: rgba(30, 30, 30, 0.86);
    border-bottom-color: rgba(64, 64, 64, 0.5);
  }
  .editor-pane.theme-dark .sticky-header:hover { background: rgba(255, 255, 255, 0.07); }
  .editor-pane.theme-dark .sticky-header.level-1 { color: #ff7b72; }
  .editor-pane.theme-dark .sticky-header.level-2 { color: #79c0ff; }
  .editor-pane.theme-dark .sticky-header.level-3 { color: #d2a8ff; }
  .editor-pane.theme-dark .sticky-header.level-4 { color: #ffa657; }
  .editor-pane.theme-dark .sticky-header.level-5 { color: #a5d6ff; }
  .editor-pane.theme-dark .sticky-header.level-6,
  .editor-pane.theme-dark .sticky-header.level-7,
  .editor-pane.theme-dark .sticky-header.level-8 { color: #c5c8c6; }
</style>
