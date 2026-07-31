<script lang="ts">
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';

  // One xterm bound to one server-side pty session. The component stays
  // mounted while hidden so the viewport, scrollback and selection survive a
  // tab switch; only an explicit kill tears it down.
  let {
    id,
    visible = true,
    onexit,
  }: {
    id: string;
    visible?: boolean;
    onexit?: (code: number | null) => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let status = $state<'connecting' | 'live' | 'gone'>('connecting');

  let term: Terminal | null = null;
  let fit: FitAddon | null = null;

  export function focus() {
    term?.focus();
  }

  $effect(() => {
    if (!root) return;
    const sessionId = id;

    const t = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#c5c8c6',
        cursor: '#e58520',
        selectionBackground: 'rgba(229, 133, 32, 0.45)',
      },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(root);
    f.fit();
    term = t;
    fit = f;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/pty?id=${encodeURIComponent(sessionId)}`);
    ws.onopen = () => {
      status = 'live';
      ws.send(JSON.stringify({ t: 'r', cols: t.cols, rows: t.rows }));
      if (visible) t.focus();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'd') t.write(msg.d);
      else if (msg.t === 'open') {
        // `code-gh` ran in this shell and the server pushed the request back
        // down this socket. The editor shell owns tabs and workspaces, so hand
        // it over as an event rather than reaching across from here.
        window.dispatchEvent(new CustomEvent('gmd:open-request', { detail: msg }));
      }
      else if (msg.t === 'x') {
        status = 'gone';
        onexit?.(msg.code ?? null);
      }
    };
    ws.onclose = () => {
      if (status !== 'gone') {
        status = 'gone';
        onexit?.(null);
      }
    };
    t.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'd', d }));
    });

    // Any geometry change (panel drag, hotkey nudge, reveal) → refit + tell
    // the pty its new size so full-screen TUIs redraw correctly.
    const ro = new ResizeObserver(() => {
      if (!root || root.clientHeight === 0) return; // hidden — refit on reveal
      f.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'r', cols: t.cols, rows: t.rows }));
      }
    });
    ro.observe(root);

    return () => {
      ro.disconnect();
      ws.close();
      t.dispose();
      term = null;
      fit = null;
    };
  });

  // Reveal → refit (display:none zeroes the geometry) + focus.
  $effect(() => {
    if (visible && term && fit) {
      requestAnimationFrame(() => {
        fit?.fit();
        term?.focus();
      });
    }
  });
</script>

<div class="term-wrap" class:hidden={!visible}>
  <div class="term" bind:this={root}></div>
  {#if status === 'connecting'}
    <div class="term-status">connecting…</div>
  {/if}
</div>

<style>
  .term-wrap {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #1e1e1e;
  }
  .term-wrap.hidden {
    display: none;
  }
  .term {
    position: absolute;
    inset: 0 0 0 8px;
  }
  .term :global(.xterm) {
    height: 100%;
  }
  .term-status {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: #949494;
    background: rgba(30, 30, 30, 0.85);
    z-index: 2;
  }
</style>
