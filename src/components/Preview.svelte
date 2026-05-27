<script lang="ts">
  // v0.7.0: the auto-switching `github-markdown.css` import is gone —
  // ../lib/preview-theme.ts injects BOTH light + dark variants once, each
  // scoped to `.markdown-body.theme-{light,dark}`. main.ts calls
  // injectPreviewThemes() on bootstrap.
  import morphdom from 'morphdom';
  import { processMermaid } from '../lib/mermaid';
  import PreviewSearch from './PreviewSearch.svelte';
  import { processGitHubAssets } from '../lib/gh-asset-resolver';
  import type { EffectiveTheme, ThemeChoice } from '../lib/theme';
  import ThemeToggle from './ThemeToggle.svelte';

  let {
    html,
    host = $bindable<HTMLElement | null>(null),
    onRevealRequest,
    breadcrumb = [],
    onHeaderJump,
    themeChoice = 'auto',
    effectiveTheme = 'light',
    onThemeToggle,
    onZoomIn,
    onZoomOut,
  }: {
    html: string;
    host?: HTMLElement | null;
    onRevealRequest?: (node: HTMLElement) => void;
    breadcrumb?: Array<{ line: number; level: number; text: string }>;
    onHeaderJump?: (line: number) => void;
    themeChoice?: ThemeChoice;
    effectiveTheme?: EffectiveTheme;
    onThemeToggle?: () => void;
    onZoomIn?: () => void;
    onZoomOut?: () => void;
  } = $props();

  let localHost: HTMLElement | null = $state(null);
  let scrollWrap: HTMLElement | null = $state(null);
  let containerEl: HTMLElement | null = $state(null);

  function preSubstituteMermaid(newRoot: HTMLElement, oldHost: HTMLElement): void {
    const renderedBySrc = new Map<string, HTMLElement>();
    for (const m of oldHost.querySelectorAll<HTMLElement>('div.mermaid-block')) {
      const src = m.dataset.mermaidSrc;
      if (src) renderedBySrc.set(src, m);
    }
    if (renderedBySrc.size === 0) return;
    for (const pre of Array.from(newRoot.querySelectorAll<HTMLElement>('pre'))) {
      const code = pre.querySelector<HTMLElement>('code.language-mermaid');
      if (!code) continue;
      const newSrc = (code.textContent || '').trim();
      if (!newSrc || !renderedBySrc.has(newSrc)) continue;
      const sl = pre.getAttribute('data-source-line');
      const stub = document.createElement('div');
      stub.className = 'mermaid-block';
      if (sl) stub.setAttribute('data-source-line', sl);
      stub.dataset.mermaidSrc = newSrc;
      pre.replaceWith(stub);
      renderedBySrc.delete(newSrc);
    }
  }

  let isFirstRender = true;
  let lastHtml: string | null = null;
  $effect(() => {
    if (!localHost || html == null) return;
    if (html === lastHtml) return;
    lastHtml = html;

    if (isFirstRender || localHost.childElementCount === 0) {
      localHost.innerHTML = html;
      isFirstRender = false;
      void processMermaid(localHost, effectiveTheme);
      void highlightLazy(localHost);
      processGitHubAssets(localHost);
      return;
    }

    const newRoot = document.createElement('div');
    newRoot.innerHTML = html;
    preSubstituteMermaid(newRoot, localHost);

    let highlightPending = false;

    morphdom(localHost, newRoot, {
      childrenOnly: true,
      getNodeKey: (node) => {
        if (node.nodeType !== 1) return undefined;
        const el = node as HTMLElement;
        if (el.classList?.contains('mermaid-block')) {
          const src = el.dataset?.mermaidSrc;
          return src ? `mermaid:${src}` : undefined;
        }
        return undefined;
      },
      onBeforeElUpdated: (fromEl, toEl) => {
        if (fromEl.tagName === 'DETAILS') {
          if ((fromEl as HTMLDetailsElement).open) toEl.setAttribute('open', '');
          else toEl.removeAttribute('open');
        }
        if (fromEl.classList?.contains('mermaid-block')) {
          return false;
        }
        if (
          (fromEl as HTMLElement).dataset?.snHighlighted === 'true' &&
          fromEl.tagName === 'CODE'
        ) {
          const newSrc = toEl.textContent || '';
          if ((fromEl as HTMLElement).dataset?.snSource === newSrc) {
            return false;
          }
        }
        return true;
      },
      onNodeAdded: (node) => {
        if (node.nodeType !== 1) return node;
        const el = node as HTMLElement;
        // v0.2.1: mermaid detection moved to a post-morphdom scan below — the
        // onNodeAdded approach was fragile (missed tag-changing diffs where
        // morphdom replaces an element rather than adds a fresh subtree),
        // causing brand-new ```mermaid blocks to render as raw <pre><code>
        // until tab close+reopen triggered the isFirstRender path.
        if (el.querySelector?.('pre > code[class*="language-"]') || el.matches?.('code[class*="language-"]')) {
          highlightPending = true;
        }
        return node;
      },
      // v0.7.3: when a .mermaid-block is discarded (source changed → no
      // cache stub created in preSubstituteMermaid → morphdom replaces the
      // old wrapper), destroy its attached svg-pan-zoom instance to release
      // the global event listeners it bound on init. Returning true lets
      // the discard proceed normally.
      onBeforeNodeDiscarded: (node) => {
        if (node.nodeType === 1) {
          const el = node as HTMLElement;
          if (el.classList?.contains('mermaid-block') && el._panzoom) {
            try { el._panzoom.destroy(); } catch { /* swallow */ }
            el._panzoom = undefined;
          }
        }
        return true;
      },
    });

    // v0.2.1: post-morphdom mermaid scan. Rendered blocks are
    // <div class="mermaid-block"> (they don't match the `pre > code` selector),
    // so this querySelector ONLY matches un-rendered mermaid — brand-new
    // blocks the user just typed, or blocks whose source changed (which
    // preSubstituteMermaid couldn't stub-substitute against the cache).
    // processMermaid is idempotent on already-rendered blocks but we early-
    // exit here when there are none to skip the import cost. The perf
    // invariant the user called out ("don't re-render canvas on every text
    // edit") is preserved: unchanged cached blocks remain as div.mermaid-block
    // and never match this selector.
    if (localHost.querySelector('pre > code.language-mermaid')) {
      void processMermaid(localHost, effectiveTheme);
    }
    if (highlightPending) void highlightLazy(localHost);
    processGitHubAssets(localHost);
  });

  // v0.2.0: re-render mermaid blocks when the preview pane's theme toggles.
  // The html-change effect above only fires on doc edits; this $effect runs
  // on effectiveTheme changes. Skip initial mount (html effect handles the
  // first render with the correct theme already passed in).
  let _mermaidThemeMounted = false;
  $effect(() => {
    if (!localHost) return;
    const t = effectiveTheme;
    if (!_mermaidThemeMounted) { _mermaidThemeMounted = true; return; }
    void processMermaid(localHost, t);
  });

  async function highlightLazy(target: HTMLElement) {
    const blocks = target.querySelectorAll('pre > code[class*="language-"]');
    let needs = false;
    for (const b of blocks) {
      if (!b.className.includes('language-mermaid')) { needs = true; break; }
    }
    if (!needs) return;
    const mod = await import('../lib/highlight');
    await mod.applyStarryNight(target);
  }

  // Expose the SCROLL WRAPPER to App.svelte as `host` (preserves v0.4.2 contract
  // — App attaches scroll listeners + active-heading detection against it).
  $effect(() => {
    if (scrollWrap) host = scrollWrap;
  });

  function findSourceLineAncestor(node: HTMLElement | null): HTMLElement | null {
    if (!localHost) return null;
    let n: HTMLElement | null = node;
    while (n && n !== localHost && !n.dataset.sourceLine) n = n.parentElement;
    return n && n !== localHost ? n : null;
  }

  function handleContextMenu(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target || !onRevealRequest) return;
    const anchor = findSourceLineAncestor(target);
    if (!anchor) return;
    e.preventDefault();
    onRevealRequest(anchor);
  }
