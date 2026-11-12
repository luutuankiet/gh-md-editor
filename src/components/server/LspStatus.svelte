<script lang="ts">
  import {
    LSP_KINDS,
    fetchLspLog,
    fetchLspOffers,
    lspLanguageFor,
    restartLanguageServer,
    setLspKinds,
    startLanguageServer,
    stopLanguageServer,
    type LspOffer,
  } from '../../lib/lsp-control.svelte';

  // Root-relative path of the active code editor; '' when none.
  let { path }: { path: string } = $props();

  type Entry = {
    id: string;
    kind: string;
    label?: string;
    folder: string;
    pid: number | null;
    status?: 'starting' | 'waiting' | 'indexing' | 'ready' | 'stopping' | 'crashed' | 'stopped';
    state: string;
    progress?: { title: string; message: string; percentage: number | null } | null;
    exitCode?: number | null;
  };

  let servers = $state<Entry[]>([]);
  let menuOpen = $state(false);
  let error = $state('');
  let log = $state<{ id: string; title: string; text: string } | null>(null);

  async function refresh() {
    try {
      const r = await fetch('/api/lsp', { cache: 'no-store' });
      if (r.ok) {
        const d = (await r.json()) as { servers?: Entry[]; kinds?: unknown };
        servers = d.servers ?? [];
        // Keeps the PATH checks (shellcheck, gopls) current.
        setLspKinds(d.kinds);
      }
    } catch { /* keep the last list */ }
  }

  // The server serving `path`: same rule as the editor client (a kind that
  // serves the file, deepest folder wins), but a running server beats one
  // that has exited so a stale crashed entry never hides a fresh one.
  let current = $derived.by(() => {
    const lang = path ? lspLanguageFor(path) : null;
    if (!lang) return null;
    let best: Entry | null = null;
    const rank = (e: Entry) => (e.state === 'exited' ? 0 : 1);
    for (const s of servers) {
      if (!lang.kinds.includes(s.kind)) continue;
      const f = s.folder.replace(/^\/+|\/+$/g, '');
      if (f && path !== f && !path.startsWith(f + '/')) continue;
      if (!best || rank(s) > rank(best) || (rank(s) === rank(best) && f.length > best.folder.length)) best = s;
    }
    return best;
  });

  // Helpers the running server would use but cannot find.
  let missingTools = $derived.by(() => {
    const kind = current?.kind;
    if (!kind) return [];
    return (LSP_KINDS.find((k) => k.kind === kind)?.tools ?? []).filter((t) => !t.found);
  });

  // Nothing serves this file: what could. Asked once per file, and again
  // when a server stops.
  let offers = $state<LspOffer[]>([]);
  let hasCurrent = $derived(!!current);
  $effect(() => {
    const p = path;
    if (!p || hasCurrent || !lspLanguageFor(p)) {
      offers = [];
      return;
    }
    let live = true;
    void fetchLspOffers(p).then((o) => { if (live) offers = o; });
    return () => { live = false; };
  });

  let status = $derived(current?.status ?? (current?.state === 'exited' ? 'stopped' : current?.state ?? ''));
  let busyState = $derived(status === 'starting' || status === 'indexing' || status === 'stopping' || status === 'waiting');

  let progressText = $derived.by(() => {
    const p = current?.progress;
    if (!p || status !== 'indexing') return '';
    const pct = p.percentage != null ? ` ${Math.round(p.percentage)}%` : '';
    return `${p.title || p.message}${pct}`.trim();
  });

  $effect(() => {
    void refresh();
    const on = () => void refresh();
    window.addEventListener('gmd:lsp-changed', on);
    return () => window.removeEventListener('gmd:lsp-changed', on);
  });

  // Fast while something is moving, slow otherwise.
  $effect(() => {
    const t = setInterval(() => void refresh(), busyState ? 1500 : 10000);
    return () => clearInterval(t);
  });

  async function act(fn: () => Promise<string | null>) {
    menuOpen = false;
    error = '';
    const e = await fn();
    if (e) error = e;
    void refresh();
  }

  async function openLog(e: Entry) {
    menuOpen = false;
    log = { id: e.id, title: `${e.label ?? e.kind} log`, text: 'Loading…' };
    log.text = await fetchLspLog(e.id);
  }

  async function reloadLog() {
    if (!log) return;
    log.text = await fetchLspLog(log.id);
  }
</script>

