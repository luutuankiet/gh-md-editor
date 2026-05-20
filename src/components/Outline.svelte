<script lang="ts">
  import type { OutlineNode } from '../lib/markdown';

  let {
    nodes,
    activeLine = 0,
    onJump,
  }: {
    nodes: OutlineNode[];
    activeLine?: number;
    onJump: (line: number) => void;
  } = $props();

  let folded = $state(new Set<number>());
  let host: HTMLElement;

  function toggleFold(line: number) {
    const next = new Set(folded);
    if (next.has(line)) next.delete(line);
    else next.add(line);
    folded = next;
  }

  function handleRowClick(node: OutlineNode) {
    // Whole-row click = jump to section AND (if it has children) toggle fold.
    // Matches the user's request to widen the click area beyond just the chevron.
    onJump(node.line);
    if (node.children.length) toggleFold(node.line);
  }

  function foldAll() {
    const next = new Set<number>();
    const walk = (n: OutlineNode) => {
      if (n.children.length) next.add(n.line);
      for (const c of n.children) walk(c);
    };
    for (const r of nodes) walk(r);
    folded = next;
  }

  function unfoldAll() {
    folded = new Set();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!host) return;
    const target = e.target as Node | null;
    if (target !== host && (!target || !host.contains(target))) return;
    if (e.key === '-') {
      foldAll();
      e.preventDefault();
    } else if (e.key === '+' || e.key === '=') {
      unfoldAll();
      e.preventDefault();
    }
  }

  function findAncestors(roots: OutlineNode[], line: number): Set<number> {
    const out = new Set<number>();
    const walk = (n: OutlineNode, trail: number[]): boolean => {
      const next = [...trail, n.line];
      if (n.line === line) {
        for (const l of next) out.add(l);
        return true;
      }
      for (const c of n.children) {
        if (walk(c, next)) return true;
      }
      return false;
    };
    for (const r of roots) walk(r, []);
    return out;
  }

  let activeAncestors = $derived(findAncestors(nodes, activeLine));
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="outline-pane" bind:this={host} tabindex="0" role="tree" aria-label="Document outline">
  <header class="outline-header">
    <span class="title">Outline</span>
    <button onclick={foldAll} title="Fold all (−)" aria-label="Fold all">−</button>
    <button onclick={unfoldAll} title="Unfold all (+)" aria-label="Unfold all">+</button>
  </header>
  <div class="outline-scroll">
    {#if nodes.length === 0}
      <p class="outline-empty">No headings yet.</p>
    {:else}
      <ul class="outline-tree">
        {#each nodes as node (node.line)}
          {@render branch(node)}
        {/each}
      </ul>
    {/if}
  </div>
</div>

{#snippet branch(node: OutlineNode)}
  <li
    class="outline-node level-{node.level}"
    class:active={node.line === activeLine}
    class:ancestor={activeAncestors.has(node.line) && node.line !== activeLine}
  >
    <button
      type="button"
      class="row"
      onclick={() => handleRowClick(node)}
      title={node.children.length ? `Jump to line ${node.line} and toggle fold` : `Jump to line ${node.line}`}
    >
      {#if node.children.length}
        <span class="fold-toggle" aria-hidden="true">
          {folded.has(node.line) ? '▸' : '▾'}
        </span>
      {:else}
        <span class="fold-spacer" aria-hidden="true"></span>
      {/if}
      <span class="label">{node.text}</span>
    </button>
    {#if node.children.length && !folded.has(node.line)}
      <ul>
        {#each node.children as child (child.line)}
          {@render branch(child)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<style>
  .outline-pane {
    height: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    background: #f6f8fa;
    border-left: 1px solid #d0d7de;
    font-size: 12px;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #1f2328;
    outline: none;
    overflow: hidden;
  }
  .outline-pane:focus-visible {
    box-shadow: inset 0 0 0 2px #0969da;
  }
  .outline-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid #d0d7de;
    background: inherit;
    flex: 0 0 auto;
  }
  .outline-header .title {
    flex: 1;
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #57606a;
  }
  .outline-header button {
    width: 22px;
    height: 22px;
    border: 1px solid #d0d7de;
    background: #fff;
    cursor: pointer;
    border-radius: 4px;
    font-size: 14px;
    line-height: 1;
    color: #1f2328;
    padding: 0;
  }
  .outline-header button:hover { background: #eaeef2; }

  .outline-scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: auto;
  }
  .outline-empty {
    padding: 12px 10px;
    color: #6e7681;
    font-style: italic;
    margin: 0;
  }

  .outline-tree {
    list-style: none;
    padding: 0;
    margin: 0;
    min-width: 100%;       /* fill scroll container at minimum */
    width: max-content;    /* grow beyond pane width for long headings */
  }
  .outline-node ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .outline-node .row {
    /* Now a <button>: full-row click target. */
    display: flex;
    align-items: center;
    gap: 2px;
    white-space: nowrap;
    padding: 2px 12px 2px 0;
    width: 100%;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    line-height: 1.5;
  }
  .outline-node .row:hover {
    background: rgba(9, 105, 218, 0.08);
  }
  .outline-node .row:focus-visible {
    outline: 2px solid #0969da;
    outline-offset: -2px;
  }
  .outline-node.active > .row {
    background: rgba(9, 105, 218, 0.16);
  }
  .outline-node.active > .row:hover {
    background: rgba(9, 105, 218, 0.22);
  }
  .outline-node.ancestor > .row .label {
    color: #0969da;
    font-weight: 500;
  }
  .outline-node .label {
    white-space: nowrap;
    text-align: left;
  }
  .fold-toggle {
    width: 14px;
    height: 14px;
    font-size: 9px;
    line-height: 1;
    color: #57606a;
    flex: 0 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .outline-node .row:hover .fold-toggle { color: #1f2328; }
  .fold-spacer {
    display: inline-block;
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
  }

  .level-1 > .row { padding-left: 6px; }
  .level-2 > .row { padding-left: 14px; }
  .level-3 > .row { padding-left: 22px; }
  .level-4 > .row { padding-left: 30px; }
  .level-5 > .row { padding-left: 38px; }
  .level-6 > .row { padding-left: 46px; }
  .level-7 > .row { padding-left: 54px; }
  .level-8 > .row { padding-left: 62px; }

  @media (prefers-color-scheme: dark) {
    .outline-pane {
      background: #161b22;
      border-left-color: #30363d;
      color: #c9d1d9;
    }
    .outline-header { border-bottom-color: #30363d; }
    .outline-header .title { color: #8b949e; }
    .outline-header button {
      background: #21262d;
      border-color: #30363d;
      color: #c9d1d9;
    }
    .outline-header button:hover { background: #30363d; }
    .outline-node .row:hover { background: rgba(56, 139, 253, 0.10); }
    .outline-node.active > .row { background: rgba(56, 139, 253, 0.20); }
    .outline-node.active > .row:hover { background: rgba(56, 139, 253, 0.26); }
    .outline-node.ancestor > .row .label { color: #58a6ff; }
    .fold-toggle { color: #8b949e; }
    .outline-node .row:hover .fold-toggle { color: #c9d1d9; }
    .outline-empty { color: #8b949e; }
  }
</style>
