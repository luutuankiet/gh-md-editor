<script lang="ts">
  import type { ThemeChoice } from '../lib/theme';
  import { describeChoice } from '../lib/theme';

  let {
    choice,
    onclick,
    pane,
  }: {
    choice: ThemeChoice;
    onclick: () => void;
    pane: string;
  } = $props();

  let title = $derived(`${pane} theme: ${describeChoice(choice)} — click to cycle`);
</script>

<button
  type="button"
  class="theme-toggle"
  {onclick}
  {title}
  aria-label={title}
>
  {#if choice === 'light'}
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm8-5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.06 1.06a.75.75 0 1 1-1.061-1.06l1.06-1.06a.75.75 0 0 1 1.061 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Zm9.193 2.121a.75.75 0 0 1-1.06 0l-1.061-1.06a.75.75 0 0 1 1.06-1.061l1.061 1.06a.75.75 0 0 1 0 1.061ZM4.464 4.465a.75.75 0 0 1-1.06 0L2.343 3.404a.75.75 0 1 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06Z"/>
    </svg>
  {:else if choice === 'dark'}
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Z"/>
    </svg>
  {:else}
    <!-- 'auto' — split sun/moon disc -->
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 14V2a6 6 0 1 0 0 12Z"/>
    </svg>
  {/if}
</button>

<style>
  /* Light is the default. Dark variant kicked in by an ancestor having
     `.theme-dark` (the surrounding pane root) — :global() lets us reach across
     Svelte's component scoping. Same pattern used by the outline / preview
     sticky-header overrides. */
  .theme-toggle {
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
    line-height: 0;
  }
  .theme-toggle:hover {
    background: rgba(208, 215, 222, 0.7);
  }
  :global(.theme-dark) .theme-toggle {
    background: rgba(22, 27, 34, 0.86);
    border-color: rgba(48, 54, 61, 0.7);
    color: #c9d1d9;
  }
  :global(.theme-dark) .theme-toggle:hover {
    background: rgba(48, 54, 61, 0.8);
  }
</style>
