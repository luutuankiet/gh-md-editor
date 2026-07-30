<script lang="ts">
  import TerminalView from './TerminalView.svelte';

  // Multi-terminal container, VS Code integrated-terminal model: the server
  // owns N shell sessions, this panel lists them, spawns, kills and switches.
  // Every session's xterm stays mounted (CSS-hidden) so switching costs
  // nothing and running output keeps streaming in the background.
  let { visible = true }: { visible?: boolean } = $props();

  type Term = { id: string; title: string; pid: number };

  let terms = $state<Term[]>([]);
  let activeId = $state<string | null>(null);
  let error = $state<string | null>(null);
  let booted = $state(false);

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(path, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  }

  // Adopt whatever the server already has (survives a browser reload), and
  // only spawn when there is genuinely nothing to attach to.
  async function boot() {
    try {
      const { terminals } = await api('/api/terminals');
      terms = terminals ?? [];
      if (terms.length === 0) await spawn();
      else activeId = terms[0].id;
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      booted = true;
    }
  }

  async function spawn() {
    try {
      error = null;
      const t = await api('/api/terminals', { method: 'POST' });
      terms = [...terms, t];
      activeId = t.id;
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
  }

  async function kill(id: string) {
    try {
      await api(`/api/terminals?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // Already gone server-side — drop it locally either way.
    }
    drop(id);
  }

  // Shell exited on its own, or was killed: remove the tab and fall back to a
  // neighbour. Deliberately no auto-respawn — a shell that dies instantly
  // would otherwise spin forever.
  function drop(id: string) {
    const idx = terms.findIndex((t) => t.id === id);
    if (idx === -1) return;
    terms = terms.filter((t) => t.id !== id);
    if (activeId === id) activeId = terms[Math.min(idx, terms.length - 1)]?.id ?? null;
  }

  $effect(() => {
    if (!booted) boot();
  });

  // Ctrl/Cmd+Shift+` — new terminal, VS Code's binding. Dispatched by the app
  // shell so it can reveal the panel first.
  $effect(() => {
    const onNew = () => spawn();
    window.addEventListener('gmd:new-terminal', onNew);
    return () => window.removeEventListener('gmd:new-terminal', onNew);
  });
</script>

<div class="tpanel">
  <div class="tbar">
    <span class="tbar-label">Terminal</span>
    {#if terms.length > 0}
      <span class="tbar-sub">{terms.length} session{terms.length === 1 ? '' : 's'}</span>
    {/if}
    <span class="tbar-gap"></span>
    <button type="button" class="tbar-btn" title="New terminal (Ctrl+Shift+`)" onclick={() => spawn()}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.25 2.75h1.5v4.5h4.5v1.5h-4.5v4.5h-1.5v-4.5h-4.5v-1.5h4.5z" /></svg>
    </button>
    <button
      type="button"
      class="tbar-btn"
      title="Kill active terminal"
      disabled={!activeId}
      onclick={() => activeId && kill(activeId)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 1.5h3l.5 1h3v1.5H3V2.5h3zM4 5h8l-.6 9.5H4.6zm2.2 1.5.3 6.5h1l-.3-6.5zm3.6 0-.3 6.5h1l.3-6.5z" /></svg>
    </button>
  </div>

  <div class="tbody">
    <div class="tviews">
      {#each terms as t (t.id)}
        <TerminalView id={t.id} visible={visible && t.id === activeId} onexit={() => drop(t.id)} />
      {/each}
      {#if terms.length === 0 && booted}
        <div class="tempty">
          <span>{error ?? 'no terminal sessions'}</span>
          <button type="button" onclick={() => spawn()}>New Terminal</button>
        </div>
      {/if}
    </div>

    {#if terms.length > 1}
      <ul class="tlist">
        {#each terms as t, i (t.id)}
          <li>
            <button
              type="button"
              class="tlist-row"
              class:active={t.id === activeId}
              onclick={() => { activeId = t.id; }}
            >
              <svg class="tlist-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v11H2zm2.2 2.6 2.2 2.4-2.2 2.4.9.8 3-3.2-3-3.2zM8.4 10.2h4v1.2h-4z" /></svg>
              <span class="tlist-name">{i + 1}: {t.title}</span>
              <span
                class="tlist-kill"
                title="Kill terminal"
                role="button"
                tabindex="-1"
                onclick={(e) => { e.stopPropagation(); kill(t.id); }}
                onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); kill(t.id); } }}
              >×</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .tpanel {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 3px 12px;
  }
  .tbar-label {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8b949e;
  }
  .tbar-sub {
    font-size: 11px;
    color: #6e7681;
  }
  .tbar-gap {
    flex: 1 1 auto;
  }
  .tbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: #8b949e;
    cursor: pointer;
  }
  .tbar-btn:hover:not(:disabled) {
    background: #21262d;
    color: #c9d1d9;
  }
  .tbar-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .tbar-btn svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
  }
  .tbody {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
  }
  .tviews {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    /* xterm rounds rows up, so the canvas can overhang the panel by a few
       pixels — clip it instead of letting it paint past the bottom edge. */
    overflow: hidden;
  }
  .tempty {
    position: absolute;
    inset: 0;
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: #8b949e;
  }
  .tempty button {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .tempty button:hover {
    border-color: #58a6ff;
  }
  .tlist {
    flex: 0 0 auto;
    width: 168px;
    margin: 0;
    padding: 2px 0;
    list-style: none;
    overflow-y: auto;
    border-left: 1px solid #30363d;
  }
  .tlist-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 6px 3px 10px;
    border: none;
    border-left: 2px solid transparent;
    background: transparent;
    color: #8b949e;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .tlist-row:hover {
    background: #161b22;
  }
  .tlist-row.active {
    background: #1f242c;
    border-left-color: #58a6ff;
    color: #c9d1d9;
  }
  .tlist-icon {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    fill: currentColor;
    opacity: 0.8;
  }
  .tlist-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tlist-kill {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    line-height: 15px;
    text-align: center;
    border-radius: 4px;
    opacity: 0;
    font-size: 14px;
  }
  .tlist-row:hover .tlist-kill,
  .tlist-row.active .tlist-kill {
    opacity: 0.7;
  }
  .tlist-kill:hover {
    background: #30363d;
    opacity: 1;
  }
</style>
