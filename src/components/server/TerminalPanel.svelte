<script lang="ts">
  import TerminalView from './TerminalView.svelte';

  // Multi-terminal container, VS Code integrated-terminal model: the server
  // owns N shell sessions, this panel lists them, spawns, kills and switches.
  // Every session's xterm stays mounted (CSS-hidden) so switching costs
  // nothing and running output keeps streaming in the background.
  let { visible = true }: { visible?: boolean } = $props();

  // Shells start in the workspace the session is anchored to, not the server's
  // launch directory — same anchor the explorer and git panel read.
  const folder = new URLSearchParams(location.search).get('folder') ?? '';

  type Term = { id: string; title: string; pid: number; cwd?: string };

  let terms = $state<Term[]>([]);
  let activeId = $state<string | null>(null);
  let error = $state<string | null>(null);
  let booted = $state(false);

  const leafOf = (p: string) => {
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i === -1 ? t : t.slice(i + 1);
  };

  // Grouped by the directory each shell was spawned in. With several windows
  // open on different workspaces, a flat list is exactly how a command lands
  // in the wrong repo — so any group that is not this window's anchor starts
  // folded, and the anchored one starts open.
  const groups = $derived.by(() => {
    const by = new Map<string, Term[]>();
    for (const t of terms) {
      const k = t.cwd ?? '';
      const g = by.get(k);
      if (g) g.push(t);
      else by.set(k, [t]);
    }
    return [...by].map(([cwd, items]) => ({ cwd, items, mine: cwd === folder }));
  });
  let folded = $state<Record<string, boolean>>({});
  const isFolded = (cwd: string, mine: boolean) => folded[cwd] ?? !mine;

  const RAIL_KEY = 'ghmd.termRail';
  const storedRail = typeof localStorage !== 'undefined' ? localStorage.getItem(RAIL_KEY) : null;
  let railW = $state(storedRail !== null && Number.isFinite(+storedRail) ? Math.min(420, Math.max(0, +storedRail)) : 168);
  let railPrev = 168;
  function persistRail() {
    try { localStorage.setItem(RAIL_KEY, String(railW)); } catch { /* private mode */ }
  }
  function toggleRail() {
    if (railW > 0) { railPrev = railW; railW = 0; } else railW = railPrev || 168;
    persistRail();
  }
  // Pointer capture rather than window listeners: the cursor leaves the 4px
  // handle on the very first move, and without capture the drag would end
  // there. Width is measured from the container's right edge so the handle
  // stays under the pointer regardless of where the panel sits.
  function startDrag(e: PointerEvent) {
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const box = bar.parentElement?.getBoundingClientRect();
      if (!box) return;
      const raw = Math.min(420, Math.max(0, box.right - ev.clientX));
      // Magnets, because a free-running rail settles on widths nobody wants:
      // anything narrower than a readable name collapses, and the default
      // width re-attracts so a nudged rail can be restored by feel.
      railW = raw < 48 ? 0 : Math.abs(raw - 168) < 24 ? 168 : Math.round(raw);
    };
    const up = (ev: PointerEvent) => {
      bar.releasePointerCapture(ev.pointerId);
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      persistRail();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  }

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

  async function spawn(cwd?: string) {
    try {
      error = null;
      const target = cwd ?? folder;
      const t = await api(`/api/terminals${target ? `?cwd=${encodeURIComponent(target)}` : ''}`, { method: 'POST' });
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
    // "Open new terminal here" rides the same event with a cwd detail.
    const onNew = (e: Event) => spawn((e as CustomEvent).detail?.cwd);
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
        <!-- A clean exit closes the tab, the way a terminal emulator does.
             Anything else — a nonzero status, a signal, a dropped socket —
             keeps it, so the failure and the output around it stay readable. -->
        <TerminalView id={t.id} visible={visible && t.id === activeId} onexit={(code, signal) => { if (code === 0 && !signal) drop(t.id); }} />
      {/each}
      {#if terms.length === 0 && booted}
        <div class="tempty">
          <span>{error ?? 'no terminal sessions'}</span>
          <button type="button" onclick={() => spawn()}>New Terminal</button>
        </div>
      {/if}
    </div>

    {#if terms.length > 1}
      <div
        class="trail-grip"
        role="separator"
        aria-label="Resize terminal list — double-click to collapse"
        aria-orientation="vertical"
        tabindex="-1"
        onpointerdown={startDrag}
        ondblclick={toggleRail}
      ></div>
      <ul class="tlist" class:collapsed={railW === 0} style="width: {railW}px">
        {#each groups as g (g.cwd)}
          <li class="tgroup">
            <button
              type="button"
              class="tgroup-head"
              title={g.cwd || 'server root'}
              onclick={() => (folded[g.cwd] = !isFolded(g.cwd, g.mine))}
            >
              <span class="tgroup-chev" class:open={!isFolded(g.cwd, g.mine)}>▸</span>
              <span class="tgroup-name">{leafOf(g.cwd) || 'root'}</span>
              <span class="tgroup-count">{g.items.length}</span>
            </button>
            {#if !isFolded(g.cwd, g.mine)}
              <ul class="tgroup-body">
                {#each g.items as t (t.id)}
                  <li>
                    <button
                      type="button"
                      class="tlist-row"
                      class:active={t.id === activeId}
                      onclick={() => { activeId = t.id; }}
                    >
                      <svg class="tlist-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v11H2zm2.2 2.6 2.2 2.4-2.2 2.4.9.8 3-3.2-3-3.2zM8.4 10.2h4v1.2h-4z" /></svg>
                      <span class="tlist-name">{terms.indexOf(t) + 1}: {t.title}</span>
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
    color: #949494;
  }
  .tbar-sub {
    font-size: 11px;
    color: #8a8a8a;
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
    color: #949494;
    cursor: pointer;
  }
  .tbar-btn:hover:not(:disabled) {
    background: #353535;
    color: #c5c8c6;
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
    color: #949494;
  }
  .tempty button {
    background: #353535;
    color: #c5c8c6;
    border: 1px solid #404040;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .tempty button:hover {
    border-color: #e58520;
  }
  /* 4px of grab area with no visual weight until hovered. touch-action has to
     be none or a touch drag scrolls the panel instead of resizing it. */
  .trail-grip {
    flex: 0 0 auto;
    width: 4px;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
  }
  .trail-grip:hover { background: #e58520; }
  .tgroup { list-style: none; }
  .tgroup-head {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 2px 6px;
    border: none;
    background: transparent;
    color: #8a8a8a;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .tgroup-head:hover { background: #272727; }
  .tgroup-chev {
    flex: 0 0 auto;
    width: 10px;
    display: inline-block;
    transition: transform 0.1s linear;
  }
  .tgroup-chev.open { transform: rotate(90deg); }
  .tgroup-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tgroup-count {
    flex: 0 0 auto;
    padding: 0 5px;
    border-radius: 8px;
    background: #353535;
    color: #949494;
    font-size: 10px;
    line-height: 14px;
  }
  .tgroup-body {
    margin: 0;
    padding: 0 0 2px;
    list-style: none;
  }
  .tlist.collapsed { border-left: none; }
  .tlist {
    flex: 0 0 auto;
    width: 168px;
    margin: 0;
    padding: 2px 0;
    list-style: none;
    overflow-y: auto;
    border-left: 1px solid #404040;
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
    color: #949494;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .tlist-row:hover {
    background: #272727;
  }
  .tlist-row.active {
    background: #232323;
    border-left-color: #e58520;
    color: #c5c8c6;
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
    background: #404040;
    opacity: 1;
  }
</style>
