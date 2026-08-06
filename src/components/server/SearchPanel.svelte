<script lang="ts">
  import { fileIconUrl } from '../../lib/file-icons';
  import { wrapPref } from '../../lib/wrap-pref.svelte';
  // Workspace search, VS Code layout, backed by the streamed /api/search
  // ripgrep endpoint. Results are rendered as they arrive rather than after
  // the scan completes — the reason the endpoint streams at all.
  let { onOpen, folder = '' }: { onOpen: (path: string, line: number) => void; folder?: string } = $props();

  type Hit = { line: number; text: string; cols: [number, number][] };
  type FileHits = { path: string; hits: Hit[] };

  let query = $state('');
  let include = $state('');
  let matchCase = $state(false);
  let wholeWord = $state(false);
  let useRegex = $state(false);

  let files = $state<FileHits[]>([]);
  let total = $state(0);
  let truncated = $state(false);
  let running = $state(false);
  let error = $state<string | null>(null);
  let collapsed = $state<Record<string, boolean>>({});

  let input: HTMLInputElement | null = null;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Any option change re-runs the search. A stale result set sitting under a
  // freshly-toggled "match case" is worse than paying for a re-scan.
  $effect(() => {
    query;
    include;
    matchCase;
    wholeWord;
    useRegex;
    schedule();
  });

  $effect(() => {
    const onFocus = () => {
      input?.focus();
      input?.select();
    };
    window.addEventListener('gmd:focus-search', onFocus);
    return () => window.removeEventListener('gmd:focus-search', onFocus);
  });

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 220);
  }

  async function run() {
    // Abort first: the server kills its rg on request close, so a fast typist
    // never leaves a pile of scans running behind the current one.
    ctrl?.abort();
    const q = query.trim();
    files = [];
    total = 0;
    truncated = false;
    error = null;
    if (!q) {
      running = false;
      return;
    }

    const c = new AbortController();
    ctrl = c;
    running = true;

    const params = new URLSearchParams({ q });
    // Scope the scan to the anchored workspace. The endpoint already accepts
    // `path` and hands it to ripgrep positionally; without it a window opened
    // on one folder still searched the entire served root.
    if (folder) params.set('path', folder);
    if (matchCase) params.set('case', '1');
    if (wholeWord) params.set('word', '1');
    if (useRegex) params.set('regex', '1');
    if (include.trim()) params.set('glob', include.trim());

    // Accumulated outside $state and copied on flush: mutating an object the
    // proxy already wrapped would not signal, and copying every chunk without
    // a throttle would thrash the DOM on a big result set.
    const batch: FileHits[] = [];
    let cur: FileHits | null = null;
    let lastFlush = 0;
    const flush = (force: boolean) => {
      const now = performance.now();
      if (!force && now - lastFlush < 100) return;
      lastFlush = now;
      files = batch.map((f) => ({ path: f.path, hits: f.hits.slice() }));
    };

    try {
      const res = await fetch(`/api/search?${params}`, { signal: c.signal });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        error = body?.error ?? `HTTP ${res.status}`;
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let tail = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tail += dec.decode(value, { stream: true });
        const lines = tail.split('\n');
        tail = lines.pop() ?? '';
        for (const raw of lines) {
          if (!raw) continue;
          let ev: any;
          try { ev = JSON.parse(raw); } catch { continue; }
          if (ev.t === 'f') {
            cur = { path: ev.path, hits: [] };
            batch.push(cur);
          } else if (ev.t === 'm' && cur) {
            cur.hits.push({ line: ev.line, text: ev.text, cols: ev.cols ?? [] });
            total++;
          } else if (ev.t === 'done') {
            truncated = !!ev.truncated;
          } else if (ev.t === 'err') {
            error = ev.error;
          }
        }
        flush(false);
      }
      flush(true);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') error = String((e as Error)?.message ?? e);
    } finally {
      if (ctrl === c) {
        ctrl = null;
        running = false;
      }
    }
  }

  // Leading indentation is dead width in a 200px sidebar, so it is trimmed —
  // and the match offsets shift with it or every highlight lands wrong.
  function segs(h: Hit) {
    const lead = h.text.length - h.text.trimStart().length;
    const text = h.text.slice(lead);
    const out: { t: string; hit: boolean }[] = [];
    let i = 0;
    for (const [s0, e0] of h.cols) {
      const s = Math.max(0, s0 - lead);
      const e = Math.max(0, e0 - lead);
      if (e <= i) continue;
      if (s > i) out.push({ t: text.slice(i, s), hit: false });
      out.push({ t: text.slice(s, e), hit: true });
      i = e;
    }
    if (i < text.length) out.push({ t: text.slice(i), hit: false });
    return out;
  }

  const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const dirOf = (p: string) => {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  };

  const TREE_KEY = 'ghmd.searchTree';
  let asTree = $state((typeof localStorage !== 'undefined' ? localStorage.getItem(TREE_KEY) : null) !== '0');
  function setTree(on: boolean) {
    asTree = on;
    try { localStorage.setItem(TREE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  }
  let foldedDirs = $state<Record<string, boolean>>({});

  interface DirNode { name: string; dir: string; items: FileHits[]; kids: DirNode[]; hits: number }

  // A real hierarchy, one node per path segment, with single-child chains
  // squashed into one "src / lib" row. Grouping by whole folder string instead
  // put every folder at the same level, which in a large workspace is a flat
  // list of long paths wearing a chevron.
  function buildDirTree(list: FileHits[]): DirNode {
    const root: DirNode = { name: '', dir: '', items: [], kids: [], hits: 0 };
    for (const f of list) {
      const d = dirOf(f.path);
      const segs = d ? d.split('/') : [];
      let node = root;
      for (let i = 0; i < segs.length; i++) {
        const dir = segs.slice(0, i + 1).join('/');
        let kid = node.kids.find((k) => k.dir === dir);
        if (!kid) {
          kid = { name: segs[i], dir, items: [], kids: [], hits: 0 };
          node.kids.push(kid);
        }
        node = kid;
      }
      node.items.push(f);
    }
    squashDirs(root);
    countHits(root);
    return root;
  }

  function squashDirs(n: DirNode) {
    while (n.dir && !n.items.length && n.kids.length === 1) {
      const only = n.kids[0];
      n.name = `${n.name} / ${only.name}`;
      n.dir = only.dir;
      n.items = only.items;
      n.kids = only.kids;
    }
    for (const k of n.kids) squashDirs(k);
  }

  // A folder's count is everything beneath it, so a collapsed row still says
  // how much it is hiding.
  function countHits(n: DirNode): number {
    n.hits = n.items.reduce((s, f) => s + f.hits.length, 0) + n.kids.reduce((s, k) => s + countHits(k), 0);
    return n.hits;
  }

  // Insertion order, deliberately unsorted: results stream in as ripgrep finds
  // them, and re-sorting on every arrival would make rows jump under the
  // cursor mid-scan.
  const tree = $derived(buildDirTree(files));

  function eachDir(n: DirNode, out: string[] = []): string[] {
    for (const k of n.kids) { out.push(k.dir); eachDir(k, out); }
    return out;
  }

  // "Everything shut" is the only state worth detecting: it decides whether
  // the header button offers to collapse or to restore.
  const allShut = $derived(files.length > 0 && files.every((f) => collapsed[f.path]));

  function toggleAll() {
    if (allShut) {
      foldedDirs = {};
      collapsed = {};
      return;
    }
    const fd: Record<string, boolean> = {};
    for (const d of eachDir(tree)) fd[d] = true;
    foldedDirs = fd;
    const c: Record<string, boolean> = {};
    for (const f of files) c[f.path] = true;
    collapsed = c;
  }

  function clearSearch() {
    query = '';
    files = [];
    total = 0;
    truncated = false;
    error = null;
    input?.focus();
  }
</script>

<div class="spanel">
  <div class="sbar">
    <span class="sbar-label">Search</span>
    <span class="sbar-gap"></span>
    {#if running}
      <span class="sbar-sub">searching…</span>
    {:else if query.trim() && !error}
      <span class="sbar-sub">{total}{truncated ? '+' : ''} in {files.length} file{files.length === 1 ? '' : 's'}</span>
    {/if}
  </div>

  <div class="sfields">
    <div class="sinput">
      <input
        bind:this={input}
        bind:value={query}
        placeholder="Search"
        spellcheck="false"
        autocomplete="off"
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } }}
      />
      <span class="sopts">
        <button type="button" class:on={matchCase} title="Match case" onclick={() => (matchCase = !matchCase)}>Aa</button>
        <button type="button" class:on={wholeWord} title="Match whole word" onclick={() => (wholeWord = !wholeWord)}>ab</button>
        <button type="button" class:on={useRegex} title="Use regular expression" onclick={() => (useRegex = !useRegex)}>.*</button>
      </span>
    </div>
    <input class="sglob" bind:value={include} placeholder="files to include" spellcheck="false" autocomplete="off" />
  </div>

  {#if files.length}
    <div class="sviewbar">
      <button type="button" class:on={asTree} title="Group results by folder" onclick={() => setTree(true)}>Tree</button>
      <button type="button" class:on={!asTree} title="Flat list of files" onclick={() => setTree(false)}>List</button>
      <span class="sv-gap"></span>
      <button
        type="button"
        class="sv-icon"
        title={allShut ? 'Expand all' : 'Collapse all'}
        aria-label={allShut ? 'Expand all' : 'Collapse all'}
        onclick={toggleAll}
      >
        {#if allShut}
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 7 8 3.4 12 7" /><path d="M4 9 8 12.6 12 9" /></svg>
        {:else}
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3.4 8 7l4-3.6" /><path d="M4 12.6 8 9l4 3.6" /></svg>
        {/if}
      </button>
      <button type="button" class="sv-icon" title="Search again" aria-label="Search again" onclick={() => run()}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2a4.8 4.8 0 1 0 4.6 6.1" /><path d="M8 1.2v4h4" /></svg>
      </button>
      <button type="button" class="sv-icon" title="Clear results" aria-label="Clear results" onclick={clearSearch}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </div>
  {/if}
  <div class="sresults" class:wrapon={wrapPref.on}>
    {#if error}
      <div class="smsg err">{error}</div>
    {:else if query.trim() && !running && files.length === 0}
      <div class="smsg">No results</div>
    {/if}
    {#snippet fileGroup(f: FileHits, showDir: boolean, depth: number)}
      <div class="sfile">
        <button type="button" class="sfile-head" style="padding-left: {6 + depth * 10}px" onclick={() => (collapsed[f.path] = !collapsed[f.path])}>
          <svg class="chev" class:open={!collapsed[f.path]} viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5z" /></svg>
          <img class="sicon" alt="" aria-hidden="true" src={fileIconUrl(baseOf(f.path))} />
          <span class="sfile-name">{baseOf(f.path)}</span>
          {#if showDir}<span class="sfile-dir">{dirOf(f.path)}</span>{/if}
          <span class="sfile-count">{f.hits.length}</span>
        </button>
        {#if !collapsed[f.path]}
          <ul class="shits" style="padding-left: {10 + depth * 10}px">
            {#each f.hits as h, hi (hi)}
              <li>
                <button type="button" class="shit" onclick={() => onOpen(f.path, h.line)}>
                  <span class="shit-ln">{h.line}</span>
                  <span class="shit-text">{#each segs(h) as s}{#if s.hit}<mark>{s.t}</mark>{:else}{s.t}{/if}{/each}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/snippet}
    <!-- Recursive: a folder renders its own children through the same snippet. -->
    {#snippet dirTree(node: DirNode, depth: number)}
      {#each node.kids as k (k.dir)}
        <div class="sdir">
          <button
            type="button"
            class="sfile-head sdir-head"
            style="padding-left: {6 + depth * 10}px"
            title={k.dir}
            onclick={() => (foldedDirs[k.dir] = !foldedDirs[k.dir])}
          >
            <svg class="chev" class:open={!foldedDirs[k.dir]} viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5z" /></svg>
            <span class="sfile-name">{k.name}</span>
            <span class="sfile-count">{k.hits}</span>
          </button>
          {#if !foldedDirs[k.dir]}
            <div class="sdir-body">{@render dirTree(k, depth + 1)}</div>
          {/if}
        </div>
      {/each}
      {#each node.items as f (f.path)}{@render fileGroup(f, false, depth)}{/each}
    {/snippet}
    {#if asTree}
      {@render dirTree(tree, 0)}
    {:else}
      {#each files as f (f.path)}{@render fileGroup(f, true, 0)}{/each}
    {/if}
    {#if truncated}
      <div class="smsg">result cap reached — narrow the query</div>
    {/if}
  </div>
</div>

<style>
  .spanel {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
  }
  .sbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 4px 12px;
  }
  .sbar-label {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #949494;
  }
  .sbar-gap { flex: 1 1 auto; }
  .sbar-sub {
    font-size: 11px;
    color: #8a8a8a;
    white-space: nowrap;
  }
  .sfields {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 8px 6px 10px;
  }
  .sinput {
    display: flex;
    align-items: center;
    background: #1e1e1e;
    border: 1px solid #404040;
    border-radius: 4px;
  }
  .sinput:focus-within { border-color: #e58520; }
  .sinput input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 3px 6px;
    border: none;
    background: transparent;
    color: #c5c8c6;
    font-size: 12px;
    outline: none;
  }
  .sopts {
    flex: 0 0 auto;
    display: flex;
    gap: 1px;
    padding-right: 2px;
  }
  .sopts button {
    width: 20px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: #8a8a8a;
    font-size: 11px;
    font-family: ui-monospace, Menlo, monospace;
    cursor: pointer;
  }
  .sopts button:hover { background: #353535; color: #c5c8c6; }
  .sopts button.on {
    background: #3655b555;
    color: #c5c8c6;
    box-shadow: inset 0 0 0 1px #e58520;
  }
  .sglob {
    padding: 3px 6px;
    border: 1px solid #404040;
    border-radius: 4px;
    background: transparent;
    color: #c5c8c6;
    font-size: 12px;
    outline: none;
  }
  .sglob:focus { border-color: #e58520; }
  .sresults {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding-bottom: 8px;
  }
  .smsg {
    padding: 6px 12px;
    font-size: 12px;
    color: #949494;
  }
  .smsg.err { color: #f85149; }
  .sfile-head {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 2px 8px 2px 4px;
    border: none;
    background: transparent;
    color: #c5c8c6;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .sfile-head:hover { background: #272727; }
  /* Same seat and size as the explorer's, so a result reads as the same file. */
  .sicon {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
  }
  .chev {
    flex: 0 0 auto;
    width: 12px;
    height: 12px;
    fill: #949494;
    transition: transform 0.1s linear;
  }
  .chev.open { transform: rotate(90deg); }
  .sfile-name {
    flex: 0 0 auto;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sfile-dir {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    font-size: 11px;
    color: #8a8a8a;
  }
  .sfile-count {
    flex: 0 0 auto;
    min-width: 16px;
    padding: 0 5px;
    border-radius: 8px;
    background: #353535;
    color: #949494;
    font-size: 10px;
    line-height: 15px;
    text-align: center;
  }
  .shits {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .shit {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 1px 8px 1px 20px;
    border: none;
    background: transparent;
    color: #949494;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11.5px;
    text-align: left;
    cursor: pointer;
  }
  .shit:hover { background: #272727; color: #c5c8c6; }
  .shit-ln {
    flex: 0 0 auto;
    min-width: 26px;
    color: #8a8a8a;
    text-align: right;
  }
  .shit-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }
  mark {
    background: #3655b566;
    color: inherit;
    border-radius: 2px;
  }
  .sviewbar {
    display: flex;
    gap: 2px;
    padding: 2px 8px 4px;
    border-bottom: 1px solid #404040;
  }
  .sviewbar button {
    border: 1px solid #505050;
    border-radius: 3px;
    background: #2d2d2d;
    color: #949494;
    font-size: 10px;
    padding: 1px 7px;
    cursor: pointer;
  }
  .sviewbar button.on {
    background: #353535;
    color: #c5c8c6;
    border-color: #e58520;
  }
  .sdir-head { color: #8a8a8a; }
  .sdir-body { padding-left: 12px; }
  /* Rows size to their own content and are only FLOORED at the panel width,
     so a long match extends the scroll region instead of being cut with an
     ellipsis — the thing that made a hit in minified or deeply indented code
     unreadable. Every clip below has to be lifted for that to work: an
     ellipsis anywhere inside leaves the scroller nothing to reveal. */
  .sresults { overflow-x: auto; }
  .sfile-head,
  .shit {
    width: max-content;
    min-width: 100%;
  }
  .sfile-name { max-width: none; }
  .sfile-dir {
    flex: 0 0 auto;
    direction: ltr;
    overflow: visible;
    text-overflow: clip;
  }
  .shit-text {
    flex: 0 0 auto;
    overflow: visible;
    text-overflow: clip;
  }

  /* Wrap on: give up that horizontal scroller and let a long hit take as many
     rows as it needs. Every max-content width above has to come back to 100%
     first — leave one in place and the row keeps sizing to its longest line,
     so there is nothing for the wrap to happen inside. */
  .sresults.wrapon { overflow-x: hidden; }
  .sresults.wrapon .sfile-head,
  .sresults.wrapon .shit {
    width: 100%;
    min-width: 0;
  }
  .sresults.wrapon .shit-text {
    flex: 1 1 auto;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .sv-gap { flex: 1; }
  .sv-icon {
    line-height: 0;
    padding: 2px;
  }
  .sv-icon svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
