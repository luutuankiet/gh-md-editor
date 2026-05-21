<script lang="ts">
  import 'github-markdown-css/github-markdown.css';
  import morphdom from 'morphdom';
  import { processMermaid } from '../lib/mermaid';
  import PreviewSearch from './PreviewSearch.svelte';

  let {
    html,
    host = $bindable<HTMLElement | null>(null),
    onRevealRequest,
    breadcrumb = [],
    onHeaderJump,
  }: {
    html: string;
    host?: HTMLElement | null;
    onRevealRequest?: (node: HTMLElement) => void;
    breadcrumb?: Array<{ line: number; level: number; text: string }>;
    onHeaderJump?: (line: number) => void;
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
      void processMermaid(localHost);
      void highlightLazy(localHost);
      return;
    }

    const newRoot = document.createElement('div');
    newRoot.innerHTML = html;
    preSubstituteMermaid(newRoot, localHost);

    let mermaidPending = false;
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
        if (el.querySelector?.('pre > code.language-mermaid') || el.matches?.('code.language-mermaid')) {
          mermaidPending = true;
        }
        if (el.querySelector?.('pre > code[class*="language-"]') || el.matches?.('code[class*="language-"]')) {
          highlightPending = true;
        }
        return node;
      },
    });

    if (mermaidPending) void processMermaid(localHost);
    if (highlightPending) void highlightLazy(localHost);
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

<div class="preview-container" bind:this={containerEl}>
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
      class="markdown-body"
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

  .preview-wrap {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg, #ffffff);
  }
  .markdown-body {
    box-sizing: border-box;
    padding: 24px 32px;
    max-width: 100%;
    contain: layout style paint;
  }
  :global(.markdown-body) {
    font-size: 14px;
  }
  @media (prefers-color-scheme: dark) {
    .preview-wrap {
      background: #0d1117;
    }
    .sticky-header {
      background: rgba(13, 17, 23, 0.92);
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
