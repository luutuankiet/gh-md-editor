<script lang="ts">
  import type { OutlineNode } from '../lib/markdown';
  import type { EffectiveTheme, ThemeChoice } from '../lib/theme';
  import ThemeToggle from './ThemeToggle.svelte';

  let {
    nodes,
    activeLine = 0,
    onJump,
    onHelp,
    onClear,
    themeChoice = 'auto',
    effectiveTheme = 'light',
    onThemeToggle,
  }: {
    nodes: OutlineNode[];
    activeLine?: number;
    onJump: (line: number) => void;
    onHelp?: () => void;
    onClear?: () => void;
    themeChoice?: ThemeChoice;
    effectiveTheme?: EffectiveTheme;
    onThemeToggle?: () => void;
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
    } else if (e.key === '?' && onHelp) {
      onHelp();
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

  // v0.5.1: when the active heading lands inside a collapsed branch, walk the
  // ancestor chain and force-open every node containing the active line so the
  // highlighted row becomes visible. Direct mutation of `folded` from an effect
  // is intentional — trigger is derived state (activeLine via scroll), not a
  // user click on this component.
  $effect(() => {
    if (activeLine === 0) return;
    const ancestors = activeAncestors;
    let mutated = false;
    const next = new Set(folded);
    for (const a of ancestors) {
      if (a !== activeLine && next.has(a)) {
        next.delete(a);
        mutated = true;
      }
    }
    if (mutated) folded = next;
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="outline-pane theme-{effectiveTheme}"
  bind:this={host}
  tabindex="0"
  role="tree"
  aria-label="Document outline"
>
  <header class="outline-header">
    <span class="title">Outline</span>
    {#if onThemeToggle}
      <ThemeToggle choice={themeChoice} onclick={onThemeToggle} pane="Outline" />
    {/if}
    {#if onHelp}
      <button onclick={() => onHelp?.()} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
    {/if}
    <a
      class="gh-link"
      href="https://github.com/luutuankiet/gh-md-editor"
      target="_blank"
      rel="noopener noreferrer"
      title="View source on GitHub"
      aria-label="View source on GitHub"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
      </svg>
    </a>
    <button onclick={foldAll} title="Fold all (−)" aria-label="Fold all">−</button>
    <button onclick={unfoldAll} title="Unfold all (+)" aria-label="Unfold all">+</button>
    {#if onClear}
      <button
        class="clear-storage"
        onclick={() => onClear?.()}
        title="Clear stored draft and reload (restores the sample doc)"
        aria-label="Clear stored draft"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path fill="currentColor" d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.75 1.75 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.74-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75v1.25h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/>
        </svg>
      </button>
    {/if}
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
  .outline-header .gh-link {
    width: 22px;
    height: 22px;
    border: 1px solid #d0d7de;
    background: #fff;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #1f2328;
    text-decoration: none;
    padding: 0;
  }
  .outline-header .gh-link:hover { background: #eaeef2; }

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

  /* v0.7.0: outline dark variant now class-driven (.theme-dark on outline-pane
     root) instead of @media (prefers-color-scheme: dark). Per-pane toggle
     overrides OS pref. */
  .outline-pane.theme-dark {
    background: #161b22;
    border-left-color: #30363d;
    color: #c9d1d9;
  }
  .outline-pane.theme-dark .outline-header { border-bottom-color: #30363d; }
  .outline-pane.theme-dark .outline-header .title { color: #8b949e; }
  .outline-pane.theme-dark .outline-header button {
    background: #21262d;
    border-color: #30363d;
    color: #c9d1d9;
  }
  .outline-pane.theme-dark .outline-header button:hover { background: #30363d; }
  .outline-pane.theme-dark .outline-header .gh-link {
    background: #21262d;
    border-color: #30363d;
    color: #c9d1d9;
  }
  .outline-pane.theme-dark .outline-header .gh-link:hover { background: #30363d; }
  .outline-pane.theme-dark .outline-node .row:hover { background: rgba(56, 139, 253, 0.10); }
  .outline-pane.theme-dark .outline-node.active > .row { background: rgba(56, 139, 253, 0.20); }
  .outline-pane.theme-dark .outline-node.active > .row:hover { background: rgba(56, 139, 253, 0.26); }
  .outline-pane.theme-dark .outline-node.ancestor > .row .label { color: #58a6ff; }
  .outline-pane.theme-dark .fold-toggle { color: #8b949e; }
  .outline-pane.theme-dark .outline-node .row:hover .fold-toggle { color: #c9d1d9; }
  .outline-pane.theme-dark .outline-empty { color: #8b949e; }
</style>
