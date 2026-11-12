<script lang="ts">
  import { currentWorkspace } from '../../lib/lsp-control.svelte';

  // Root-relative path of the active code editor; '' when none.
  let { path }: { path: string } = $props();

  type Candidate = { path: string; display: string; version: string; name: string; kind: string; label: string };
  type View = {
    selected: string | null;
    auto: boolean;
    current: Candidate | null;
    candidates: Candidate[];
    warning: string | null;
  };

  let isPython = $derived(/\.pyi?$/i.test(path));
  let view = $state<View | null>(null);
  let open = $state(false);
  let mode = $state<'list' | 'path'>('list');
  let query = $state('');
  let active = $state(0);
  let error = $state('');
  let busy = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  async function load() {
    try {
      const r = await fetch(`/api/python/interpreters?workspace=${encodeURIComponent(currentWorkspace())}`, { cache: 'no-store' });
      if (r.ok) view = (await r.json()) as View;
    } catch { /* keep the last view */ }
  }

  // Reloaded whenever a Python file becomes active and when the picker opens,
  // so a config file that starts overriding the choice shows up without a reload.
  $effect(() => {
    if (isPython && path) void load();
  });

  type Item = { kind: 'candidate'; c: Candidate } | { kind: 'enter' } | { kind: 'clear' };

  let items = $derived.by((): Item[] => {
    const q = query.trim().toLowerCase();
    const list: Item[] = (view?.candidates ?? [])
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.display.toLowerCase().includes(q))
      .map((c) => ({ kind: 'candidate', c }));
    if (view?.selected) list.push({ kind: 'clear' });
    list.push({ kind: 'enter' });
    return list;
  });

  function show() {
    open = true;
    mode = 'list';
    query = '';
    error = '';
    active = Math.max(0, (view?.candidates ?? []).findIndex((c) => c.path === view?.current?.path));
    void load();
    queueMicrotask(() => input?.focus());
  }

  function close() {
    open = false;
  }

  async function choose(p: string | null) {
    busy = true;
    error = '';
    try {
      const r = await fetch('/api/python/interpreter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: currentWorkspace(), path: p }),
      });
      const j = await r.json();
      if (!r.ok) {
        error = j.error ?? `HTTP ${r.status}`;
        return;
      }
      view = j as View;
      open = false;
      window.dispatchEvent(new CustomEvent('gmd:lsp-changed'));
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function pick(it: Item) {
    if (it.kind === 'candidate') void choose(it.c.path);
    else if (it.kind === 'clear') void choose(null);
    else {
      mode = 'path';
      query = '';
      error = '';
      queueMicrotask(() => input?.focus());
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (mode === 'path') { mode = 'list'; query = ''; error = ''; } else close();
      return;
    }
    if (mode === 'path') {
      if (e.key === 'Enter' && query.trim()) { e.preventDefault(); void choose(query.trim()); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[active]; if (it) pick(it); }
  }

  $effect(() => {
    void query;
    if (mode === 'list' && active >= items.length) active = Math.max(0, items.length - 1);
  });

  let statusText = $derived(view?.current ? view.current.label : 'Select Interpreter');
  let statusTitle = $derived(
    (view?.warning ? `Warning: ${view.warning}\n` : '') +
      (view?.current
        ? `${view.current.display}${view.auto ? '\nNot chosen: the language server finds this one by itself' : ''}`
        : 'Choose the Python interpreter the language server analyses against'),
  );
</script>

{#if isPython && view}
  <button type="button" class="seg py" class:warn={!!view.warning} title={statusTitle} onclick={show}>
    {#if view.warning}<span class="warn-icon" aria-hidden="true">⚠</span>{/if}
    <span>{statusText}</span>
  </button>
{/if}

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onmousedown={close}></div>
  <div class="pick" role="dialog" aria-label="Select Python interpreter">
    <input
      bind:this={input}
      bind:value={query}
      onkeydown={onKey}
      placeholder={mode === 'path'
        ? 'Path to a Python interpreter or a venv folder, then Enter'
        : `Select Interpreter (current: ${view?.current?.label ?? 'none'})`}
      spellcheck="false"
      autocomplete="off"
      disabled={busy}
    />
    {#if view?.warning}
      <div class="banner">⚠ {view.warning}</div>
    {/if}
    {#if error}<div class="banner err">{error}</div>{/if}
    {#if mode === 'list'}
      <div class="list" role="listbox">
        {#each items as it, i (it.kind === 'candidate' ? it.c.path : it.kind)}
          <button
            type="button"
            role="option"
            aria-selected={i === active}
            class="row"
            class:active={i === active}
            onmousemove={() => (active = i)}
            onclick={() => pick(it)}
          >
            {#if it.kind === 'candidate'}
              <span class="mark">{view?.current?.path === it.c.path ? (view?.auto ? '○' : '✓') : ''}</span>
              <span class="label">{it.c.label}</span>
              <span class="detail">{it.c.display}</span>
            {:else if it.kind === 'clear'}
              <span class="mark"></span>
              <span class="label">Use the language server's own default</span>
            {:else}
              <span class="mark">+</span>
              <span class="label">Enter interpreter path…</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .seg {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: #c5c8c6;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .seg:hover { background: #3a3a3a; }
  .warn { color: #e5c07b; }
  .warn-icon { color: #e5c07b; }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .pick {
    position: fixed;
    top: 40px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 41;
    width: min(640px, 92vw);
    background: #252526;
    border: 1px solid #505050;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pick input {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    border: 1px solid #0e639c;
    background: #3c3c3c;
    color: #e0e0e0;
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .banner {
    padding: 5px 8px;
    font-size: 12px;
    color: #e5c07b;
    background: rgba(229, 192, 123, 0.08);
    border-left: 2px solid #e5c07b;
  }
  .banner.err { color: #e5534b; border-left-color: #e5534b; background: rgba(229, 83, 75, 0.08); }
  .list {
    max-height: 50vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 8px;
    border: 0;
    background: transparent;
    color: #c5c8c6;
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .row.active { background: #04395e; color: #fff; }
  .mark { width: 12px; flex: 0 0 auto; color: #4ec27a; }
  .label { flex: 0 0 auto; }
  .detail {
    flex: 1 1 auto;
    min-width: 0;
    color: #8a8a8a;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
