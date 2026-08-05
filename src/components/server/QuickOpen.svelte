<script lang="ts">
  import { highlightSegments } from '../../lib/quickopen';
  import type { QoItem } from '../../lib/quickopen';

  let {
    open = false,
    query = $bindable(''),
    sel = $bindable(0),
    items = [],
    term = '',
    placeholder = '',
    status = '',
    onclose,
    onpick,
    oninput,
  }: {
    open?: boolean;
    query?: string;
    sel?: number;
    items?: QoItem[];
    // What to highlight inside each label — the query minus its mode prefix.
    term?: string;
    placeholder?: string;
    // Shown in place of the list: "no matches", a fetch error, a hint.
    status?: string;
    onclose: () => void;
    onpick: (item: QoItem) => void;
    oninput: () => void;
  } = $props();

  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  // Focus on open, and select whatever was pre-filled so typing replaces it —
  // the folder picker opens pre-filled with the current workspace path.
  $effect(() => {
    if (!open) return;
    const el = inputEl;
    if (!el) return;
    el.focus();
    // A mode sigil (`>`, `#`, `:`, `@`) is a prefix, not a value: selecting it
    // means the first keystroke replaces it and the palette silently falls back
    // to file mode. Park the caret after it instead, and keep select-all for the
    // genuinely pre-filled case — the folder picker opens on a real path.
    if (/^[>#:@]?$/.test(el.value)) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
  });

  // Keep the highlighted row visible as the arrows walk past the fold.
  $effect(() => {
    const i = sel;
    const list = listEl;
    if (!list) return;
    const row = list.children[i] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  });

  function keydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = items.length ? (sel + 1) % items.length : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = items.length ? (sel - 1 + items.length) % items.length : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = items[sel];
      if (hit) onpick(hit);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }
</script>

{#if open}
  <!-- Scrim closes on click-away. mousedown rather than click so it fires
       before the input's blur reorders anything. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="qo-scrim" onmousedown={onclose}></div>
  <div class="qo-modal" role="dialog" aria-modal="true" aria-label="Quick open">
    <input
      bind:this={inputEl}
      bind:value={query}
      class="qo-input"
      spellcheck="false"
      autocomplete="off"
      {placeholder}
      oninput={oninput}
      onkeydown={keydown}
    />
    {#if items.length}
      <div class="qo-list" bind:this={listEl} role="listbox" tabindex="-1" aria-label="Results">
        {#each items as item, i (item.key)}
          <button
            type="button"
            class="qo-item"
            class:sel={i === sel}
            role="option"
            aria-selected={i === sel}
            onmousemove={() => { sel = i; }}
            onmousedown={(e) => { e.preventDefault(); onpick(item); }}
          >
            {#if item.icon}
              <img class="qo-icon" alt="" src={item.icon} />
            {:else}
              <span class="qo-glyph">{item.glyph ?? ''}</span>
            {/if}
            <span class="qo-name">
              {#each highlightSegments(item.label, term) as seg, si (si)}<span
                  class:hit={seg.hit}>{seg.text}</span>{/each}
            </span>
            {#if item.detail}<span class="qo-detail">{item.detail}</span>{/if}
          </button>
        {/each}
      </div>
    {:else if status}
      <div class="qo-status">{status}</div>
    {/if}
  </div>
{/if}

<style>
  .qo-scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .qo-modal {
    position: fixed;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    width: min(600px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    background: #232323;
    border: 1px solid #505050;
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    z-index: 61;
    overflow: hidden;
  }
  .qo-input {
    margin: 6px;
    box-sizing: border-box;
    background: #1e1e1e;
    border: 1px solid #e58520;
    border-radius: 3px;
    color: #c5c8c6;
    font-size: 13px;
    padding: 4px 8px;
  }
  .qo-input:focus { outline: none; }
  .qo-list {
    max-height: 44vh;
    overflow-y: auto;
    padding-bottom: 4px;
  }
  .qo-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: #c5c8c6;
    font-size: 13px;
    padding: 3px 12px;
    cursor: pointer;
    text-align: left;
  }
  .qo-item.sel { background: #04395e; }
  .qo-icon { width: 16px; height: 16px; flex: 0 0 16px; }
  .qo-glyph { width: 16px; flex: 0 0 16px; text-align: center; color: #949494; }
  .qo-name { white-space: nowrap; }
  /* Matched characters, VS Code's quick-open highlight blue. */
  .qo-name span.hit { color: #2aaaff; font-weight: 600; }
  .qo-detail {
    color: #949494;
    font-size: 12px;
    margin-left: auto;
    padding-left: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qo-status {
    color: #949494;
    font-size: 13px;
    padding: 6px 12px 10px;
  }
</style>
