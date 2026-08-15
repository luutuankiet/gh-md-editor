<script lang="ts">
  // Commit graph for one repository: a row per commit, lanes drawn as SVG to
  // the left of it. Read-only on purpose — checking out and creating branches
  // already live in the ref picker, and a graph that also moves HEAD is a graph
  // you cannot click around in freely.

  import { fileIconUrl, folderIconUrl } from '../../lib/file-icons';
  import { toClipboard } from '../../lib/clipboard';

  type Commit = { sha: string; parents: string[]; author: string; date: string; refs: string[]; subject: string };
  type FileChange = { status: string; path: string; from?: string };
  type Detail = { sha: string; author: string; email: string; date: string; parents: string[]; subject: string; body: string; files: FileChange[] };

  let {
    repo = '',
    onOpenDiff,
    onOpenFile,
    onOpenAtRef,
  }: {
    repo?: string;
    onOpenDiff: (repo: string, file: { path: string; staged: boolean; untracked?: boolean; base?: string; baseLabel?: string; to?: string; toLabel?: string }) => void;
    onOpenFile: (repo: string, path: string) => void;
    onOpenAtRef: (repo: string, path: string, sha: string, label: string) => void;
  } = $props();

  const ROW_H = 24;
  const LANE_W = 14;
  const PAD_X = 11;
  // Colour follows the lane, not the branch name: a branch keeps its colour for
  // as long as it keeps its column, which is what makes the shape readable
  // while scrolling past a few hundred commits.
  const LANE_COLORS = ['#e58520', '#4aa3df', '#8bc34a', '#c586c0', '#e5c07b', '#56b6c2', '#e06c75', '#98c379'];
  const color = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
  // git's empty tree. A root commit has no parent to diff against, and this is
  // the object git itself uses to mean "nothing was here before".
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const short = (s: string) => s.slice(0, 7);

  let commits = $state<Commit[]>([]);
  let head = $state('');
  let truncated = $state(false);
  let error = $state('');
  let loading = $state(false);
  let seq = $state(0);

  let selected = $state('');
  let detail = $state<Detail | null>(null);
  let detailError = $state('');

  $effect(() => {
    const r = repo;
    seq;
    void load(r);
  });

  // Checkout, commit and stage all announce themselves on one event rather than
  // being polled for; the graph is stale the moment any of them lands.
  $effect(() => {
    const bump = () => { seq++; };
    window.addEventListener('gmd:git-changed', bump);
    return () => window.removeEventListener('gmd:git-changed', bump);
  });

  async function load(r: string) {
    // An empty repo id resolves server-side to the served root, which answers
    // with the workspace's own name and no commits — a graph that looks like a
    // real but empty repository. Say what actually happened instead.
    if (!r) {
      commits = [];
      head = '';
      truncated = false;
      error = 'No repository is anchored for this workspace — pick one from the repository button in the status bar.';
      return;
    }
    loading = true;
    try {
      const res = await fetch(`/api/git/log?repo=${encodeURIComponent(r)}&limit=400`);
      const d = await res.json();
      if (!res.ok) {
        error = d.error ?? `HTTP ${res.status}`;
        commits = [];
        return;
      }
      commits = d.commits ?? [];
      head = d.head ?? '';
      truncated = !!d.truncated;
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      commits = [];
    } finally {
      loading = false;
    }
  }

  type Seg = { x1: number; x2: number; lane: number };
  type Row = { c: Commit; lane: number; segs: Seg[] };

  // One pass down the list, carrying an array of "which sha is this column
  // waiting for". A commit claims the column that was waiting for it, hands that
  // column to its first parent, and finds free columns for the rest; every other
  // column simply continues straight down.
  let graph = $derived.by(() => {
    const lanes: (string | null)[] = [];
    const rows: Row[] = [];
    let width = 1;

    for (const c of commits) {
      let lane = lanes.indexOf(c.sha);
      if (lane === -1) {
        lane = lanes.indexOf(null);
        if (lane === -1) {
          lane = lanes.length;
          lanes.push(null);
        }
      }
      lanes[lane] = null;
      const pre = lanes.slice();

      const parentLanes: number[] = [];
      for (let p = 0; p < c.parents.length; p++) {
        const ps = c.parents[p];
        let pl = lanes.indexOf(ps);
        if (pl === -1) {
          // The first parent inherits this commit's column, so trunk stays a
          // straight line instead of drifting sideways once per merge.
          if (p === 0) pl = lane;
          else {
            pl = lanes.indexOf(null);
            if (pl === -1) {
              pl = lanes.length;
              lanes.push(null);
            }
          }
          lanes[pl] = ps;
        }
        parentLanes.push(pl);
      }
      width = Math.max(width, lanes.length, lane + 1);

      const segs: Seg[] = [];
      // Columns untouched by this commit pass through it vertically.
      for (let j = 0; j < lanes.length; j++) {
        if (lanes[j] && pre[j] === lanes[j] && j !== lane) segs.push({ x1: j, x2: j, lane: j });
      }
      // ...and one link per parent, from this dot to wherever that parent sits.
      for (const pl of parentLanes) segs.push({ x1: lane, x2: pl, lane: pl });

      rows.push({ c, lane, segs });
      // Trailing empties would widen the graph for the whole scroll even when
      // the branch that needed them merged a hundred commits ago.
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    }
    return { rows, width };
  });

  let graphW = $derived(PAD_X * 2 + (graph.width - 1) * LANE_W);

  // Segments are merged into one path per colour: a few hundred commits would
  // otherwise be a few thousand SVG nodes, and the browser feels every one.
  let paths = $derived.by(() => {
    const by = new Map<number, string>();
    graph.rows.forEach((r, i) => {
      const y1 = i * ROW_H + ROW_H / 2;
      const y2 = y1 + ROW_H;
      for (const s of r.segs) {
        const x1 = PAD_X + s.x1 * LANE_W;
        const x2 = PAD_X + s.x2 * LANE_W;
        const d =
          x1 === x2
            ? `M${x1},${y1}L${x2},${y2}`
            : `M${x1},${y1}C${x1},${y1 + ROW_H * 0.55} ${x2},${y2 - ROW_H * 0.55} ${x2},${y2}`;
        by.set(s.lane, (by.get(s.lane) ?? '') + d);
      }
    });
    return [...by].map(([lane, d]) => ({ d, stroke: color(lane) }));
  });

  function badge(r: string): { text: string; kind: string } {
    if (r.startsWith('HEAD -> ')) return { text: r.slice(8), kind: 'head' };
    if (r === 'HEAD') return { text: 'HEAD', kind: 'head' };
    if (r.startsWith('tag: ')) return { text: r.slice(5), kind: 'tag' };
    if (r.includes('/')) return { text: r, kind: 'remote' };
    return { text: r, kind: 'local' };
  }

  async function select(sha: string) {
    selected = sha;
    detail = null;
    detailError = '';
    try {
      const res = await fetch(`/api/git/commit?repo=${encodeURIComponent(repo)}&sha=${sha}`);
      const d = await res.json();
      if (!res.ok) {
        detailError = d.error ?? `HTTP ${res.status}`;
        return;
      }
      detail = d;
    } catch (e) {
      detailError = e instanceof Error ? e.message : String(e);
    }
  }

  // What this commit did to this file: its own state against its first parent,
  // which is the diff the row in the list is describing.
  function openFileDiff(f: FileChange) {
    if (!detail) return;
    const parent = detail.parents[0];
    onOpenDiff(repo, {
      path: f.path,
      staged: false,
      base: parent ?? EMPTY_TREE,
      baseLabel: parent ? short(parent) : 'empty',
      to: detail.sha,
      toLabel: short(detail.sha),
    });
  }

  const baseOf = (p: string) => p.split('/').pop() ?? p;

  interface FileNode { name: string; dir: string; files: FileChange[]; kids: FileNode[] }

  // The commit's changed files as a folder tree rather than a column of full
  // paths: in a repo of any depth the interesting part of a path is its tail,
  // and a flat list buries it behind the same prefix on every row.
  function buildTree(files: FileChange[]): FileNode {
    const root: FileNode = { name: '', dir: '', files: [], kids: [] };
    for (const f of files) {
      const segs = f.path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        const dir = segs.slice(0, i + 1).join('/');
        let kid = node.kids.find((k) => k.dir === dir);
        if (!kid) {
          kid = { name: segs[i], dir, files: [], kids: [] };
          node.kids.push(kid);
        }
        node = kid;
      }
      node.files.push(f);
    }
    squash(root);
    sortNode(root);
    return root;
  }

  // A folder whose only child is another folder is drawn as "src / lib": one
  // row instead of a staircase of single entries, the way the explorer does
  // it. The root is left alone — its children are the top level.
  function squash(n: FileNode) {
    while (n.dir && !n.files.length && n.kids.length === 1) {
      const only = n.kids[0];
      n.name = `${n.name} / ${only.name}`;
      n.dir = only.dir;
      n.files = only.files;
      n.kids = only.kids;
    }
    for (const k of n.kids) squash(k);
  }

  // Folders above files, each side alphabetical: the order every file tree
  // uses, and the one that makes two commits comparable at a glance.
  function sortNode(n: FileNode) {
    n.kids.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => baseOf(a.path).localeCompare(baseOf(b.path)));
    for (const k of n.kids) sortNode(k);
  }

  // Keyed by folder path and deliberately not reset between commits: walking a
  // series of commits through the same subtree keeps the shape you set up.
  let folded = $state<Record<string, boolean>>({});
  const tree = $derived(detail ? buildTree(detail.files) : null);

  let toast = $state('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; }, 2000);
  }
  $effect(() => () => clearTimeout(toastTimer));

  async function copyPath(p: string) {
    await toClipboard(p);
    showToast('Copied path.');
  }

  // The file as it stood at this commit, not as it stands now — the read-only
  // twin of the ↗ button beside it.
  function openAtCommit(f: FileChange) {
    if (!detail) return;
    onOpenAtRef(repo, f.path, detail.sha, short(detail.sha));
  }

  const STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };
