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

  let localHost: HTMLElement;

  $effect(() => {
    if (localHost && html != null) {
      localHost.innerHTML = html;
      host = localHost;
      void processMermaid(localHost);
    }
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
    if (!anchor) return; // fall through to native context menu
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

<div class="preview-wrap">
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
