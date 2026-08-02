<script lang="ts">
  import { fileIconUrl, folderIconUrl } from '../../lib/file-icons';

  let { visible = false, onOpenDiff }: {
    visible?: boolean;
    onOpenDiff: (repo: string, file: { path: string; staged: boolean; untracked?: boolean; base?: string; baseLabel?: string; to?: string; toLabel?: string }) => void;
  } = $props();

  interface RepoInfo { repo: string; branch?: string; error?: string }
  interface FileRow { path: string; status: string }

  let repos = $state<RepoInfo[]>([]);
  let repo = $state('');
  let refs = $state<string[]>([]);
  let head = $state('');
  let base = $state('');
  // The incoming side. '' means the working tree — the historical behaviour,
  // and the only shape where a file can be restored from the base. With a ref
  // pinned here both sides are commits, so every diff opened is read-only.
  let incoming = $state('');
  let resolvedHead = $state('');
  let hashDraft = $state({ base: '', incoming: '' });
  // Merge-base by default — the PR view: only this branch's own work. Direct
  // compares the trees head-on, differences from BOTH sides included.
  let direct = $state(false);
  let files = $state<FileRow[]>([]);
  // The sha the server pinned the list to. Every diff tab opened from a row
  // carries this sha, so list and diff always describe the same tree even if
  // HEAD moves in between.
  let resolved = $state('');
  let error = $state('');
  let loading = $state(false);
  // Plain let on purpose: reading it in the visibility effect must not make
  // the effect re-run when it flips.
  let loaded = false;

  const folder = new URLSearchParams(location.search).get('folder') ?? '';
  const baseKey = (r: string) => `ghmd.compareBase:${folder}:${r}`;
  const incomingKey = (r: string) => `ghmd.compareIncoming:${folder}:${r}`;
  // Anything shaped like an abbreviated object name is kept exactly as typed
  // and handed to the server — resolveRef there is the only thing that can
  // actually say whether it names a commit.
  const isSha = (s: string) => /^[0-9a-f]{7,40}$/i.test(s);

  async function loadRepos() {
    try {
      const r = await fetch(`/api/git/repos?base=${encodeURIComponent(folder || '.')}`);
      const d = await r.json();
      repos = d.repos ?? [];
      loaded = true;
      if (!repo || !repos.some((x) => x.repo === repo && !x.error)) {
        repo = repos.find((x) => !x.error)?.repo ?? '';
      }
      if (repo) await loadRefs();
      else error = repos.length ? '' : 'no git repository in this folder';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function loadRefs() {
    if (!repo) return;
    try {
      const r = await fetch(`/api/git/refs?repo=${encodeURIComponent(repo)}`);
      const d = await r.json();
      if (!r.ok) { error = d.error ?? `HTTP ${r.status}`; return; }
      refs = d.refs ?? [];
      head = d.head ?? '';
      let saved = '';
      let savedIn = '';
      try {
        saved = localStorage.getItem(baseKey(repo)) ?? '';
        savedIn = localStorage.getItem(incomingKey(repo)) ?? '';
      } catch { /* private mode */ }
      // A remembered sha is never in `refs`; only a remembered BRANCH that has
      // since disappeared should be dropped.
      base = saved && (refs.includes(saved) || isSha(saved)) ? saved : refs.find((x) => x !== head) ?? refs[0] ?? '';
      incoming = savedIn && (refs.includes(savedIn) || isSha(savedIn)) ? savedIn : '';
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function refresh() {
    if (!repo || !base) { files = []; resolved = ''; return; }
    loading = true;
    try {
      const qs = new URLSearchParams({ repo, base, ...(incoming ? { head: incoming } : {}), ...(direct ? { mode: 'direct' } : {}) });
      const r = await fetch(`/api/git/compare?${qs}`);
      const d = await r.json();
      if (!r.ok) { error = d.error ?? `HTTP ${r.status}`; files = []; }
      else { error = ''; files = d.files ?? []; resolved = d.resolved ?? ''; resolvedHead = d.resolvedHead ?? ''; }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    loading = false;
  }

  function pickBase(b: string) {
    if (!b) return;
    base = b;
    try { localStorage.setItem(baseKey(repo), b); } catch { /* private mode */ }
    void refresh();
  }

  function pickIncoming(b: string) {
    incoming = b;
    try { localStorage.setItem(incomingKey(repo), b); } catch { /* private mode */ }
    void refresh();
  }

  // Enter in a hash box commits that value to its side. Nothing is validated
  // here on purpose — an unknown ref comes back as a 400 with git's own words.
  function commitHash(side: 'base' | 'incoming', e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    const v = (e.currentTarget as HTMLInputElement).value.trim();
    if (!v) return;
    if (side === 'base') pickBase(v); else pickIncoming(v);
    hashDraft = { ...hashDraft, [side]: '' };
  }

  // Only meaningful when both sides are refs: the working tree cannot become a
  // base. Written as one transaction — routing through pickBase/pickIncoming
  // would read the value the other one just overwrote.
  function swapSides() {
    if (!incoming) return;
    const b = base;
    base = incoming;
    incoming = b;
    try {
      localStorage.setItem(baseKey(repo), base);
      localStorage.setItem(incomingKey(repo), incoming);
    } catch { /* private mode */ }
    void refresh();
  }

  function open(f: FileRow) {
    onOpenDiff(repo, {
      path: f.path,
      staged: false,
      untracked: f.status === 'U',
      base: resolved,
      baseLabel: direct ? base : `${base} ⤴`,
      ...(incoming ? { to: resolvedHead, toLabel: incoming } : {}),
    });
  }

  // A pinned sha is not in `refs`, so it needs its own option or the select
  // would render blank and silently misreport what is being compared.
  const baseOptions = $derived(base && !refs.includes(base) ? [base, ...refs] : refs);
  const incomingOptions = $derived(incoming && !refs.includes(incoming) ? [incoming, ...refs] : refs);

  $effect(() => {
    void repo; // track: switching repos refetches refs + files
    if (!visible) return;
    void (loaded ? loadRefs() : loadRepos());
  });
  $effect(() => {
    const onRefresh = () => { if (visible) void refresh(); };
    window.addEventListener('gmd:git-refresh', onRefresh);
    window.addEventListener('focus', onRefresh);
    return () => {
      window.removeEventListener('gmd:git-refresh', onRefresh);
      window.removeEventListener('focus', onRefresh);
    };
  });

  const COLORS: Record<string, string> = { M: '#e2c08d', A: '#81c995', D: '#f28b82', R: '#79c0ff', C: '#79c0ff', U: '#81c995' };
  const color = (s: string) => COLORS[s] ?? '#c5c8c6';

  // Same explorer-style grouping as the git panel: flat paths into a dir
  // tree, single-child chains compacted VS Code-style.
  interface DirNode { name: string; path: string; dirs: DirNode[]; files: FileRow[]; total: number }

  function buildTree(rows: FileRow[]): DirNode {
    const root: DirNode = { name: '', path: '', dirs: [], files: [], total: 0 };
    for (const f of rows) {
      const parts = f.path.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        let next = cur.dirs.find((d) => d.name === seg);
        if (!next) {
          next = { name: seg, path: cur.path ? `${cur.path}/${seg}` : seg, dirs: [], files: [], total: 0 };
          cur.dirs.push(next);
        }
        cur = next;
      }
      cur.files.push(f);
    }
    const finish = (n: DirNode): void => {
      n.dirs.sort((a, b) => a.name.localeCompare(b.name));
      n.files.sort((a, b) => a.path.localeCompare(b.path));
      for (let i = 0; i < n.dirs.length; i++) {
        let d = n.dirs[i];
        while (d.dirs.length === 1 && d.files.length === 0) {
          const child = d.dirs[0];
          d = { ...child, name: `${d.name}/${child.name}` };
          n.dirs[i] = d;
        }
        finish(d);
      }
      n.total = n.files.length + n.dirs.reduce((s, d) => s + d.total, 0);
    };
    finish(root);
    return root;
  }

  const tree = $derived(buildTree(files));

  let collapsed = $state<Set<string>>(new Set());
  function toggleDir(key: string) {
    const s = new Set(collapsed);
    if (s.has(key)) s.delete(key); else s.add(key);
    collapsed = s;
  }

  const leafName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
</script>

{#snippet cmpTree(node: DirNode, depth: number)}
  {#each node.dirs as d (d.path)}
    <div
      class="filerow dirrow"
      role="button"
      tabindex="0"
      title={d.path}
      style="padding-left: {6 + depth * 14}px"
      onclick={() => toggleDir(d.path)}
      onkeydown={(e) => { if (e.key === 'Enter') toggleDir(d.path); }}
    >
      {#each Array(depth) as _, i}
        <span class="guide" style="left: {12 + i * 14}px"></span>
      {/each}
      <span class="chevron">{collapsed.has(d.path) ? '▸' : '▾'}</span>
      <img class="ficon" alt="" aria-hidden="true" src={folderIconUrl(leafName(d.name), !collapsed.has(d.path))} />
      <span class="fname dirname">{d.name}</span>
      <span class="dcount">{d.total}</span>
    </div>
    {#if !collapsed.has(d.path)}
      {@render cmpTree(d, depth + 1)}
    {/if}
  {/each}
  {#each node.files as f (f.path)}
    <div
      class="filerow"
      role="button"
      tabindex="0"
      title={f.path}
      style="padding-left: {6 + depth * 14}px"
      onclick={() => open(f)}
      onkeydown={(e) => { if (e.key === 'Enter') open(f); }}
    >
      {#each Array(depth) as _, i}
        <span class="guide" style="left: {12 + i * 14}px"></span>
      {/each}
      <span class="chevron"></span>
      <img class="ficon" alt="" aria-hidden="true" src={fileIconUrl(leafName(f.path))} />
      <span class="fname">{leafName(f.path)}</span>
      <span class="badge" style="color: {color(f.status)}">{f.status}</span>
    </div>
  {/each}
{/snippet}

<div class="tcmp">
  <div class="tcmp-top">
    <select bind:value={repo} title="Repository">
      {#each repos as r (r.repo)}
        <option value={r.repo} disabled={!!r.error}>{r.repo}{r.error ? ' ⚠' : ''}</option>
      {/each}
    </select>
    <button type="button" class="icon-btn" title="Refresh" onclick={() => void loadRepos()}>⟳</button>
  </div>
  <div class="tcmp-top">
    <span class="sidelbl" title="Base — the side everything is compared against">base</span>
    <select value={base} onchange={(e) => pickBase(e.currentTarget.value)} title="Base branch / tag / ref to compare against">
      {#each baseOptions as rf (rf)}
        <option value={rf}>{rf}</option>
      {/each}
    </select>
    <input
      class="hash"
      placeholder="sha…"
      title="Type a commit hash and press Enter to use it as the base"
      value={hashDraft.base}
      onkeydown={(e) => commitHash('base', e)}
    />
  </div>
  <div class="tcmp-top">
    <span class="sidelbl" title="Incoming — the side being compared">into</span>
    <select value={incoming} onchange={(e) => pickIncoming(e.currentTarget.value)} title="Incoming side. Working tree includes uncommitted changes; pinning a ref makes both sides commits, so the diffs open read-only">
      <option value="">working tree</option>
      {#each incomingOptions as rf (rf)}
        <option value={rf}>{rf}</option>
      {/each}
    </select>
    <input
      class="hash"
      placeholder="sha…"
      title="Type a commit hash and press Enter to use it as the incoming side"
      value={hashDraft.incoming}
      onkeydown={(e) => commitHash('incoming', e)}
    />
    <button type="button" class="icon-btn" title="Swap base and incoming" disabled={!incoming} onclick={swapSides}>⇄</button>
  </div>
  <div class="tcmp-top">
    <label class="direct" title="Compare trees directly instead of against the merge-base (PR view)">
      <input type="checkbox" bind:checked={direct} onchange={() => void refresh()} /> direct
    </label>
  </div>
  {#if head}
    <div class="headline" title={resolvedHead || resolved}>⎇ {incoming || head} vs {base}{direct ? '' : ' (merge-base)'}{incoming ? ' · read-only' : ''}</div>
  {/if}
  {#if error}<div class="tcmp-error">{error}</div>{/if}
  <div class="rows">
    {#if loading && !files.length}
      <div class="empty">Loading…</div>
    {:else if !files.length}
      <div class="empty">{error ? '' : 'No differences.'}</div>
    {:else}
      {@render cmpTree(tree, 0)}
    {/if}
  </div>
</div>

<style>
  .tcmp {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    font-size: 12px;
  }
  .tcmp-top {
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
    padding: 4px 8px 0;
    align-items: center;
  }
  .tcmp-top select {
    flex: 1 1 0;
    min-width: 0;
    background: #1e1e1e;
    color: #c5c8c6;
    border: 1px solid #404040;
    border-radius: 4px;
    font-size: 12px;
    padding: 2px 4px;
  }
  .tcmp-top .hash {
    flex: 0 1 66px;
    min-width: 0;
    background: #1e1e1e;
    color: #c5c8c6;
    border: 1px solid #404040;
    border-radius: 4px;
    font-size: 11px;
    padding: 2px 4px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  .sidelbl {
    flex: 0 0 26px;
    color: #949494;
    font-size: 11px;
  }
  .direct {
    color: #949494;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .headline {
    flex: 0 0 auto;
    padding: 4px 10px 0;
    color: #949494;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tcmp-error {
    flex: 0 0 auto;
    margin: 4px 8px;
    padding: 4px 6px;
    background: rgba(248, 81, 73, 0.15);
    border: 1px solid rgba(248, 81, 73, 0.4);
    border-radius: 4px;
    color: #f28b82;
    font-size: 11px;
    word-break: break-word;
  }
  .rows {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    margin-top: 4px;
  }
  .filerow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    cursor: pointer;
    white-space: nowrap;
    width: max-content;
    min-width: 100%;
    box-sizing: border-box;
  }
  .filerow:hover { background: rgba(110, 118, 129, 0.12); }
  .guide {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #353535;
    pointer-events: none;
  }
  .fname {
    flex: 1 0 auto;
    text-align: left;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11.5px;
  }
  .badge {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-weight: 700;
    font-size: 11px;
    width: 12px;
    text-align: center;
  }
  .icon-btn {
    border: none;
    background: transparent;
    color: #949494;
    cursor: pointer;
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 13px;
    line-height: 1.2;
  }
  .icon-btn:hover { background: #444444; color: #c5c8c6; }
  .icon-btn:disabled { opacity: 0.35; cursor: default; background: transparent; }
  .empty {
    padding: 16px;
    color: #949494;
    text-align: center;
  }
  .chevron {
    width: 12px;
    flex: 0 0 12px;
    display: inline-block;
    color: #949494;
    font-size: 10px;
  }
  .ficon {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
  }
  .dirname {
    font-weight: 600;
    direction: ltr;
  }
  .dcount {
    color: #949494;
    font-size: 11px;
    margin-left: 2px;
  }
</style>
