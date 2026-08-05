<script lang="ts">
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import { untrack } from 'svelte';
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
    onexit?: (code: number | null, signal: number) => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  let status = $state<'connecting' | 'live' | 'gone'>('connecting');
  // Why the session ended. Kept on screen rather than letting the tab vanish:
  // a shell that died on an error printed the reason a line or two above, and
  // a panel that goes black without saying anything reads as a crash.
  let exit = $state<{ code: number | null; signal: number; lost: boolean } | null>(null);
  const exitNote = $derived(
    !exit
      ? ''
      : exit.lost
        ? 'Connection to this shell was lost — its output is kept. Close the tab to discard it.'
        : exit.signal
          ? `Shell killed by signal ${exit.signal}.`
          : exit.code === null
            ? 'Process exited.'
            : `Process exited with code ${exit.code}.`,
  );

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
      // Required before the unicode version can be switched below: xterm gates
      // that behind proposed-API consent and throws without it.
      allowProposedApi: true,
      // The server's 200k-char replay buffer only refills a reattaching tab.
      // What the scrollbar actually walks is this, and xterm's default of
      // 1000 lines is why a `git push` scrolled back barely two screens.
      scrollback: 5000,
      theme: {
        background: '#1e1e1e',
        foreground: '#c5c8c6',
        cursor: '#e58520',
        selectionBackground: 'rgba(229, 133, 32, 0.45)',
      },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    // No link handler passed, so a click goes through window.open and the
    // browser decides. Unicode 11 has to be activated after loading — the
    // addon only registers the tables, and leaving v6 active is what makes
    // emoji and CJK drift a column inside TUIs.
    t.loadAddon(new WebLinksAddon());
    // Width tables are a nicety; the shell behind them is not. A throw here
    // used to happen before the socket below was even created, which left the
    // panel saying "connecting…" forever with no way back.
    try {
      t.loadAddon(new Unicode11Addon());
      t.unicode.activeVersion = '11';
    } catch (e) {
      console.warn('unicode11 unavailable', e);
    }
    t.open(root);
    f.fit();
    term = t;
    fit = f;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/pty?id=${encodeURIComponent(sessionId)}`);
    ws.onopen = () => {
      status = 'live';
      ws.send(JSON.stringify({ t: 'r', cols: t.cols, rows: t.rows }));
      // Untracked deliberately: reading `visible` bare made this creation
      // effect depend on it, so every terminal tab switch tore down the xterm
      // and its socket and rebuilt them — the "connecting…" hang that also lost
      // the scrollback.
      if (untrack(() => visible)) t.focus();
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
        exit = { code: msg.code ?? null, signal: msg.signal ?? 0, lost: false };
        onexit?.(msg.code ?? null, msg.signal ?? 0);
      }
    };
    ws.onclose = () => {
      if (status !== 'gone') {
        status = 'gone';
        // The socket died, which says nothing about the pty behind it — the
        // server may still be holding a live session. Reporting it as a lost
        // connection rather than an exit keeps that distinction visible.
        exit = { code: null, signal: 0, lost: true };
        onexit?.(null, 0);
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
  <!-- A strip along the bottom, not an overlay: whatever the shell printed on
       its way out is usually the reason it went, and covering that up is the
       whole problem being fixed. -->
  {#if exit}
    <div class="term-exit" class:bad={exit.lost || exit.signal !== 0 || exit.code !== 0}>{exitNote}</div>
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
  .term-exit {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 3px 10px;
    font-size: 12px;
    color: #949494;
    background: rgba(35, 35, 35, 0.92);
    border-top: 1px solid #404040;
    z-index: 3;
  }
  .term-exit.bad {
    color: #ff7b72;
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
