<script lang="ts">
  import type { OutlineNode } from '../../lib/code-outline';

  // Sidebar outline: the structure of whatever the active editor holds —
  // headings for markdown, declarations for code. Deliberately slim; the
  // markdown cockpit's own Outline.svelte carries theme/help chrome this
  // sidebar must not inherit.
  let { nodes = [], onJump }: {
    nodes?: OutlineNode[];
    onJump: (line: number) => void;
  } = $props();

  let folded = $state<Set<number>>(new Set());

  function toggle(line: number) {
    const next = new Set(folded);
    if (next.has(line)) next.delete(line);
    else next.add(line);
    folded = next;
  }

  function collectFoldable(list: OutlineNode[], out: number[] = []): number[] {
    for (const n of list) {
      if (!n.children.length) continue;
      out.push(n.line);
      collectFoldable(n.children, out);
    }
    return out;
  }

  // Driven by the section header's button, which cannot reach `folded`
  // directly — the fold state belongs to this panel.
  export function toggleFoldAll() {
    folded = folded.size ? new Set() : new Set(collectFoldable(nodes));
  }
</script>

<!-- Symbol icons, colour-matched to VS Code's outline so the shapes read the
     same way: purple for callables, blue for data, orange for types. -->
{#snippet sym(node: OutlineNode)}
  {#if node.kind === 'function'}
    <svg class="ic fn" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9 13.5 5v6L8 14.1 2.5 11V5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 8 13.5 5M8 8 2.5 5M8 8v6.1" fill="none" stroke="currentColor" stroke-width="1" opacity="0.75"/></svg>
  {:else if node.kind === 'class'}
    <svg class="ic cls" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.7" fill="currentColor"/></svg>
  {:else if node.kind === 'interface'}
    <svg class="ic iface" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
  {:else if node.kind === 'enum'}
    <svg class="ic enum" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3.6" width="10" height="1.9" rx="0.9" fill="currentColor"/><rect x="3" y="7.1" width="10" height="1.9" rx="0.9" fill="currentColor"/><rect x="3" y="10.6" width="10" height="1.9" rx="0.9" fill="currentColor"/></svg>
  {:else if node.kind === 'module'}
    <svg class="ic mod" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.7" y="2.7" width="10.6" height="10.6" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
  {:else if node.kind === 'rule'}
    <svg class="ic rule" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.6 8 3.2l5 9.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
  {:else if node.kind === 'variable'}
    <svg class="ic var" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="3.6" width="10.8" height="8.8" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.7" fill="currentColor"/></svg>
  {:else}
    <span class="ic hx">H{node.level}</span>
  {/if}
{/snippet}

{#snippet rows(list: OutlineNode[], depth: number)}
  {#each list as node (node.line + ':' + node.text)}
    <div class="orow">
      <!-- One guide per ancestor level: the vertical rules that make nesting
           readable at a glance, same as the explorer's indent guides. -->
      {#each Array(depth) as _, i (i)}<span class="guide"></span>{/each}
      <button
        type="button"
        class="chev"
        class:empty={!node.children.length}
        aria-label="Toggle section"
        onclick={() => toggle(node.line)}
      >{node.children.length ? (folded.has(node.line) ? '▸' : '▾') : ''}</button>
      {@render sym(node)}
      <button type="button" class="label" title={node.text} onclick={() => onJump(node.line)}>
        <span class="text">{node.text}</span>
        <span class="ln">{node.line}</span>
      </button>
    </div>
    {#if node.children.length && !folded.has(node.line)}
      {@render rows(node.children, depth + 1)}
    {/if}
  {/each}
{/snippet}

<div class="panel">
  <div class="body">
    {#if nodes.length}
      {@render rows(nodes, 0)}
    {:else}
      <div class="empty">No symbols found for the active editor.</div>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-size: 12px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0;
  }
  .empty {
    padding: 10px 12px;
    opacity: 0.6;
  }
  .orow {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding-left: 6px;
  }
  /* Stretch, not centre: the guide has to run the full row height so
     consecutive rows form one unbroken vertical line. */
  .guide {
    width: 12px;
    flex: 0 0 12px;
    border-left: 1px solid #30363d;
  }
  .ic {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    align-self: center;
  }
  .fn { color: #b180d7; }
  .var { color: #75beff; }
  .cls { color: #ee9d28; }
  .iface { color: #75beff; }
  .enum { color: #ee9d28; }
  .mod { color: #8b949e; }
  .rule { color: #4ec9b0; }
  .hx {
    font-size: 9px;
    line-height: 14px;
    text-align: center;
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
  }
  .orow:hover {
    background: rgba(127, 127, 127, 0.16);
  }
  .chev,
  .label {
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 2px 0;
  }
  .chev {
    width: 14px;
    flex: 0 0 14px;
    opacity: 0.7;
    line-height: 1;
  }
  .chev.empty {
    cursor: default;
  }
  .label {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    text-align: left;
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ln {
    margin-left: auto;
    padding-right: 8px;
    opacity: 0.45;
    font-variant-numeric: tabular-nums;
  }
</style>