</script>

<div class="preview-container theme-{effectiveTheme}" bind:this={containerEl}>
  {#if onThemeToggle}
    <div class="theme-toggle-slot">
      {#if onZoomOut}
        <button type="button" class="control-btn" onclick={onZoomOut} title="Zoom out (Cmd+−)" aria-label="Zoom out">−</button>
      {/if}
      {#if onZoomIn}
        <button type="button" class="control-btn" onclick={onZoomIn} title="Zoom in (Cmd+=)" aria-label="Zoom in">+</button>
      {/if}
      <ThemeToggle choice={themeChoice} onclick={onThemeToggle} pane="Preview" />
    </div>
  {/if}
  {#if breadcrumb.length > 0}
    <div class="sticky-headers" aria-hidden="false">
      {#each breadcrumb as item, i (item.line)}
        <button
          type="button"
          class="sticky-header level-{item.level}"
          style="top: {i * 22}px; z-index: {20 - i}"
          onclick={() => onHeaderJump?.(item.line)}
          title={`Jump to line ${item.line}`}
        >{'#'.repeat(item.level)} {item.text}</button>
      {/each}
    </div>
  {/if}
  <div class="preview-wrap" bind:this={scrollWrap}>
    <article
      class="markdown-body theme-{effectiveTheme}"
      bind:this={localHost}
      oncontextmenu={handleContextMenu}
    ></article>
  </div>
  <PreviewSearch host={localHost} {scrollWrap} container={containerEl} />
</div>

<style>
  .preview-container {
    position: relative;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }
  /* v0.5.1: sticky-header stack mirrors the editor pane's. Lives at the top of
     the preview container, abs-positioned over the scroll wrap. pointer-events:
     none on the wrapper so empty space passes clicks through to the rendered
     markdown underneath; rows re-enable pointer events. */
  .sticky-headers {
    position: absolute;
    top: 0;
    left: 0;
    right: 18px;
    z-index: 10;
    pointer-events: none;
  }
  .sticky-header {
    position: absolute;
    left: 0;
    right: 0;
    height: 22px;
    pointer-events: auto;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-top: none;
    border-left: none;
    border-right: none;
    border-bottom: 1px solid rgba(208, 215, 222, 0.5);
    padding: 0 16px;
    display: flex;
    align-items: center;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: calc(13px * var(--app-zoom, 1));
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

  .preview-wrap {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    background: #ffffff;
  }
  .markdown-body {
    box-sizing: border-box;
    padding: 24px 32px;
    max-width: 100%;
    contain: layout style paint;
  }
  :global(.markdown-body) {
    /* v0.2.3: github-markdown-css ships `.markdown-body { font-size: 16px }`
       at line 16 of its sheet. `injectPreviewThemes` (lib/preview-theme.ts)
       rewrites every `.markdown-body` selector to `.markdown-body.theme-{light,dark}`,
       bumping specificity to 0,2,0 — and the injected <style> appends to
       document.head AFTER Svelte's index.css loads, so it also wins on source
       order. To enforce app-zoom we need !important to beat that scoped rule.
       16px base matches the github-markdown-css default so appZoom=1.0 keeps
       the same rest-state the user has seen since v0.7.0. h1…h5 inside use
       em-based font-sizes (2em / 1.5em / 1.25em / 1em / .875em — see
       node_modules/github-markdown-css/github-markdown-light.css:86,291,297,302,307)
       so they propagate the calc multiplication automatically. */
    font-size: calc(16px * var(--app-zoom, 1)) !important;
  }

  /* v0.7.0 — dark theme via class on .preview-container.theme-dark instead of
     @media. Both light/dark github-markdown-css variants are pre-injected and
     scoped to .markdown-body.theme-{light,dark} — see ../lib/preview-theme.ts. */
  .preview-container.theme-dark .preview-wrap {
    background: #0d1117;
  }
  .preview-container.theme-dark .sticky-header {
    background: rgba(13, 17, 23, 0.92);
    border-bottom-color: rgba(48, 54, 61, 0.5);
  }
  .preview-container.theme-dark .sticky-header:hover { background: rgba(56, 139, 253, 0.12); }
  .preview-container.theme-dark .sticky-header.level-1 { color: #ff7b72; }
  .preview-container.theme-dark .sticky-header.level-2 { color: #79c0ff; }
  .preview-container.theme-dark .sticky-header.level-3 { color: #d2a8ff; }
  .preview-container.theme-dark .sticky-header.level-4 { color: #ffa657; }
  .preview-container.theme-dark .sticky-header.level-5 { color: #a5d6ff; }
  .preview-container.theme-dark .sticky-header.level-6,
  .preview-container.theme-dark .sticky-header.level-7,
  .preview-container.theme-dark .sticky-header.level-8 { color: #c9d1d9; }

  /* v0.7.0: GitHub-alert var overrides scoped to the preview's dark theme.
     markdown-it-github-alerts ships a `.dark` class variant
     (github-colors-dark-class.css, imported in main.ts); we re-bind those
     same vars under `.preview-container.theme-dark` so alerts follow the
     preview pane's toggle instead of the OS prefers-color-scheme. */
  .preview-container.theme-dark {
    --color-note: #2f81f7;
    --color-tip: #3fb950;
    --color-warning: #d29922;
    --color-severe: #db6d28;
    --color-caution: #f85149;
    --color-important: #a371f7;
  }

  /* Toggle docks top-right of preview pane, above sticky-headers wrap (z:10).
     v0.2.1: now also hosts zoom +/- buttons next to the theme toggle. */
  .theme-toggle-slot {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 20;
    display: flex;
    gap: 4px;
    align-items: center;
  }

  /* v0.2.1: zoom +/- buttons docked next to the theme toggle. Matches
     ThemeToggle.svelte chrome (24px square, rounded, blur bg, theme-dark
     variant). Optional onZoomIn/onZoomOut props -> buttons hidden in web app. */
  .control-btn {
    width: 24px;
    height: 24px;
    border: 1px solid rgba(208, 215, 222, 0.7);
    background: rgba(246, 248, 250, 0.86);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-radius: 4px;
    cursor: pointer;
    color: #1f2328;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font: 600 14px/1 system-ui, -apple-system, sans-serif;
  }
  .control-btn:hover { background: rgba(208, 215, 222, 0.7); }
  .preview-container.theme-dark .control-btn {
    background: rgba(22, 27, 34, 0.86);
    border-color: rgba(48, 54, 61, 0.7);
    color: #c9d1d9;
  }
  .preview-container.theme-dark .control-btn:hover {
    background: rgba(48, 54, 61, 0.8);
  }
  /* v0.6.0 — github user-attachments image proxy states */
  :global(.gh-asset-pending) {
    opacity: 0.7;
    background: rgba(9, 105, 218, 0.05);
    border: 1px dashed rgba(9, 105, 218, 0.3);
    border-radius: 6px;
    min-height: 40px;
    padding: 4px;
  }
  :global(a.gh-asset-fallback) {
    display: inline-block;
    padding: 6px 12px;
    background: rgba(208, 215, 222, 0.3);
    border: 1px solid rgba(208, 215, 222, 0.8);
    border-radius: 6px;
    color: #0969da;
    text-decoration: none;
    font-size: 13px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  :global(a.gh-asset-fallback:hover) {
    background: rgba(9, 105, 218, 0.10);
    border-color: #0969da;
  }
  /* v0.7.0: dark gh-asset-fallback variant via class instead of @media. The
     .theme-dark class is on the preview-container ancestor; :global() opens
     the descendant fallback link which Svelte would otherwise scope-strip. */
  :global(.theme-dark a.gh-asset-fallback) {
    background: rgba(56, 139, 253, 0.10);
    border-color: rgba(56, 139, 253, 0.4);
    color: #79c0ff;
  }
  :global(.theme-dark a.gh-asset-fallback:hover) {
    background: rgba(56, 139, 253, 0.20);
    border-color: #79c0ff;
  }
  /* v0.6.1 — non-destructive fallback shell. Keeps original <img> in DOM tree */
  /* so copying/exporting preview HTML preserves the canonical markup. CSS only */
  /* hides the img visually; the link sibling is the user-facing affordance. */
  :global(.gh-asset-shell) {
    display: inline-block;
  }
  :global(.gh-asset-shell-fallback > img) {
    display: none;
  }
  /* v0.6.5 — aspect-ratio fix for imgs with explicit width/height attributes.
     github-markdown-css sets max-width:100% on .markdown-body img but NOT
     height:auto, so when the browser clamps width to container, the height
     attribute stays at its literal value — producing a squashed render
     (e.g. 600px wide × 953px tall on a 1024×953 source). GitHub's production
     CSS includes this rule; the npm github-markdown-css package omits it.
     Restoring it makes aspect ratio survive container clamping. */
  :global(.markdown-body img) {
    height: auto;
  }
</style>
