<script lang="ts">
  import { untrack, tick } from 'svelte';
  import { fileIconUrl, folderIconUrl } from '../../lib/file-icons';

  type EntryType = 'dir' | 'file' | 'link';

  interface TreeNode {
    name: string;
    type: EntryType;
    path: string;
    expanded: boolean;
    loading: boolean;
    children: TreeNode[] | null;
  }

  let { folder, rootInfo = null, activePath = '', onOpen, onOpenWorkspace, onNewTerminal }: {
    folder: string;
    rootInfo?: { root: string; sep: string } | null;
    activePath?: string;
    onOpen: (path: string, opts: { pinned: boolean }) => void;
    onOpenWorkspace: (path: string) => void;
    onNewTerminal: (cwd: string) => void;
  } = $props();

  let roots = $state<TreeNode[]>([]);
  let rootError = $state('');
  let treeEl = $state<HTMLDivElement | undefined>(undefined);
  // The file backing the active editor tab: highlighted, its folders forced
  // open, scrolled into view. Distinct from `selected` (multi-select).
  let activeRow = $state('');
  // Cmd/Ctrl+click multi-select — a Set of node paths, reassigned (never
  // mutated) on change so Svelte sees it.
  let selected = $state<Set<string>>(new Set());
  let menu = $state<{ x: number; y: number; path: string; type: EntryType; paths: string[] } | null>(null);
  let toast = $state('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function joinPath(base: string, name: string): string {
    return base ? `${base}/${name}` : name;
  }

  // One directory per call — children fetched lazily on first expand and
  // cached on the node afterwards. Paths reported up (and sent to the API)
  // are always root-relative: the `folder` prefix is baked in at node creation.
  async function fetchChildren(path: string): Promise<TreeNode[]> {
    const res = await fetch(`/api/tree?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error ?? msg; } catch { /* keep status */ }
      throw new Error(msg);
    }
    const data = await res.json() as { entries: { name: string; type: EntryType }[] };
    return data.entries.map((e) => ({
      name: e.name,
      type: e.type,
      path: joinPath(path, e.name),
      expanded: false,
      loading: false,
      children: null,
    }));
  }

  $effect(() => {
    const f = folder;
    rootError = '';
    fetchChildren(f)
      .then((nodes) => { roots = nodes; })
      .catch((err) => { rootError = err instanceof Error ? err.message : String(err); });
  });

  // Node paths carry the workspace-folder prefix; guides and reveal both
  // reason in folder-relative segments, so strip it in one place.
  function stripFolder(p: string): string {
    return folder && p.startsWith(`${folder}/`) ? p.slice(folder.length + 1) : p;
  }

  // A depth-i guide line is lit when the active file lives underneath the
  // ancestor folder at that depth — the vertical trail VS Code draws from the
  // root down to whatever is open.
  function guideLit(nodePath: string, i: number): boolean {
    if (!activeRow) return false;
    const anc = stripFolder(nodePath).split('/').slice(0, i + 1).join('/');
    const act = stripFolder(activeRow);
    return act === anc || act.startsWith(`${anc}/`);
  }

  // Reveal the active file: expand every ancestor, fetching children on the
  // way so a never-opened subtree still opens, then scroll the row into view.
  async function reveal(target: string) {
    if (!target || target.includes(':')) { activeRow = ''; return; }
    const segs = stripFolder(target).split('/');
    let nodes = roots;
    let acc = folder;
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i];
      const dir = nodes.find((n) => n.path === acc && n.type === 'dir');
      if (!dir) return;
      if (dir.children === null && !dir.loading) {
        dir.loading = true;
        try { dir.children = await fetchChildren(dir.path); }
        catch { dir.children = []; }
        finally { dir.loading = false; }
      }
      dir.expanded = true;
      nodes = dir.children ?? [];
    }
    activeRow = target;
    await tick();
    treeEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // untrack() is load-bearing: reveal both reads and mutates `roots`, so a
  // tracked call would re-enter itself forever.
  $effect(() => {
    const target = activePath;
    untrack(() => { void reveal(target); });
  });

  async function toggleDir(node: TreeNode) {
    if (node.expanded) {
      node.expanded = false;
      return;
    }
    if (node.children === null && !node.loading) {
      node.loading = true;
      try {
        node.children = await fetchChildren(node.path);
      } catch {
        node.children = [];
      } finally {
        node.loading = false;
      }
    }
    node.expanded = true;
  }

  function handleClick(e: MouseEvent, node: TreeNode) {
    if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl+click toggles selection membership without opening anything.
      const next = new Set(selected);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      selected = next;
      return;
    }
    if (selected.size) selected = new Set();
    if (node.type === 'dir') void toggleDir(node);
    else onOpen(node.path, { pinned: false });
  }

  function handleDblClick(node: TreeNode) {
    if (node.type !== 'dir') onOpen(node.path, { pinned: true });
  }

  function handleContextMenu(e: MouseEvent, node: TreeNode) {
    // Every row gets the menu — files for copy-as-context, dirs additionally
    // for "Open workspace here". Right-clicking inside a multi-selection acts
    // on the whole selection; outside it, on the clicked row alone.
    e.preventDefault();
    const paths = selected.has(node.path) && selected.size > 1 ? [...selected] : [node.path];
    menu = { x: e.clientX, y: e.clientY, path: node.path, type: node.type, paths };
  }

  // Click anywhere closes the menu. Listener registered only while the menu
  // is open; the menu item's own click handler runs first (event target),
  // then the bubble reaches window and clears state.
  $effect(() => {
    if (!menu) return;
    const close = () => { menu = null; };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  });

  function pickWorkspace(path: string) {
    menu = null;
    onOpenWorkspace(path);
  }

  function showToast(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; }, 3000);
  }

  // navigator.clipboard exists only in secure contexts (https / localhost).
  // Permissive LAN binds are plain http, so fall back to the hidden-textarea
  // execCommand path there.
  async function toClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try { return await navigator.clipboard.writeText(text); } catch { /* fall through */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  async function copyAsContext(targets: string[]) {
    menu = null;
    try {
      const qs = targets.map((p) => `path=${encodeURIComponent(p)}`).join('&');
      const r = await fetch(`/api/context?${qs}&base=${encodeURIComponent(folder)}&absolute=1`);
      const d = await r.json();
      if (!r.ok) { showToast(d.error ?? `HTTP ${r.status}`); return; }
      if (!d.files) { showToast('Nothing to copy (binary or empty).'); return; }
      await toClipboard(d.payload);
      showToast(`Copied ${d.files} file${d.files === 1 ? '' : 's'}${d.skipped ? ` (${d.skipped} skipped)` : ''}.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }

  // Client-side absolute join — /api/root already exposes root + sep, no
  // extra server round-trip needed.
  function absPath(rel: string): string {
    if (!rootInfo) return rel;
    if (!rel) return rootInfo.root;
    return rootInfo.root + rootInfo.sep + rel.split('/').join(rootInfo.sep);
  }

  async function copyFullPath(paths: string[]) {
    menu = null;
    await toClipboard(paths.map(absPath).join('\n'));
    showToast(paths.length === 1 ? 'Copied full path.' : `Copied ${paths.length} full paths.`);
  }

  function terminalHere(node: { path: string; type: EntryType }) {
    menu = null;
    // Files spawn the shell in their parent folder.
    const dir = node.type === 'dir' ? node.path : node.path.split('/').slice(0, -1).join('/');
    onNewTerminal(dir);
  }
</script>

{#snippet rows(nodes: TreeNode[], depth: number)}
  {#each nodes as node (node.path)}
    <button
      type="button"
      class="row"
      class:selected={selected.has(node.path)}
      class:active={node.path === activeRow}
      data-path={node.path}
      style="padding-left: {8 + depth * 14}px"
      onclick={(e) => handleClick(e, node)}
      ondblclick={() => handleDblClick(node)}
      oncontextmenu={(e) => handleContextMenu(e, node)}
      title={node.path}
    >
      {#each Array(depth) as _, i}
        <span class="guide" class:lit={guideLit(node.path, i)} style="left: {14 + i * 14}px"></span>
      {/each}
      <span class="chevron">{node.type === 'dir' ? (node.expanded ? '▾' : '▸') : ''}</span>
      <img
        class="icon"
        alt=""
        aria-hidden="true"
        src={node.type === 'dir' ? folderIconUrl(node.name, node.expanded) : fileIconUrl(node.name)}
      />
      <span class="name" class:dir={node.type === 'dir'}>{node.name}</span>
      {#if node.loading}<span class="loading">…</span>{/if}
    </button>
    {#if node.type === 'dir' && node.expanded && node.children}
      {@render rows(node.children, depth + 1)}
    {/if}
  {/each}
{/snippet}

<div class="tree" bind:this={treeEl}>
  {#if rootError}
    <div class="error">{rootError}</div>
  {:else}
    {@render rows(roots, 0)}
  {/if}
</div>

{#if menu}
  <div class="ctx-menu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
    {#if menu.type === 'dir' && menu.paths.length === 1}
      <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && pickWorkspace(menu.path)}>
        Open workspace here
      </button>
    {/if}
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && copyAsContext(menu.paths)}>
      Copy as context{#if menu.paths.length > 1}&nbsp;({menu.paths.length}){/if}
    </button>
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && copyFullPath(menu.paths)}>
      Copy full path{#if menu.paths.length > 1}s&nbsp;({menu.paths.length}){/if}
    </button>
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && terminalHere(menu)}>
      Open new terminal here
    </button>
  </div>
{/if}
{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .tree {
    height: 100%;
    overflow: auto;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    background: #0d1117;
    color: #c9d1d9;
    padding: 4px 0;
    box-sizing: border-box;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    line-height: 20px;
  }
  .row:hover { background: rgba(56, 139, 253, 0.12); }
  .row.selected { background: rgba(56, 139, 253, 0.22); }
  .row.active { background: rgba(56, 139, 253, 0.16); }
  .guide {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #21262d;
    pointer-events: none;
  }
  .guide.lit { background: #58a6ff; }
  .chevron {
    width: 12px;
    flex: 0 0 12px;
    display: inline-block;
    color: #8b949e;
  }
  .icon {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.dir { font-weight: 600; }
  .loading { color: #8b949e; }
  .error {
    padding: 8px 12px;
    color: #ff7b72;
    font-size: 12px;
  }
  .ctx-menu {
    position: fixed;
    z-index: 100;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    padding: 4px;
    min-width: 180px;
  }
  .ctx-item {
    display: block;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    text-align: left;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .ctx-item:hover { background: rgba(56, 139, 253, 0.15); }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    color: #c9d1d9;
    z-index: 120;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }
</style>