</script>

<!-- Recursive: a folder renders its own children through the same snippet. -->
{#snippet fileTree(node: FileNode, depth: number)}
  {#each node.kids as k (k.dir)}
    <li>
      <button
        type="button"
        class="frow"
        style="padding-left: {depth * 12}px"
        title={k.dir}
        onclick={() => (folded[k.dir] = !folded[k.dir])}
      >
        <span class="chev" class:open={!folded[k.dir]}>▸</span>
        <img class="ficon" alt="" aria-hidden="true" src={folderIconUrl(baseOf(k.dir), !folded[k.dir])} />
        <span class="fname dir">{k.name}</span>
      </button>
    </li>
    {#if !folded[k.dir]}{@render fileTree(k, depth + 1)}{/if}
  {/each}
  {#each node.files as f (f.path)}
    <li>
      <button
        type="button"
        class="frow"
        style="padding-left: {depth * 12}px"
        title="{f.path} — click to show this commit's diff"
        onclick={() => openFileDiff(f)}
      >
        <span class="st {f.status}" title={STATUS[f.status] ?? f.status}>{f.status}</span>
        <img class="ficon" alt="" aria-hidden="true" src={fileIconUrl(baseOf(f.path))} />
        <span class="fname">{baseOf(f.path)}</span>
      </button>
      <span class="factions">
        <button type="button" class="fact" title="Copy path" aria-label="Copy path" onclick={() => copyPath(f.path)}>⧉</button>
        <button type="button" class="fact" title="Open this file as it was at this commit" aria-label="Open at this commit" onclick={() => openAtCommit(f)}>◷</button>
        {#if f.status !== 'D'}
          <button type="button" class="fact" title="Open the current file" aria-label="Open current file" onclick={() => onOpenFile(repo, f.path)}>↗</button>
        {/if}
      </span>
    </li>
  {/each}
{/snippet}

<div class="graph">
  <header class="ghead">
    <!-- "workspace" is not a repository, and a commit count is a claim about
         one that was actually queried. With nothing anchored, neither holds. -->
    <span class="repo">{repo || 'no repository'}</span>
    {#if repo}<span class="count">{commits.length}{truncated ? '+' : ''} commits</span>{/if}
    {#if loading}<span class="count">loading…</span>{/if}
    <button type="button" class="btn" disabled={!repo} onclick={() => { seq++; }}>Refresh</button>
  </header>

  {#if error}
    <div class="note err">{error}</div>
  {:else if !commits.length && !loading}
    <div class="note">No commits yet.</div>
  {/if}

  <div class="body">
    <div class="rows">
      <svg class="lanes" width={graphW} height={graph.rows.length * ROW_H} aria-hidden="true">
        {#each paths as p (p.stroke)}
          <path d={p.d} stroke={p.stroke} fill="none" stroke-width="1.5" />
        {/each}
        {#each graph.rows as r, i (r.c.sha)}
          <circle
            cx={PAD_X + r.lane * LANE_W}
            cy={i * ROW_H + ROW_H / 2}
            r={r.c.sha === head ? 5 : 3.5}
            fill={color(r.lane)}
            stroke={r.c.sha === head ? '#c5c8c6' : 'none'}
            stroke-width="1.5"
          />
        {/each}
      </svg>

      {#each graph.rows as r, i (r.c.sha)}
        <button
          type="button"
          class="row"
          class:sel={selected === r.c.sha}
          style="padding-left: {graphW}px"
          onclick={() => void select(r.c.sha)}
        >
          {#each r.c.refs as ref (ref)}
            {@const b = badge(ref)}
            <span class="badge {b.kind}">{b.text}</span>
          {/each}
          <span class="subject">{r.c.subject}</span>
          <span class="author">{r.c.author}</span>
          <span class="sha">{short(r.c.sha)}</span>
          <span class="date">{r.c.date}</span>
        </button>
      {/each}

      {#if truncated}
        <div class="note">Showing the most recent 400 commits.</div>
      {/if}
    </div>

    {#if selected}
      <aside class="detail">
        {#if detailError}
          <div class="note err">{detailError}</div>
        {:else if !detail}
          <div class="note">Loading…</div>
        {:else}
          <div class="dhead">
            <span class="dsubject">{detail.subject}</span>
            <button type="button" class="btn close" title="Close details" onclick={() => { selected = ''; detail = null; }}>✕</button>
          </div>
          <div class="meta">{detail.author} &lt;{detail.email}&gt;</div>
          <div class="meta">{detail.date}</div>
          <div class="meta mono">{detail.sha}</div>
          {#if detail.body}<pre class="bodytext">{detail.body}</pre>{/if}
          <div class="fhead">{detail.files.length} file{detail.files.length === 1 ? '' : 's'} changed</div>
          <ul class="files">
            {#if tree}{@render fileTree(tree, 0)}{/if}
          </ul>
        {/if}
      </aside>
    {/if}
  </div>
</div>

{#if toast}<div class="gtoast">{toast}</div>{/if}

<style>
  .graph {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #1e1e1e;
    color: #c5c8c6;
    font-size: 12px;
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    border-bottom: 1px solid #404040;
    background: #252525;
    flex: none;
  }
  .repo { font-weight: 600; }
  .count { color: #8a8a8a; }
  .btn {
    margin-left: auto;
    background: #2d2d2d;
    color: #c5c8c6;
    border: 1px solid #505050;
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .btn:hover { background: #3a3a3a; }
  .note { padding: 8px 12px; color: #8a8a8a; }
  .note.err { color: #e06c75; }
  .body { display: flex; flex: 1; min-height: 0; }
  .rows {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow: auto;
  }
  /* The lanes are scenery: every click belongs to the row behind them. */
  .lanes { position: absolute; top: 0; left: 0; pointer-events: none; }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 24px;
    padding-right: 12px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }
  .row:hover { background: #2a2a2a; }
  .row.sel { background: #37373d; }
  .subject { overflow: hidden; text-overflow: ellipsis; }
  .author, .date, .sha { color: #8a8a8a; flex: none; }
  .sha { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  /* Author and date sit at the right edge, so the subject owns the slack. */
  .author { margin-left: auto; }
  .badge {
    flex: none;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 11px;
    border: 1px solid transparent;
  }
  .badge.head { background: #0e639c; color: #fff; }
  .badge.local { background: #2d2d2d; border-color: #505050; }
  .badge.remote { background: #2d2d2d; border-color: #505050; color: #949494; }
  .badge.tag { background: #3a3020; border-color: #e58520; color: #e58520; }
  .detail {
    flex: none;
    width: 340px;
    border-left: 1px solid #404040;
    background: #232323;
    overflow: auto;
    padding: 8px 10px 16px;
  }
  .dhead { display: flex; align-items: flex-start; gap: 6px; }
  .dsubject { font-weight: 600; flex: 1; }
  .close { margin-left: 0; padding: 0 5px; }
  .meta { color: #949494; margin-top: 3px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .bodytext {
    margin: 8px 0 0;
    padding: 6px 8px;
    background: #1e1e1e;
    border: 1px solid #404040;
    border-radius: 3px;
    white-space: pre-wrap;
    color: #b5b5b5;
  }
  .fhead { margin: 12px 0 4px; color: #8a8a8a; }
  .files { list-style: none; margin: 0; padding: 0; }
  .files li { display: flex; align-items: center; }
  .files li:hover { background: #2a2a2a; }
  .frow {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 2px 0;
    cursor: pointer;
  }
  .fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fname.dir { color: #b5b5b5; }
  .ficon { width: 14px; height: 14px; flex: none; }
  .chev {
    flex: none;
    width: 10px;
    color: #949494;
    display: inline-block;
    transition: transform 0.1s;
  }
  .chev.open { transform: rotate(90deg); }
  /* The action group is the row's hover affordance, so it holds its width at
     all times: appearing out of nowhere would reflow the name mid-click. */
  .factions { flex: none; display: flex; visibility: hidden; }
  .files li:hover .factions,
  .files li:focus-within .factions { visibility: visible; }
  .fact {
    border: 0;
    background: none;
    color: #6e7681;
    cursor: pointer;
    padding: 0 3px;
    font: inherit;
    line-height: 1;
  }
  .fact:hover { color: #c5c8c6; }
  .st { flex: none; width: 12px; text-align: center; color: #949494; }
  .st.A { color: #8bc34a; }
  .st.M { color: #e58520; }
  .st.D { color: #e06c75; }
  .st.R { color: #4aa3df; }
  .gtoast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    background: #272727;
    border: 1px solid #404040;
    border-radius: 6px;
    padding: 6px 14px;
    color: #c5c8c6;
    z-index: 120;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }
</style>
