<script lang="ts">
  let { visible }: { visible: boolean } = $props();

  let detected = $state<number[]>([]);
  let manual = $state<number[]>([]);
  let input = $state('');
  let error = $state('');
  let copied = $state(0);

  let ports = $derived([...new Set([...detected, ...manual])].sort((a, b) => a - b));

  async function refresh() {
    try {
      const r = await fetch('/api/ports');
      const d = await r.json();
      detected = d.ports ?? [];
    } catch { /* keep last list */ }
  }

  // Refresh when the panel becomes visible — cheap /proc parse, no polling.
  $effect(() => { if (visible) void refresh(); });

  function urlFor(p: number): string {
    return `${location.origin}/proxy/${p}/`;
  }

  function add() {
    const p = Number(input.trim());
    if (!Number.isInteger(p) || p < 1 || p > 65535) { error = 'enter a port between 1 and 65535'; return; }
    error = '';
    if (!manual.includes(p)) manual = [...manual, p];
    input = '';
  }

  async function copy(p: number) {
    try {
      await navigator.clipboard.writeText(urlFor(p));
      copied = p;
      setTimeout(() => { if (copied === p) copied = 0; }, 1200);
    } catch { /* clipboard denied — the link itself is still there */ }
  }
</script>

<div class="ports">
  <div class="bar">
    <input
      placeholder="Forward a port…"
      bind:value={input}
      onkeydown={(e) => { if (e.key === 'Enter') add(); }}
    />
    <button type="button" onclick={add}>Add</button>
    <button type="button" class="ghost" onclick={() => void refresh()}>Refresh</button>
    {#if error}<span class="err">{error}</span>{/if}
  </div>
  {#if !ports.length}
    <div class="empty">No listening ports detected. Start something in the terminal, or add a port manually.</div>
  {:else}
    <div class="list">
      {#each ports as p (p)}
        <div class="portrow">
          <span class="pnum">{p}</span>
          <a class="purl" href={urlFor(p)} target="_blank" rel="noreferrer">{urlFor(p)}</a>
          <span class="spacer"></span>
          <button type="button" onclick={() => void copy(p)}>{copied === p ? 'Copied' : 'Copy URL'}</button>
          <a class="btnlike" href={urlFor(p)} target="_blank" rel="noreferrer">Open</a>
        </div>
      {/each}
    </div>
    <div class="hint">Forwarded through this server at /proxy/&lt;port&gt;/ (HTTP + WebSocket). Apps that hardcode absolute paths may need their base path set.</div>
  {/if}
</div>

<style>
  .ports {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #0d1117;
    color: #c9d1d9;
    font-size: 12px;
  }
  .bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid #30363d;
  }
  .bar input {
    width: 140px;
    background: #010409;
    border: 1px solid #30363d;
    border-radius: 4px;
    color: #c9d1d9;
    font-size: 12px;
    padding: 2px 8px;
  }
  .bar input:focus { outline: none; border-color: #58a6ff; }
  .bar button, .btnlike {
    border: 1px solid #30363d;
    background: #21262d;
    color: #c9d1d9;
    border-radius: 4px;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
    text-decoration: none;
  }
  .bar button:hover, .btnlike:hover { background: #30363d; }
  .bar button.ghost { background: transparent; }
  .err { color: #f28b82; }
  .list {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding: 4px 0;
  }
  .portrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 10px;
  }
  .portrow:hover { background: rgba(56, 139, 253, 0.08); }
  .pnum {
    flex: 0 0 48px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    color: #79c0ff;
  }
  .purl {
    color: #8b949e;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .purl:hover { color: #58a6ff; text-decoration: underline; }
  .spacer { flex: 1 1 0; }
  .portrow button {
    border: 1px solid #30363d;
    background: transparent;
    color: #8b949e;
    border-radius: 4px;
    font-size: 11px;
    padding: 1px 8px;
    cursor: pointer;
  }
  .portrow button:hover { color: #c9d1d9; background: #21262d; }
  .empty {
    padding: 20px;
    text-align: center;
    color: #8b949e;
  }
  .hint {
    flex: 0 0 auto;
    padding: 4px 10px 6px;
    color: #6e7681;
    font-size: 11px;
  }
</style>
