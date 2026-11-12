<script lang="ts">
  // Every diagnostic every language server has reported, open file or not,
  // grouped by file. Reads the same store the squiggles and explorer read.
  import { problems, totals, type LspDiagnostic } from '../../lib/lsp/diag-store.svelte';

  let { visible }: { visible: boolean } = $props();

  let filter = $state('');
  let collapsed = $state(new Set<string>());
  let selected = $state(-1);
  let listEl = $state<HTMLDivElement | null>(null);
  let filterEl = $state<HTMLInputElement | null>(null);

  type Row =
    | { kind: 'file'; path: string; count: number; worst: number }
    | { kind: 'item'; path: string; d: LspDiagnostic };

  const sevName = (s: number) => (s === 1 ? 'error' : s === 2 ? 'warning' : 'info');

  let rows = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const out: Row[] = [];
    const paths = Object.keys(problems.byPath).sort((a, b) => {
      const fa = problems.byPath[a], fb = problems.byPath[b];
      // Files with errors first, then warnings, then by path.
      return (fb.errors ? 2 : fb.warnings ? 1 : 0) - (fa.errors ? 2 : fa.warnings ? 1 : 0) || a.localeCompare(b);
    });
    for (const path of paths) {
      const f = problems.byPath[path];
      const pathHit = !q || path.toLowerCase().includes(q);
      const items = f.items.filter(({ d }) => pathHit
        || d.message.toLowerCase().includes(q)
        || String(d.code ?? '').toLowerCase().includes(q)
        || (d.source ?? '').toLowerCase().includes(q));
      if (!items.length) continue;
      out.push({ kind: 'file', path, count: items.length, worst: f.errors ? 1 : f.warnings ? 2 : 3 });
      if (collapsed.has(path)) continue;
      for (const { d } of items) out.push({ kind: 'item', path, d });
    }
    return out;
  });

  let t = $derived(totals());

  $effect(() => {
    // Keep the selection on a real row as the list changes underneath it.
    if (selected >= rows.length) selected = rows.length - 1;
  });

  // Opening the panel from the status bar lands in the filter box.
  $effect(() => { if (visible) queueMicrotask(() => filterEl?.focus()); });

  function toggle(path: string) {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path); else next.add(path);
    collapsed = next;
  }

  function activate(i: number) {
    const r = rows[i];
    if (!r) return;
    selected = i;
    if (r.kind === 'file') return toggle(r.path);
    window.dispatchEvent(new CustomEvent('gmd:open-request', {
      detail: { kind: 'file', path: r.path, line: r.d.range.start.line + 1 },
    }));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') selected = Math.min(rows.length - 1, selected + 1);
    else if (e.key === 'ArrowUp') selected = Math.max(0, selected - 1);
    else if (e.key === 'Enter') activate(selected < 0 ? rows.findIndex((r) => r.kind === 'item') : selected);
    else return;
    e.preventDefault();
    queueMicrotask(() => listEl?.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' }));
  }

  const leaf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="problems" onkeydown={onKey}>
  <div class="bar">
    <input bind:this={filterEl} bind:value={filter} placeholder="Filter (text, path, code)" spellcheck="false" />
    <span class="sum"><span class="e">{t.errors} errors</span> <span class="w">{t.warnings} warnings</span> <span class="i">{t.infos} infos</span></span>
  </div>
  {#if !rows.length}
    <div class="empty">{filter ? 'No problems match the filter.' : 'No problems have been detected in the workspace.'}</div>
  {:else}
    <div class="list" bind:this={listEl} tabindex="0" role="listbox" aria-label="Problems">
      {#each rows as r, i (r.kind === 'file' ? `f:${r.path}` : `i:${r.path}:${i}`)}
        {#if r.kind === 'file'}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div class="row file" class:sel={i === selected} role="option" tabindex="-1" aria-selected={i === selected} onclick={() => activate(i)}>
            <span class="twisty">{collapsed.has(r.path) ? '▸' : '▾'}</span>
            <span class="name sev-{sevName(r.worst)}">{leaf(r.path)}</span>
            <span class="dir">{dir(r.path)}</span>
            <span class="count">{r.count}</span>
          </div>
        {:else}
          {@const s = r.d.severity ?? 1}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div class="row item" class:sel={i === selected} role="option" tabindex="-1" aria-selected={i === selected} onclick={() => activate(i)} title={r.d.message}>
            <span class="dot sev-{sevName(s)}" aria-label={sevName(s)}>{s === 1 ? '✕' : s === 2 ? '⚠' : 'ℹ'}</span>
            <span class="msg">{r.d.message.split('\n')[0]}</span>
            <span class="src">{r.d.source ?? ''}{r.d.code != null ? `(${r.d.code})` : ''}</span>
            <span class="pos">[Ln {r.d.range.start.line + 1}, Col {r.d.range.start.character + 1}]</span>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .problems {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    color: #c5c8c6;
    font-size: 12px;
  }
  .bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #404040;
  }
  .bar input {
    width: 240px;
    background: #1e1e1e;
    border: 1px solid #404040;
    border-radius: 4px;
    color: #c5c8c6;
    font-size: 12px;
    padding: 2px 8px;
  }
  .bar input:focus { outline: none; border-color: #e58520; }
  .sum { display: flex; gap: 10px; color: #9a9a9a; }
  .sum .e { color: #f14c4c; }
  .sum .w { color: #cca700; }
  .sum .i { color: #3794ff; }
  .empty { padding: 10px; color: #9a9a9a; }
  .list { flex: 1 1 0; min-height: 0; overflow: auto; padding: 2px 0; outline: none; }
  .row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 1px 10px;
    white-space: nowrap;
    cursor: pointer;
    line-height: 20px;
  }
  .row:hover { background: #2a2d2e; }
  .row.sel { background: #04395e; }
  .row.item { padding-left: 28px; }
  .twisty { width: 10px; color: #9a9a9a; }
  .name { font-weight: 600; }
  .dir, .src, .pos { color: #8a8a8a; }
  .count {
    margin-left: 4px;
    background: #4d4d4d;
    color: #e0e0e0;
    border-radius: 9px;
    padding: 0 6px;
    font-size: 11px;
    line-height: 16px;
  }
  .msg { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
  .dot { width: 12px; text-align: center; }
  .sev-error { color: #f14c4c; }
  .sev-warning { color: #cca700; }
  .sev-info { color: #3794ff; }
</style>
