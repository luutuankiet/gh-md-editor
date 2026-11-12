<script lang="ts">
  import { LSP_KINDS, startLanguageServer, type LspKind } from '../../lib/lsp-control';

  let { visible, folder }: { visible: boolean; folder: string } = $props();

  type Entry = {
    id: string;
    kind: string;
    language: string;
    folder: string;
    pid: number | null;
    rssMB: number | null;
    state: 'starting' | 'running' | 'exited';
    resolvedVia: string;
    command: string;
    exitCode?: number | null;
  };

  let servers = $state<Entry[]>([]);
  let error = $state('');
  let busy = $state('');
  let kind = $state<LspKind>('tsgo');

  async function refresh() {
    try {
      const r = await fetch('/api/lsp', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      servers = d.servers ?? [];
    } catch { /* keep the last list */ }
  }

  // Fetch once, and again whenever anything (palette, this panel) starts or
  // stops a server.
  $effect(() => {
    void refresh();
    const on = () => void refresh();
    window.addEventListener('gmd:lsp-changed', on);
    return () => window.removeEventListener('gmd:lsp-changed', on);
  });

  // Memory and state only move while a server runs, so poll only while shown.
  $effect(() => {
    if (!visible) return;
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  });

  async function start() {
    busy = 'start';
    error = '';
    try {
      const e = await startLanguageServer(kind, folder);
      if (e) error = e;
    } finally {
      busy = '';
    }
  }

  async function stop(id: string) {
    busy = id;
    error = '';
    try {
      const r = await fetch(`/api/lsp?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) error = `stop failed: HTTP ${r.status}`;
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      busy = '';
      window.dispatchEvent(new CustomEvent('gmd:lsp-changed'));
    }
  }
</script>

<div class="lsp">
  <div class="bar">
    <select bind:value={kind} title="Language server">
      {#each LSP_KINDS as k (k.kind)}<option value={k.kind}>{k.label}</option>{/each}
    </select>
    <span class="in">in <code>{folder || '(served root)'}</code></span>
    <button type="button" disabled={busy === 'start'} onclick={() => void start()}>{busy === 'start' ? 'Starting…' : 'Start'}</button>
    <button type="button" class="ghost" onclick={() => void refresh()}>Refresh</button>
    {#if error}<span class="err">{error}</span>{/if}
  </div>
  {#if !servers.length}
    <div class="empty">No language servers running. Start one here or with the palette command "Start Language Server…". Nothing starts on its own.</div>
  {:else}
    <div class="list">
      <div class="row head">
        <span class="c-folder">Folder</span>
        <span class="c-lang">Language</span>
        <span class="c-kind">Server</span>
        <span class="c-via">Found via</span>
        <span class="c-mem">Memory</span>
        <span class="c-state">State</span>
        <span class="spacer"></span>
      </div>
      {#each servers as s (s.id)}
        <div class="row" title={s.command}>
          <span class="c-folder">{s.folder || '(root)'}</span>
          <span class="c-lang">{s.language}</span>
          <span class="c-kind">{s.kind}</span>
          <span class="c-via">{s.resolvedVia}</span>
          <span class="c-mem">{s.rssMB != null ? `${s.rssMB} MB` : '-'}</span>
          <span class="c-state st-{s.state}">{s.state}{s.state === 'exited' && s.exitCode != null ? ` (${s.exitCode})` : ''}</span>
          <span class="spacer"></span>
          <button type="button" disabled={busy === s.id} onclick={() => void stop(s.id)}>{s.state === 'exited' ? 'Remove' : 'Stop'}</button>
        </div>
      {/each}
    </div>
    <div class="hint">One server per language and folder, shared by every editor tab. A server keeps running when its tabs close; stop it here.</div>
  {/if}
</div>

<style>
  .lsp {
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
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid #404040;
  }
  .bar select {
    background: #1e1e1e;
    border: 1px solid #404040;
    border-radius: 4px;
    color: #c5c8c6;
    font-size: 12px;
    padding: 1px 4px;
  }
  .in { color: #949494; }
  .in code { color: #c5c8c6; font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  .bar button {
    border: 1px solid #404040;
    background: #353535;
    color: #c5c8c6;
    border-radius: 4px;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .bar button:hover { background: #404040; }
  .bar button.ghost { background: transparent; }
  .err { color: #f28b82; }
  .list {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding: 4px 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 10px;
  }
  .row:hover:not(.head) { background: rgba(255, 255, 255, 0.05); }
  .row.head { color: #8a8a8a; font-size: 11px; }
  .c-folder {
    flex: 0 1 220px;
    min-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    color: #79c0ff;
  }
  .row.head .c-folder { font-family: inherit; color: inherit; }
  .c-lang { flex: 0 0 80px; }
  .c-kind { flex: 0 0 90px; }
  .c-via { flex: 0 0 90px; color: #949494; }
  .c-mem { flex: 0 0 70px; text-align: right; }
  .c-state { flex: 0 0 80px; }
  .st-running { color: #81c995; }
  .st-starting { color: #e5c07b; }
  .st-exited { color: #f28b82; }
  .spacer { flex: 1 1 0; }
  .row button {
    border: 1px solid #404040;
    background: transparent;
    color: #949494;
    border-radius: 4px;
    font-size: 11px;
    padding: 1px 8px;
    cursor: pointer;
  }
  .row button:hover { color: #c5c8c6; background: #353535; }
  .empty {
    padding: 20px;
    text-align: center;
    color: #949494;
  }
  .hint {
    flex: 0 0 auto;
    padding: 4px 10px 6px;
    color: #8a8a8a;
    font-size: 11px;
  }
</style>
