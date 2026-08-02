<script lang="ts">
  import { fileIconUrl, folderIconUrl } from '../../lib/file-icons';

  let { visible = true, onOpenDiff, onOpenMerge }: {
    visible?: boolean;
    onOpenDiff: (repo: string, file: { path: string; staged: boolean; untracked?: boolean }) => void;
    onOpenMerge: (repo: string, path: string) => void;
  } = $props();

  interface RepoInfo { repo: string; branch?: string; ahead?: number; behind?: number; changes?: number; error?: string }
  interface FileRow { path: string; status: string; untracked?: boolean; orig?: string | null }
  // `conflicts` is optional so a page left open against an older server still
  // renders the two groups it does know about.
  interface GitStatus { repo: string; branch: string; upstream: string; ahead: number; behind: number; empty: boolean; staged: FileRow[]; changes: FileRow[]; conflicts?: FileRow[] }

  let repos = $state<RepoInfo[]>([]);
  let repo = $state('');
  let status = $state<GitStatus | null>(null);
  let error = $state('');
  let message = $state('');
  let amend = $state(false);
  let busy = $state(false);
  // Plain let on purpose: reading it in the visibility effect must not make
  // the effect re-run when it flips (see CodeTab's effect-discipline lesson).
  let loaded = false;

  const folder = new URLSearchParams(location.search).get('folder') ?? '';

  // Scans for repositories under the open workspace and re-anchors the picker
  // to what it finds. The list is deliberately limited to the anchor: a
  // workspace with no checkout in it shows an empty picker rather than falling
  // back to a scan of the server's start directory, which is what used to
  // mount the panel on an unrelated repo. The server puts the checkout that
  // encloses the anchor first, so the default selection is the repo the open
  // folder belongs to even when the anchor is a subdirectory of it.
  async function loadRepos() {
    try {
      const r = await fetch(`/api/git/repos?base=${encodeURIComponent(folder || '.')}`);
      const d = await r.json();
      repos = d.repos ?? [];
      loaded = true;
      // A repo selected under a previous anchor is dropped once it is no longer
      // in range, so the header can never show a repo outside the workspace.
      if (!repo || !repos.some((x) => x.repo === repo && !x.error)) {
        repo = repos.find((x) => !x.error)?.repo ?? '';
        status = null;
      }
      if (repo) await refresh();
      else {
        status = null;
        error = repos.length ? '' : 'no git repository in this folder';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function refresh() {
    // If the initial /api/git/repos never landed (server still booting, network
    // blip, tunnel down) the panel used to stay empty forever: refresh only
    // refetched status, and status needs a repo that was never selected.
    if (!repos.length) await loadRepos();
    if (!repo) return;
    try {
      const r = await fetch(`/api/git/status?repo=${encodeURIComponent(repo)}`);
      const d = await r.json();
      if (!r.ok) { error = d.error ?? `HTTP ${r.status}`; status = null; return; }
      error = '';
      status = d;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function action(body: Record<string, unknown>): Promise<boolean> {
    busy = true;
    let ok = false;
    try {
      const r = await fetch('/api/git/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, ...body }),
      });
      const d = await r.json();
      if (!r.ok) error = d.error ?? `HTTP ${r.status}`;
      else { error = ''; ok = true; }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    busy = false;
    await refresh();
    return ok;
  }

  async function commit() {
    if (busy || (!message.trim() && !amend)) return;
    if (await action({ op: 'commit', message, amend })) {
      message = '';
      amend = false;
    }
  }

  function discard(f: FileRow) {
    const q = f.untracked ? `Delete untracked file ${f.path}?` : `Discard changes in ${f.path}? This cannot be undone.`;
    if (window.confirm(q)) void action({ op: 'discard', paths: [f.path] });
  }

  function stageAll() {
    const paths = (status?.changes ?? []).map((f) => f.path);
    if (paths.length) void action({ op: 'stage', paths });
  }

  function unstageAll() {
    const paths = (status?.staged ?? []).map((f) => f.path);
    if (paths.length) void action({ op: 'unstage', paths });
  }

  // Refresh channels: panel shown / repo switched (tracked below), a save
  // anywhere in the app (gmd:git-refresh), window refocus (user ran git in a
  // terminal). Listeners registered once — they read `visible` at fire time.
  $effect(() => {
    void repo; // track: switching repos refetches
    if (!visible) return;
    void (loaded ? refresh() : loadRepos());
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

  // --- tree view (default, explorer-style) ---------------------------------
  // Flat porcelain paths grouped into a dir tree; single-child dir chains
  // compacted VS Code-style ("src/components/server"). Rebuilt on every
  // status refresh via $derived — collapse state lives in a separate Set
  // (keyed side:path, default expanded) so it survives refreshes.
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

  const stagedTree = $derived(buildTree(status?.staged ?? []));
  const changesTree = $derived(buildTree(status?.changes ?? []));

  function descPaths(n: DirNode): string[] {
    return [...n.files.map((f) => f.path), ...n.dirs.flatMap(descPaths)];
  }

  let collapsed = $state<Set<string>>(new Set());
  function toggleDir(key: string) {
    const s = new Set(collapsed);
    if (s.has(key)) s.delete(key); else s.add(key);
    collapsed = s;
  }

  function discardDir(d: DirNode) {
    const paths = descPaths(d);
    if (window.confirm(`Discard changes in ${paths.length} file(s) under ${d.name}? Untracked files are deleted. This cannot be undone.`)) {
      void action({ op: 'discard', paths });
    }
  }

  const leafName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
</script>

{#snippet gitTree(node: DirNode, depth: number, isStaged: boolean)}
  {#each node.dirs as d (d.path)}
    {@const key = (isStaged ? 'S:' : 'W:') + d.path}
    <div
      class="filerow dirrow"
      role="button"
      tabindex="0"
      title={d.path}
      style="padding-left: {6 + depth * 14}px"
      onclick={() => toggleDir(key)}
      data-depth={depth}
      onkeydown={(e) => { if (e.key === 'Enter') toggleDir(key); }}
    >
      {#each Array(depth) as _, i}
        <span class="guide" style="left: {12 + i * 14}px"></span>
      {/each}
      <span class="chevron">{collapsed.has(key) ? '▸' : '▾'}</span>
      <img class="ficon" alt="" aria-hidden="true" src={folderIconUrl(leafName(d.name), !collapsed.has(key))} />
      <span class="fname dirname">{d.name}</span>
      <span class="actions">
        {#if isStaged}
          <button type="button" class="icon-btn" title="Unstage folder" onclick={(e) => { e.stopPropagation(); void action({ op: 'unstage', paths: descPaths(d) }); }}>−</button>
        {:else}
          <button type="button" class="icon-btn" title="Discard folder" onclick={(e) => { e.stopPropagation(); discardDir(d); }}>⨯</button>
          <button type="button" class="icon-btn" title="Stage folder" onclick={(e) => { e.stopPropagation(); void action({ op: 'stage', paths: descPaths(d) }); }}>+</button>
        {/if}
      </span>
      <span class="dcount">{d.total}</span>
    </div>
    {#if !collapsed.has(key)}
      {@render gitTree(d, depth + 1, isStaged)}
    {/if}
  {/each}
  {#each node.files as f (f.path + (isStaged ? ':S' : ':W'))}
    <div
      class="filerow"
      role="button"
      tabindex="0"
      title={isStaged && f.orig ? `${f.orig} → ${f.path}` : f.path}
      style="padding-left: {6 + depth * 14}px"
      onclick={() => onOpenDiff(repo, { path: f.path, staged: isStaged, untracked: f.untracked })}
      onkeydown={(e) => { if (e.key === 'Enter') onOpenDiff(repo, { path: f.path, staged: isStaged, untracked: f.untracked }); }}
    >
      {#each Array(depth) as _, i}
        <span class="guide" style="left: {12 + i * 14}px"></span>
      {/each}
      <span class="chevron"></span>
      <img class="ficon" alt="" aria-hidden="true" src={fileIconUrl(leafName(f.path))} />
      <span class="fname">{leafName(f.path)}</span>
      <span class="actions">
        {#if isStaged}
          <button type="button" class="icon-btn" title="Unstage" onclick={(e) => { e.stopPropagation(); void action({ op: 'unstage', paths: [f.path] }); }}>−</button>
        {:else}
          <button type="button" class="icon-btn" title={f.untracked ? 'Delete file' : 'Discard changes'} onclick={(e) => { e.stopPropagation(); discard(f); }}>⨯</button>
          <button type="button" class="icon-btn" title="Stage" onclick={(e) => { e.stopPropagation(); void action({ op: 'stage', paths: [f.path] }); }}>+</button>
        {/if}
      </span>
      <span class="badge" style="color: {color(f.untracked ? 'U' : f.status)}">{f.untracked ? 'U' : f.status}</span>
    </div>
  {/each}
{/snippet}

<div class="scm">
  <div class="scm-top">
    <select bind:value={repo} title="Repository">
      {#each repos as r (r.repo)}
        <option value={r.repo} disabled={!!r.error}>{r.repo}{r.error ? ' ⚠' : ''}</option>
      {/each}
    </select>
    <button type="button" class="icon-btn" title="Refresh" onclick={() => void loadRepos()}>⟳</button>
  </div>
  {#if status}
    <div class="branchline" title={status.upstream ? `upstream ${status.upstream}` : 'no upstream'}>
      <span class="branch">⎇ {status.branch || '(detached)'}</span>
      {#if status.ahead}<span class="ab">↑{status.ahead}</span>{/if}
      {#if status.behind}<span class="ab">↓{status.behind}</span>{/if}
    </div>
  {/if}
  <div class="commitbox">
    <textarea
      rows="3"
      placeholder={amend ? 'Amend message' : 'Commit message (Ctrl+Enter to commit)'}
      bind:value={message}
      onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void commit(); } }}
    ></textarea>
    <div class="commit-row">
      <label class="amend"><input type="checkbox" bind:checked={amend} /> amend</label>
      <button
        type="button"
        class="commit-btn"
        disabled={busy || (!amend && (!message.trim() || !(status?.staged.length)))}
        onclick={() => void commit()}
      >✓ Commit{status?.staged.length ? ` (${status.staged.length})` : ''}</button>
    </div>
  </div>
  {#if error}<div class="scm-error">{error}</div>{/if}
  <div class="scm-lists">
    {#if status}
      {#if status.conflicts?.length}
        <div class="section">
          <div class="section-head">
            <span>Merge changes</span>
            <span class="count">{status.conflicts.length}</span>
          </div>
          <!-- Flat, and without the stage and discard buttons the other groups
               carry: a conflicted file has one useful action, and burying it
               among verbs that would silently pick a side is how people end up
               committing half a merge. -->
          {#each status.conflicts as f (f.path)}
            <div
              class="filerow"
              role="button"
              tabindex="0"
              title="{f.path} — resolve in the merge editor"
              style="padding-left: 6px"
              onclick={() => onOpenMerge(repo, f.path)}
              onkeydown={(e) => { if (e.key === 'Enter') onOpenMerge(repo, f.path); }}
            >
              <span class="chevron"></span>
              <img class="ficon" alt="" aria-hidden="true" src={fileIconUrl(leafName(f.path))} />
              <span class="fname">{leafName(f.path)}</span>
              <span class="badge conflict">{f.status}</span>
            </div>
          {/each}
        </div>
      {/if}
      <div class="section">
        <div class="section-head">
          <span>Staged changes</span>
          <span class="count">{status.staged.length}</span>
          {#if status.staged.length}
            <button type="button" class="icon-btn" title="Unstage all" onclick={unstageAll}>−</button>
          {/if}
        </div>
        {@render gitTree(stagedTree, 0, true)}
      </div>
      <div class="section">
        <div class="section-head">
          <span>Changes</span>
          <span class="count">{status.changes.length}</span>
          {#if status.changes.length}
            <button type="button" class="icon-btn" title="Stage all" onclick={stageAll}>+</button>
          {/if}
        </div>
        {@render gitTree(changesTree, 0, false)}
      </div>
    {:else if !error}
      <div class="empty">No repository selected.</div>
    {/if}
  </div>
</div>

<style>
  .scm {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    font-size: 12px;
  }
  .scm-top {
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
    padding: 4px 8px 0;
  }
  .scm-top select {
    flex: 1 1 0;
    min-width: 0;
    background: #1e1e1e;
    color: #c5c8c6;
    border: 1px solid #404040;
    border-radius: 4px;
    font-size: 12px;
    padding: 2px 4px;
  }
  .badge.conflict { color: #f28b82; }
  .branchline {
    flex: 0 0 auto;
    display: flex;
    gap: 8px;
    padding: 4px 10px 0;
    color: #949494;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
  }
  .branch { overflow: hidden; text-overflow: ellipsis; }
  .ab { color: #e58520; }
  .commitbox {
    flex: 0 0 auto;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .commitbox textarea {
    resize: vertical;
    background: #1e1e1e;
    color: #c5c8c6;
    border: 1px solid #404040;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    padding: 4px 6px;
  }
  .commitbox textarea:focus { outline: 1px solid #e58520; }
  .commit-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .amend {
    color: #949494;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    user-select: none;
  }
  .commit-btn {
    background: #238636;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .commit-btn:disabled { opacity: 0.45; cursor: default; }
  .scm-error {
    flex: 0 0 auto;
    margin: 0 8px 4px;
    padding: 4px 6px;
    background: rgba(248, 81, 73, 0.15);
    border: 1px solid rgba(248, 81, 73, 0.4);
    border-radius: 4px;
    color: #f28b82;
    font-size: 11px;
    word-break: break-word;
  }
  .scm-lists {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
  }
  /* Pinned to the left edge so the section a row belongs to stays readable
     once the list is scrolled sideways to a long path. */
  .section-head {
    position: sticky;
    left: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px 2px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #949494;
  }
  .section-head .count {
    background: #404040;
    border-radius: 8px;
    padding: 0 6px;
    font-size: 10px;
  }
  .section-head .icon-btn { margin-left: auto; }
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
  /* Grow to keep the badge on the right edge of short rows, but never shrink:
     a long name widens the row and the list scrolls sideways to it. The old
     `direction: rtl` went with the ellipsis — it clipped from the left, at the
     cost of rendering a leading dot at the wrong end (`.env` as `env.`). */
  .fname {
    flex: 1 0 auto;
    text-align: left;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11.5px;
  }
  .actions { display: none; gap: 2px; }
  .filerow:hover .actions { display: flex; }
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
