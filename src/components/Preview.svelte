<script lang="ts">
  import 'github-markdown-css/github-markdown.css';
  import morphdom from 'morphdom';
  import { processMermaid } from '../lib/mermaid';
  import PreviewSearch from './PreviewSearch.svelte';

  let {
    html,
    host = $bindable<HTMLElement | null>(null),
    onRevealRequest,
  }: {
    html: string;
    host?: HTMLElement | null;
    onRevealRequest?: (node: HTMLElement) => void;
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
  }
</style>
