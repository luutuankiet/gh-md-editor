<script lang="ts">
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

  let { folder, onOpen, onOpenWorkspace }: {
    folder: string;
    onOpen: (path: string, opts: { pinned: boolean }) => void;
    onOpenWorkspace: (path: string) => void;
  } = $props();

  let roots = $state<TreeNode[]>([]);
  let rootError = $state('');
  let menu = $state<{ x: number; y: number; path: string; type: EntryType } | null>(null);
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

  function handleClick(node: TreeNode) {
    if (node.type === 'dir') void toggleDir(node);
    else onOpen(node.path, { pinned: false });
  }

  function handleDblClick(node: TreeNode) {
    if (node.type !== 'dir') onOpen(node.path, { pinned: true });
  }

  function handleContextMenu(e: MouseEvent, node: TreeNode) {
    // Every row gets the menu — files for copy-as-context, dirs additionally
    // for "Open workspace here".
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, path: node.path, type: node.type };
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

  async function copyAsContext(target: string) {
    menu = null;
    try {
      const r = await fetch(`/api/context?path=${encodeURIComponent(target)}&base=${encodeURIComponent(folder)}`);
      const d = await r.json();
      if (!r.ok) { showToast(d.error ?? `HTTP ${r.status}`); return; }
      if (!d.files) { showToast('Nothing to copy (binary or empty).'); return; }
      await toClipboard(d.payload);
      showToast(`Copied ${d.files} file${d.files === 1 ? '' : 's'}${d.skipped ? ` (${d.skipped} skipped)` : ''}.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }
</script>

{#snippet rows(nodes: TreeNode[], depth: number)}
  {#each nodes as node (node.path)}
    <button
      type="button"
      class="row"
      style="padding-left: {8 + depth * 14}px"
      onclick={() => handleClick(node)}
      ondblclick={() => handleDblClick(node)}
      oncontextmenu={(e) => handleContextMenu(e, node)}
      title={node.path}
    >
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

<div class="tree">
  {#if rootError}
    <div class="error">{rootError}</div>
  {:else}
    {@render rows(roots, 0)}
  {/if}
</div>

{#if menu}
  <div class="ctx-menu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
    {#if menu.type === 'dir'}
      <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && pickWorkspace(menu.path)}>
        Open workspace here
      </button>
    {/if}
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && copyAsContext(menu.path)}>
      Copy as context
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