{#if current}
  <button
    type="button"
    class="seg lsp st-{status}"
    title={error || `${current.label ?? current.kind} in ${current.folder || '(root)'}: ${status}${current.pid ? ` (pid ${current.pid})` : ''}`}
    onclick={() => (menuOpen = !menuOpen)}
  >
    <span class="dot" aria-hidden="true"></span>
    <span>{current.label ?? current.kind}: {status}{progressText ? ` · ${progressText}` : ''}</span>
    {#if missingTools.length}<span class="warn">no {missingTools.map((t) => t.bin).join(', ')}</span>{/if}
    {#if error}<span class="err">!</span>{/if}
  </button>
{:else if offers.length}
  <button
    type="button"
    class="seg lsp st-off"
    title={error || 'No language server for this file'}
    onclick={() => (menuOpen = !menuOpen)}
  >
    <span class="dot" aria-hidden="true"></span>
    <span>{offers.length === 1 ? offers[0].label : 'Language server'}: off</span>
    {#if error}<span class="err">!</span>{/if}
  </button>
{/if}

{#if menuOpen && !current && offers.length}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sb-scrim" onmousedown={() => (menuOpen = false)}></div>
  <div class="lsp-menu" role="menu" aria-label="Language server">
    <div class="lm-head">No language server for this file</div>
    {#each offers as o (o.kind)}
      {#if o.available}
        <button type="button" role="menuitem" title="Start in {o.folder || '(root)'}" onclick={() => void act(() => startLanguageServer(o.kind, o.folder))}>Start {o.label}</button>
      {:else}
        <div class="lm-note">{o.label} is not installed. Install it with:<code>{o.install}</code></div>
      {/if}
    {/each}
  </div>
{/if}

{#if menuOpen && current}
  {@const c = current}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sb-scrim" onmousedown={() => (menuOpen = false)}></div>
  <div class="lsp-menu" role="menu" aria-label="Language server">
    <div class="lm-head">{c.label ?? c.kind} · {c.folder || '(root)'}</div>
    <button type="button" role="menuitem" onclick={() => void act(() => restartLanguageServer(c.id))}>Restart</button>
    {#if c.state !== 'exited'}
      <button type="button" role="menuitem" title="Stop it and do not start it again for this workspace" onclick={() => void act(() => stopLanguageServer(c.id, true))}>Stop</button>
    {/if}
    <button type="button" role="menuitem" onclick={() => void openLog(c)}>Show Log</button>
    {#each missingTools as t (t.bin)}
      <div class="lm-note">{t.bin} is not on PATH: no {t.gives}. Install it ({t.install}) and restart.</div>
    {/each}
  </div>
{/if}

{#if log}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="log-scrim" onmousedown={() => (log = null)}></div>
  <div class="log" role="dialog" aria-label={log.title}>
    <div class="log-head">
      <span class="log-title">{log.title}</span>
      <button type="button" onclick={() => void reloadLog()}>Refresh</button>
      <button type="button" onclick={() => (log = null)}>Close</button>
    </div>
    <pre>{log.text || '(empty)'}</pre>
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
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #949494;
  }
  .st-ready .dot { background: #4ec27a; }
  .st-starting .dot, .st-waiting .dot, .st-indexing .dot, .st-stopping .dot { background: #e5c07b; }
  .st-crashed .dot { background: #e5534b; }
  .st-crashed { color: #e58520; }
  .err { color: #e5534b; font-weight: 600; }
  .warn { color: #e5c07b; }
  .lm-note {
    padding: 5px 10px;
    max-width: 340px;
    color: #c5c8c6;
    font-size: 11px;
    border-top: 1px solid #404040;
  }
  .lm-note code {
    display: block;
    margin-top: 3px;
    color: #e5c07b;
    user-select: all;
  }
  .sb-scrim, .log-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .log-scrim { background: rgba(0, 0, 0, 0.35); }
  .lsp-menu {
    position: fixed;
    right: 0;
    bottom: 22px;
    z-index: 41;
    min-width: 200px;
    background: #272727;
    border: 1px solid #505050;
    box-shadow: 0 -4px 14px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    padding: 4px 0;
  }
  .lm-head {
    padding: 4px 10px 6px;
    color: #949494;
    font-size: 11px;
    border-bottom: 1px solid #404040;
    margin-bottom: 4px;
  }
  .lsp-menu button {
    padding: 5px 10px;
    border: 0;
    background: transparent;
    color: #c5c8c6;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .lsp-menu button:hover { background: #3a3a3a; }
  .log {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 41;
    width: min(900px, 92vw);
    height: min(600px, 80vh);
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    border: 1px solid #505050;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    user-select: text;
  }
  .log-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid #404040;
    font-size: 12px;
  }
  .log-title { flex: 1 1 auto; }
  .log-head button {
    padding: 2px 10px;
    border: 1px solid #505050;
    background: #2d2d2d;
    color: #c5c8c6;
    font: inherit;
    cursor: pointer;
  }
  .log pre {
    flex: 1 1 auto;
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    font-size: 11px;
    line-height: 1.45;
    color: #c5c8c6;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
