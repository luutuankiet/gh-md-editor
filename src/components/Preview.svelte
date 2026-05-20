<script lang="ts">
  import 'github-markdown-css/github-markdown.css';
  import { processMermaid } from '../lib/mermaid';

  let {
    html,
    host = $bindable<HTMLElement | null>(null),
    onRevealRequest,
  }: {
    html: string;
    host?: HTMLElement | null;
    onRevealRequest?: (node: HTMLElement) => void;
  } = $props();

  // localHost = the <article> that receives innerHTML + mermaid processing.
  // scrollWrap = the <div.preview-wrap> that ACTUALLY scrolls (overflow-y:auto).
  // We expose scrollWrap as `host` so App.svelte's scroll listener fires on the real
  // scrolling element. querySelectorAll('[data-source-line]') still works because
  // those elements live inside <article>, which is a descendant of scrollWrap.
  let localHost: HTMLElement;
  let scrollWrap: HTMLElement;

  $effect(() => {
    if (localHost && html != null) {
      localHost.innerHTML = html;
      void processMermaid(localHost);
      void highlightLazy(localHost);
    }
  });

  async function highlightLazy(target: HTMLElement) {
    // Only pay the cost (≈1 MB starry-night + CSS) if there's a non-mermaid fenced block.
    const blocks = target.querySelectorAll('pre > code[class*="language-"]');
    let needs = false;
    for (const b of blocks) {
      if (!b.className.includes('language-mermaid')) { needs = true; break; }
    }
    if (!needs) return;
    const mod = await import('../lib/highlight');
    await mod.applyStarryNight(target);
  }

  $effect(() => {
    if (scrollWrap) host = scrollWrap;
  });

  function findSourceLineAncestor(node: HTMLElement | null): HTMLElement | null {
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

  function handleDblClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target || !onRevealRequest) return;
    const anchor = findSourceLineAncestor(target);
    if (!anchor) return;
    onRevealRequest(anchor);
  }
</script>

<div class="preview-wrap" bind:this={scrollWrap}>
  <article
    class="markdown-body"
    bind:this={localHost}
    oncontextmenu={handleContextMenu}
    ondblclick={handleDblClick}
  ></article>
</div>

<style>
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
