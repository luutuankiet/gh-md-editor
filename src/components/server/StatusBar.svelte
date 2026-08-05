<script lang="ts">
  // The bottom strip: which machine is serving this workspace, what git is
  // doing in the anchored repository, and how big the open file is in the unit
  // that actually matters when the file is headed for a model. Every segment
  // is either a fact or a button — nothing decorative.
  import { formatTokens } from '../../lib/token-estimate';

  type Repo = {
    repo: string;
    branch?: string;
    ahead?: number;
    behind?: number;
    changes?: number;
    error?: string;
  };

  let {
    host = '',
    folder = '',
    anchor = $bindable(''),
    tokens = 0,
    tokenLabel = '',
    onPickRef,
  }: {
    host?: string;
    folder?: string;
    // Repo-relative path of the repository every git segment refers to. Bound
    // so the command palette can act on the same choice this bar displays.
    anchor?: string;
    // Token estimate for the active editor; 0 when nothing countable is open.
    tokens?: number;
    tokenLabel?: string;
    onPickRef: (repo: string) => void;
  } = $props();

  let repos = $state<Repo[]>([]);
  let menuOpen = $state(false);

  // A workspace with several repos has no natural "main" one, so the choice is
  // remembered per workspace rather than globally — switching workspaces must
  // not drag the previous one's anchor along.
  const KEY = 'ghmd.gitAnchor';
  function readAnchors(): Record<string, string> {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  function rememberAnchor(repo: string) {
    try {
      const all = readAnchors();
      all[folder || '.'] = repo;
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      /* private mode */
    }
  }

  async function refresh() {
    try {
      const r = await fetch(`/api/git/repos?base=${encodeURIComponent(folder)}`);
      const d = await r.json();
      repos = r.ok ? (d.repos ?? []) : [];
    } catch {
      repos = [];
    }
    const remembered = readAnchors()[folder || '.'];
    if (remembered && repos.some((x) => x.repo === remembered)) anchor = remembered;
    else if (!repos.some((x) => x.repo === anchor)) anchor = repos[0]?.repo ?? '';
  }

  // Re-scan when the workspace changes…
  $effect(() => {
    void folder;
    void refresh();
  });
  // …and whenever something in the app moved git. Staging, committing and
  // branch switches all fire this, so the bar never shows a stale branch.
  $effect(() => {
    const on = () => void refresh();
    window.addEventListener('gmd:git-changed', on);
    return () => window.removeEventListener('gmd:git-changed', on);
  });

  let current = $derived(repos.find((r) => r.repo === anchor) ?? null);

  function pickRepo(repo: string) {
    anchor = repo;
    rememberAnchor(repo);
    menuOpen = false;
  }

  const leafOf = (p: string) => {
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i === -1 ? t : t.slice(i + 1);
  };
</script>

<footer class="statusbar">
  {#if host}
    <span class="host-chip" title="Served from {host}">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7l2 3v8h-11v-8zm0 3h7M6 8h4M6 10.5h4" /></svg>
      <span>{host}</span>
    </span>
  {/if}

  {#if current}
    {@const cur = current}
    <button
      type="button"
      class="seg"
      title="Switch or create a branch in {cur.repo || 'this repository'}"
      onclick={() => onPickRef(cur.repo)}
    >
      <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9M11 3.5v2a3 3 0 0 1-3 3H5" /><circle cx="5" cy="2.6" r="1.4" /><circle cx="5" cy="13.4" r="1.4" /><circle cx="11" cy="2.6" r="1.4" /></svg>
      <span class="branch">{cur.branch || 'detached'}</span>
      {#if cur.behind}<span class="num">↓{cur.behind}</span>{/if}
      {#if cur.ahead}<span class="num">↑{cur.ahead}</span>{/if}
    </button>
    {#if cur.changes}
      <span class="seg flat" title="{cur.changes} changed file{cur.changes === 1 ? '' : 's'}">● {cur.changes}</span>
    {/if}
    {#if cur.error}
      <span class="seg flat err" title={cur.error}>git error</span>
    {/if}
  {/if}

  {#if repos.length > 1}
    <button type="button" class="seg" title="Anchored repository — click to switch" onclick={() => (menuOpen = !menuOpen)}>
      <span class="repo-name">{leafOf(anchor) || '‹root›'}</span>
      <span class="caret">▴</span>
    </button>
  {/if}

  <span class="gap"></span>

  {#if tokens > 0}
    <span class="seg flat" title="{tokenLabel || 'Active file'} — estimate, not an exact tokenizer count">
      ~{formatTokens(tokens)} tokens
    </span>
  {/if}
</footer>

{#if menuOpen}
  <!-- Scrim first so a click anywhere else dismisses without also activating
       whatever was underneath. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sb-scrim" onmousedown={() => (menuOpen = false)}></div>
  <div class="repo-menu" role="menu">
    {#each repos as r (r.repo)}
      <button type="button" role="menuitem" class="rm-row" class:on={r.repo === anchor} onclick={() => pickRepo(r.repo)}>
        <span class="rm-path">{r.repo || '‹root›'}</span>
        <span class="rm-branch">{r.branch ?? ''}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .statusbar {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    height: 22px;
    background: #232323;
    border-top: 1px solid #404040;
    font-size: 11px;
    color: #c5c8c6;
    user-select: none;
  }
  .gap { flex: 1 1 auto; }

  /* VS Code's remote indicator sits hard left and is the one coloured thing
     down here, because "which machine am I editing on" is the question a row
     of identical-looking browser tabs cannot answer. */
  .host-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px;
    background: #0e639c;
    color: #ffffff;
    font-weight: 500;
  }
  .host-chip svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
  }

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
  }
  button.seg { cursor: pointer; }
  button.seg:hover { background: #3a3a3a; }
  .seg.flat { color: #949494; }
  .seg.err { color: #e58520; }
  .ico {
    width: 12px;
    height: 12px;
    fill: currentColor;
    stroke: currentColor;
    stroke-width: 1.1;
  }
  .branch {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .num { color: #949494; }
  .repo-name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .caret {
    color: #949494;
    font-size: 9px;
  }

  .sb-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  /* Anchored to the bottom-left rather than to the button: the bar is 22px
     tall, so a menu positioned relative to it would need an escape hatch out
     of the flex row anyway. */
  .repo-menu {
    position: fixed;
    left: 0;
    bottom: 22px;
    z-index: 41;
    min-width: 240px;
    max-height: 50vh;
    overflow-y: auto;
    background: #272727;
    border: 1px solid #505050;
    box-shadow: 0 -4px 14px rgba(0, 0, 0, 0.4);
  }
  .rm-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 5px 10px;
    border: 0;
    background: transparent;
    color: #c5c8c6;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .rm-row:hover { background: #3a3a3a; }
  .rm-row.on { color: #e58520; }
  .rm-path {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rm-branch {
    flex: 0 0 auto;
    color: #949494;
    font-size: 11px;
  }
</style>
