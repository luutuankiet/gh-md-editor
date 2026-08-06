<script lang="ts">
  import { untrack, tick } from 'svelte';
  import { fileIconUrl, folderIconUrl } from '../../lib/file-icons';
  import { toClipboard } from '../../lib/clipboard';
  import { estimateTokens, formatTokens } from '../../lib/token-estimate';

  type EntryType = 'dir' | 'file' | 'link';

  interface TreeNode {
    name: string;
    type: EntryType;
    ignored?: boolean;
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
  // A plain click seeds `selected` with the row it opened, so a following
  // Cmd/Ctrl+click extends from it instead of starting over. That seeded state
  // is implicit: the loud multi-select tint only shows once the user has
  // actually reached for Cmd or Shift.
  let selectionExplicit = $state(false);
  let menu = $state<{ x: number; y: number; path: string; type: EntryType; paths: string[] } | null>(null);
  let toast = $state('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = $state(false);
  // Shift+click extends from the last row touched by a plain or Cmd/Ctrl click.
  let anchorPath = '';
  // The one row that renders as an input instead of a button: either a new
  // entry being named, or an existing one being renamed.
  let editing = $state<
    | { mode: 'create'; parent: string; type: EntryType; name: string }
    | { mode: 'rename'; path: string; parent: string; name: string }
    | null
  >(null);
  // Paths being dragged, and the folder they would land in.
  let dragPaths = $state<string[]>([]);
  let dropDir = $state<string | null>(null);
  // Private to this tree: a public MIME type would let a stray drop paste
  // these paths as text into an open document.
  const TREE_DND_MIME = 'application/x-gmd-tree-paths';

  function parentOf(p: string) {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  function baseOf(p: string) {
    return p.split('/').pop() ?? p;
  }

  const joinIn = joinPath;

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
    const data = await res.json() as { entries: { name: string; type: EntryType; ignored?: boolean }[] };
    return data.entries.map((e) => ({
      name: e.name,
      type: e.type,
      ignored: e.ignored,
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

  // Rows in the order they are painted, respecting collapsed folders — the
  // coordinate space a shift-range has to be computed in.
  function flatten(nodes: TreeNode[], out: string[] = []): string[] {
    for (const n of nodes) {
      out.push(n.path);
      if (n.type === 'dir' && n.expanded && n.children) flatten(n.children, out);
    }
    return out;
  }

  function collectExpanded(nodes: TreeNode[], out: string[] = []): string[] {
    for (const n of nodes) {
      if (n.type === 'dir' && n.expanded) {
        out.push(n.path);
        if (n.children) collectExpanded(n.children, out);
      }
    }
    return out;
  }

  // Collapse-all is a toggle, not a one-way door: the second press restores
  // exactly the folders that were open before, so a mis-click costs nothing.
  let lastExpanded: string[] = [];
  let anyExpanded = $derived(collectExpanded(roots).length > 0);

  function collapseAll(nodes: TreeNode[]) {
    for (const n of nodes) {
      if (n.type !== 'dir') continue;
      n.expanded = false;
      if (n.children) collapseAll(n.children);
    }
  }

  async function toggleCollapseAll() {
    const open = collectExpanded(roots);
    if (open.length) {
      lastExpanded = open;
      collapseAll(roots);
      return;
    }
    // collectExpanded reports parents before children, so replaying the list
    // in order always has the parent open before its child is asked for.
    for (const p of lastExpanded) await expandPath(p);
  }

  // Force a path open, fetching each level on the way. Unlike reveal() this
  // expands the target itself, not just its ancestors.
  async function expandPath(target: string) {
    const segs = stripFolder(target).split('/');
    let nodes = roots;
    let acc = folder;
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      const dir = nodes.find((n) => n.path === acc && n.type === 'dir');
      if (!dir) return;
      if (dir.children === null) {
        try { dir.children = await fetchChildren(dir.path); }
        catch { dir.children = []; }
      }
      dir.expanded = true;
      nodes = dir.children ?? [];
    }
  }

  // Re-read the workspace from disk after something changed it behind our back
  // (a terminal command, another session, an agent). The tree is rebuilt from
  // scratch, then the previously-open folders and the active file are walked
  // back open so the view looks untouched apart from the new reality.
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const open = collectExpanded(roots);
    const keepActive = activeRow;
    try {
      roots = await fetchChildren(folder);
      rootError = '';
      for (const p of open) await expandPath(p);
      if (keepActive) await reveal(keepActive);
    } catch (err) {
      rootError = err instanceof Error ? err.message : String(err);
    } finally {
      refreshing = false;
    }
  }

  // The command palette's "Refresh Explorer" reaches the tree through here.
  $effect(() => {
    const on = () => { void refresh(); };
    window.addEventListener('gmd:refresh-explorer', on);
    return () => window.removeEventListener('gmd:refresh-explorer', on);
  });

  function handleClick(e: MouseEvent, node: TreeNode) {
    if (e.shiftKey && anchorPath) {
      // Range select across the visible rows, VS Code style. No open, no
      // anchor move — a second shift+click re-extends from the same anchor.
      const flat = flatten(roots);
      const a = flat.indexOf(anchorPath);
      const b = flat.indexOf(node.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        selected = new Set(flat.slice(lo, hi + 1));
        selectionExplicit = true;
        return;
      }
    }
    anchorPath = node.path;
    if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl+click toggles selection membership without opening anything.
      const next = new Set(selected);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      selected = next;
      selectionExplicit = true;
      return;
    }
    selected = new Set([node.path]);
    selectionExplicit = false;
    if (node.type === 'dir') void toggleDir(node);
    else onOpen(node.path, { pinned: false });
  }

  // Double-click renames. Opening a file pinned still lives on the tab strip's
  // own double-click, so nothing is lost by repurposing this one.
  function handleDblClick(node: TreeNode) {
    startRename(node.path);
  }

  function startRename(path: string) {
    menu = null;
    editing = { mode: 'rename', path, parent: parentOf(path), name: baseOf(path) };
  }

  // Right-clicking a folder creates inside it; a file creates beside it.
  async function startCreate(type: EntryType) {
    const target = menu;
    menu = null;
    if (!target) return;
    const parent = target.type === 'dir' ? target.path : parentOf(target.path);
    // The draft row has to be somewhere visible, so the parent opens first.
    if (parent && parent !== folder) await expandPath(parent);
    editing = { mode: 'create', parent, type, name: '' };
  }

  // Focus and pre-select on mount. A leading dot is the whole name
  // (.gitignore), not an extension, so only an inner dot splits.
  function focusName(el: HTMLInputElement) {
    el.focus();
    const dot = el.value.lastIndexOf('.');
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }

  async function commitEdit() {
    const ed = editing;
    editing = null;
    if (!ed) return;
    const name = ed.name.trim();
    if (!name || name.includes('/')) return;
    if (ed.mode === 'rename') {
      const to = joinIn(ed.parent, name);
      if (to === ed.path) return;
      await moveEntries([{ from: ed.path, to }]);
      return;
    }
    const target = joinIn(ed.parent, name);
    try {
      const res = await fetch('/api/entry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target, type: ed.type }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      await refresh();
      window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
      if (ed.type === 'dir') await expandPath(target);
      else onOpen(target, { pinned: true });
    } catch (err) {
      showToast(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rename and drag-move are the same server call; the only thing that differs
  // is whether the parent folder changes.
  async function moveEntries(moves: { from: string; to: string }[]) {
    if (!moves.length) return;
    try {
      const res = await fetch('/api/entry', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ moves }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const done: { from: string; to: string }[] = data.moved ?? [];
      if (done.length) {
        // Tabs are keyed by path, so every open reference has to follow the
        // file rather than linger pointing at a name that no longer exists.
        window.dispatchEvent(new CustomEvent('gmd:paths-moved', { detail: { moves: done } }));
        window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
        selected = new Set(done.map((m) => m.to));
      }
      await refresh();
      if (data.errors?.length) {
        showToast(`Moved ${done.length}, failed ${data.errors.length}: ${data.errors[0].error}`);
      } else if (done.length > 1) {
        showToast(`Moved ${done.length} items.`);
      }
    } catch (err) {
      showToast(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Dragging a row inside the selection carries the whole selection; dragging
  // one outside it carries that row alone.
  function handleRowDragStart(e: DragEvent, node: TreeNode) {
    dragPaths = selected.has(node.path) && selected.size > 1 ? [...selected] : [node.path];
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TREE_DND_MIME, dragPaths.join('\n'));
    }
  }

  // Dropping on a file means dropping into the folder that holds it.
  function dropParentFor(node: TreeNode) {
    return node.type === 'dir' ? node.path : parentOf(node.path);
  }

  function badDrop(dest: string) {
    // Into itself, into its own subtree, or back where it already lives.
    return dragPaths.some((p) => dest === p || dest.startsWith(`${p}/`) || parentOf(p) === dest);
  }

  // A drag from the desktop or another window carries 'Files' and no tree
  // paths. Same gesture, different meaning — copy in, rather than move around
  // — so the two are told apart before anything else happens.
  function isFileDrag(e: DragEvent) {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  }

  function handleRowDragOver(e: DragEvent, node: TreeNode) {
    const dest = dropParentFor(node);
    if (isFileDrag(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (dropDir !== dest) dropDir = dest;
      return;
    }
    if (!dragPaths.length) return;
    if (badDrop(dest)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (dropDir !== dest) dropDir = dest;
  }

  function handleRowDrop(e: DragEvent, node: TreeNode) {
    e.preventDefault();
    // Without this the tree background would treat the same drop as a move to
    // the workspace root.
    e.stopPropagation();
    const dest = dropParentFor(node);
    const paths = dragPaths;
    dragPaths = [];
    dropDir = null;
    if (isFileDrag(e) && e.dataTransfer) return void uploadDrop(e.dataTransfer, dest);
    if (!paths.length || badDrop(dest)) return;
    void moveEntries(paths.map((p) => ({ from: p, to: joinIn(dest, baseOf(p)) })));
  }

  function handleRootDragOver(e: DragEvent) {
    if (isFileDrag(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      return;
    }
    if (!dragPaths.length) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function handleRootDrop(e: DragEvent) {
    e.preventDefault();
    const paths = dragPaths;
    dragPaths = [];
    dropDir = null;
    if (isFileDrag(e) && e.dataTransfer) return void uploadDrop(e.dataTransfer, folder);
    if (!paths.length) return;
    void moveEntries(
      paths
        .filter((p) => parentOf(p) !== folder)
        .map((p) => ({ from: p, to: joinIn(folder, baseOf(p)) }))
    );
  }

  function handleContextMenu(e: MouseEvent, node: TreeNode) {
    // Every row gets the menu — files for copy-as-context, dirs additionally
    // for "Open workspace here". Right-clicking inside a multi-selection acts
    // on the whole selection; outside it, on the clicked row alone.
    e.preventDefault();
    if (!selected.has(node.path)) {
      // Right-clicking outside the selection moves the selection to that row.
      selected = new Set([node.path]);
      selectionExplicit = false;
      anchorPath = node.path;
    }
    const paths = selected.size > 1 ? [...selected] : [node.path];
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

  // Double-click on blank tree space is VS Code's "new file here". Guarded on
  // the target being the container itself, so a double-click that lands on a
  // row (expand, rename) keeps its own behaviour. Creates at the workspace
  // root, which is the only parent blank space can mean.
  // Blank space and the header buttons both mean "at the top level", which the
  // context-menu path cannot express — that one always has a row to anchor to.
  function createAtRoot(type: EntryType) {
    menu = null;
    editing = { mode: 'create', parent: folder, type, name: '' };
  }

  function handleRootDblClick(e: MouseEvent) {
    if (e.target !== treeEl) return;
    createAtRoot('file');
  }

  function showToast(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; }, 3000);
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
      // The point of copying files as context is pasting them into a model, so
      // the size that matters is tokens, not files or bytes.
      const tokens = formatTokens(estimateTokens(d.payload));
      showToast(
        `Copied ${d.files} file${d.files === 1 ? '' : 's'} · ~${tokens} tokens` +
          (d.skipped ? ` (${d.skipped} skipped)` : ''),
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }

  // Client-side absolute join — /api/root already exposes root + sep, no
  // extra server round-trip needed.
  function absPath(rel: string): string {
    if (!rootInfo) return rel;
    if (rel.startsWith('/')) return rel; // outside-root anchor: already absolute
    if (!rel) return rootInfo.root;
    return rootInfo.root + rootInfo.sep + rel.split('/').join(rootInfo.sep);
  }

  async function copyFullPath(paths: string[]) {
    menu = null;
    await toClipboard(paths.map(absPath).join('\n'));
    showToast(paths.length === 1 ? 'Copied full path.' : `Copied ${paths.length} full paths.`);
  }

  // Destructive and irreversible — confirmation is mandatory, and the server
  // re-validates every path anyway (and refuses the workspace root).
  async function deleteEntries(paths: string[]) {
    menu = null;
    if (!paths.length) return;
    const names = paths.map((p) => p.split('/').pop()).join(', ');
    const what = paths.length === 1 ? names : `${paths.length} items (${names})`;
    if (!window.confirm(`Delete ${what}? Folders are removed with everything inside. This cannot be undone.`)) return;
    const qs = paths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
    try {
      const res = await fetch(`/api/entry?${qs}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const gone: string[] = data.deleted ?? [];
      if (gone.length) {
        // Tabs backed by a deleted file must not linger as ghosts.
        window.dispatchEvent(new CustomEvent('gmd:paths-deleted', { detail: { paths: gone } }));
        window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
      }
      showToast(
        data.errors?.length
          ? `Deleted ${gone.length}, failed ${data.errors.length}: ${data.errors[0].error}`
          : `Deleted ${gone.length} item${gone.length === 1 ? '' : 's'}.`
      );
      selected = new Set();
      selectionExplicit = false;
      anchorPath = '';
      await refresh();
    } catch (e) {
      showToast(String((e as Error)?.message ?? e));
    }
  }

  // A plain <a download> offers no progress and no way out, which is the wrong
  // trade when one right-click can pack a node_modules. Streaming the response
  // through fetch buys both: bytes as they land, and an abort that propagates
  // to the server — it awaits every socket write, so a cancelled reader stops
  // the walk rather than leaving it zipping into the void.
  // One card per transfer, download or upload alike: both want a name, a bar
  // and a cancel button, and two stacks would fight over the same corner.
  interface Job {
    id: number;
    name: string;
    got: number;
    total: number;
    // Zip size is measured uncompressed, so the bar is an approximation.
    est: boolean;
    state: 'active' | 'done' | 'error' | 'cancelled';
    error?: string;
    // A download aborts a fetch and an upload aborts an XHR; the card only
    // needs to know that something can be stopped.
    cancel: () => void;
    verb: string;
  }
  let jobs = $state<Job[]>([]);
  let jobSeq = 0;

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  }

  function filenameFrom(cd: string | null): string {
    if (!cd) return '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
    return /filename="([^"]+)"/i.exec(cd)?.[1] ?? '';
  }

  function dropJob(job: Job, after: number) {
    setTimeout(() => { jobs = jobs.filter((j) => j.id !== job.id); }, after);
  }

  async function download(paths: string[]) {
    menu = null;
    if (!paths.length) return;
    const qs = paths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
    const ctl = new AbortController();
    jobs = [...jobs, {
      id: ++jobSeq,
      name: paths.length === 1 ? paths[0].split('/').pop() ?? 'download' : `${paths.length} items`,
      got: 0,
      total: 0,
      est: false,
      state: 'active',
      verb: 'Saved',
      cancel: () => ctl.abort(),
    }];
    // Mutations have to go through the state proxy the array handed back, not
    // the literal above, or the card never repaints.
    const job = jobs[jobs.length - 1];
    try {
      const r = await fetch(`/api/download?${qs}&base=${encodeURIComponent(folder)}`, { signal: ctl.signal });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      const est = r.headers.get('x-gmd-bytes');
      job.total = Number(est ?? r.headers.get('content-length') ?? 0) || 0;
      job.est = est !== null;
      job.name = filenameFrom(r.headers.get('content-disposition')) || job.name;
      const reader = r.body?.getReader();
      let blob: Blob;
      if (reader) {
        const chunks: BlobPart[] = [];
        let got = 0;
        let painted = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          // Repainting per 64 KB chunk would spend more time on the card than
          // on the download.
          const now = Date.now();
          if (now - painted > 80) { painted = now; job.got = got; }
        }
        job.got = got;
        blob = new Blob(chunks);
      } else {
        blob = await r.blob();
        job.got = blob.size;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = job.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      job.state = 'done';
      dropJob(job, 4000);
    } catch (e) {
      const aborted = ctl.signal.aborted;
      job.state = aborted ? 'cancelled' : 'error';
      if (!aborted) job.error = e instanceof Error ? e.message : String(e);
      dropJob(job, aborted ? 2500 : 8000);
    }
  }

  // --- upload ---------------------------------------------------------------

  interface Picked { file: File; rel: string }

  let overwriteAsk = $state<
    { names: string[]; resolve: (v: 'overwrite' | 'skip' | null) => void } | null
  >(null);

  // Only webkitGetAsEntry can see inside a dropped folder — DataTransfer.files
  // lists the top level and omits directories outright, so a dropped tree
  // would otherwise arrive as nothing at all.
  async function walkEntry(entry: FileSystemEntry, prefix: string, out: Picked[]) {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel: prefix + entry.name });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands back one batch at a time and signals the end with an
    // empty one, so a single call quietly truncates a large folder.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }

  async function uploadDrop(dt: DataTransfer, dest: string) {
    // Both reads happen before the first await: the DataTransfer is neutered
    // the moment the drop handler returns.
    const entries = Array.from(dt.items ?? [])
      .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
      .filter((x): x is FileSystemEntry => !!x);
    const flat = Array.from(dt.files ?? []).map((file) => ({ file, rel: file.name }));
    let picked: Picked[] = [];
    try {
      for (const entry of entries) await walkEntry(entry, '', picked);
    } catch (e) {
      showToast(`Could not read the drop: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!picked.length) picked = flat;
    await uploadFiles(dest, picked);
  }

  async function uploadFiles(dest: string, picked: Picked[]) {
    if (!picked.length) return;
    let queue = picked.map((p) => ({ ...p, path: joinIn(dest, p.rel) }));
    let existing: string[] = [];
    try {
      const qs = queue.map((t) => `path=${encodeURIComponent(t.path)}`).join('&');
      const r = await fetch(`/api/exists?${qs}`);
      if (r.ok) existing = (await r.json()).existing ?? [];
    } catch { /* a failed probe just means no prompt — the writes still answer */ }
    if (existing.length) {
      const answer = await new Promise<'overwrite' | 'skip' | null>((resolve) => {
        overwriteAsk = { names: existing, resolve };
      });
      overwriteAsk = null;
      if (!answer) return;
      if (answer === 'skip') {
        const clash = new Set(existing);
        queue = queue.filter((t) => !clash.has(t.path));
      }
      if (!queue.length) { showToast('Nothing to upload — every file was already there.'); return; }
    }

    const total = queue.reduce((n, t) => n + t.file.size, 0);
    let sent = 0;
    let stopped = false;
    let live: XMLHttpRequest | null = null;
    jobs = [...jobs, {
      id: ++jobSeq,
      name: queue.length === 1 ? queue[0].rel : `${queue.length} files`,
      got: 0,
      total,
      est: false,
      state: 'active',
      verb: 'Uploaded',
      cancel: () => { stopped = true; live?.abort(); },
    }];
    const job = jobs[jobs.length - 1];
    const failed: string[] = [];
    for (const t of queue) {
      if (stopped) break;
      // XHR rather than fetch: only its upload object reports progress, and a
      // bar that jumps from 0 to 100 is not a progress bar.
      const result = await new Promise<string>((resolve) => {
        const xhr = new XMLHttpRequest();
        live = xhr;
        xhr.open('POST', '/api/upload');
        xhr.setRequestHeader('x-gmd-path', encodeURIComponent(t.path));
        xhr.upload.onprogress = (ev) => { job.got = sent + ev.loaded; };
        xhr.onload = () => {
          if (xhr.status === 200) return resolve('');
          let msg = `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch { /* keep the status */ }
          resolve(msg);
        };
        xhr.onerror = () => resolve('network error');
        xhr.onabort = () => { stopped = true; resolve('cancelled'); };
        xhr.send(t.file);
      });
      live = null;
      sent += t.file.size;
      job.got = sent;
      if (result && result !== 'cancelled') failed.push(`${t.rel}: ${result}`);
    }
    job.state = stopped ? 'cancelled' : failed.length ? 'error' : 'done';
    if (failed.length) job.error = failed[0];
    dropJob(job, failed.length ? 8000 : 3000);
    await refresh();
    if (failed.length) showToast(`Uploaded ${queue.length - failed.length}, failed ${failed.length}: ${failed[0]}`);
  }

  // --- clipboard --------------------------------------------------------

  // The explorer's own clipboard, not the system one: these paths mean nothing
  // outside this tree, and the system clipboard is already spoken for by "Copy
  // full path". A cut is a move that has not happened yet — the rows dim to
  // say so, Escape calls it off, and nothing on disk has moved until a paste.
  let clip = $state<{ mode: 'cut' | 'copy'; paths: string[] } | null>(null);
  const cutSet = $derived(new Set(clip?.mode === 'cut' ? clip.paths : []));

  function setClip(paths: string[], mode: 'cut' | 'copy') {
    menu = null;
    if (!paths.length) return;
    clip = { mode, paths: [...paths] };
    showToast(`${mode === 'cut' ? 'Cut' : 'Copied'} ${paths.length} item${paths.length === 1 ? '' : 's'}. Paste to place, Esc to cancel.`);
  }

  function findNode(p: string, nodes: TreeNode[] = roots): TreeNode | null {
    for (const n of nodes) {
      if (n.path === p) return n;
      if (n.children) {
        const hit = findNode(p, n.children);
        if (hit) return hit;
      }
    }
    return null;
  }

  // A folder takes the paste; a file hands it to the folder holding it.
  function pasteTarget(): string {
    const one = anchorPath || [...selected][0] || '';
    if (!one) return folder;
    return findNode(one)?.type === 'dir' ? one : parentOf(one) || folder;
  }

  function paste(dest: string) {
    menu = null;
    const c = clip;
    if (!c) return;
    if (c.mode === 'cut') {
      // A cut is spent on its first paste, the same as everywhere else.
      clip = null;
      const moves = c.paths
        .filter((p) => dest !== p && !dest.startsWith(`${p}/`) && parentOf(p) !== dest)
        .map((p) => ({ from: p, to: joinIn(dest, baseOf(p)) }));
      if (!moves.length) { showToast('Already there.'); return; }
      void moveEntries(moves);
      return;
    }
    // A copy stays loaded: pasting one folder into three places is one copy
    // and three pastes.
    void copyEntries(c.paths.map((p) => ({ from: p, to: joinIn(dest, baseOf(p)) })));
  }

  async function copyEntries(copies: { from: string; to: string }[]) {
    if (!copies.length) return;
    try {
      const res = await fetch('/api/entry/copy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ copies }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      // The server renames around collisions, so where each item landed is
      // something only it can report.
      const done: { from: string; to: string }[] = data.copied ?? [];
      await refresh();
      if (done.length) {
        window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
        selected = new Set(done.map((c) => c.to));
        selectionExplicit = done.length > 1;
      }
      showToast(
        data.errors?.length
          ? `Pasted ${done.length}, failed ${data.errors.length}: ${data.errors[0].error}`
          : `Pasted ${done.length} item${done.length === 1 ? '' : 's'}.`
      );
    } catch (err) {
      showToast(`Paste failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function focusRow(p: string) {
    treeEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)?.focus();
  }

  function moveTo(p: string) {
    anchorPath = p;
    selected = new Set([p]);
    selectionExplicit = false;
    focusRow(p);
  }

  // Keys are caught on the container so they work wherever focus sits inside
  // the tree, including on a row that was reached with the arrows.
  function handleTreeKey(e: KeyboardEvent) {
    if (editing) return; // the naming input owns its own keys
    const mod = e.metaKey || e.ctrlKey;
    const paths = selected.size ? [...selected] : anchorPath ? [anchorPath] : [];
    const key = e.key.toLowerCase();
    if (mod && key === 'c') { e.preventDefault(); setClip(paths, 'copy'); return; }
    if (mod && key === 'x') { e.preventDefault(); setClip(paths, 'cut'); return; }
    if (mod && key === 'v') { e.preventDefault(); paste(pasteTarget()); return; }
    if (e.key === 'Escape' && clip) { e.preventDefault(); clip = null; return; }
    if (e.key === 'Delete' && paths.length) { e.preventDefault(); void deleteEntries(paths); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const flat = flatten(roots);
      const at = flat.indexOf(anchorPath || activeRow);
      const next = flat[Math.max(0, Math.min(flat.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) moveTo(next);
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const node = anchorPath ? findNode(anchorPath) : null;
      if (!node) return;
      e.preventDefault();
      if (e.key === 'ArrowRight') {
        // Right on a closed folder opens it; on anything else it steps in.
        if (node.type === 'dir' && !node.expanded) { void toggleDir(node); return; }
        const flat = flatten(roots);
        const next = flat[flat.indexOf(node.path) + 1];
        if (next) moveTo(next);
        return;
      }
      if (node.type === 'dir' && node.expanded) { node.expanded = false; return; }
      const up = parentOf(node.path);
      if (up && up !== folder) moveTo(up);
    }
  }

  function terminalHere(node: { path: string; type: EntryType }) {
    menu = null;
    // Files spawn the shell in their parent folder.
    const dir = node.type === 'dir' ? node.path : node.path.split('/').slice(0, -1).join('/');
    onNewTerminal(dir);
  }
</script>

<!-- The row being named renders as a div: an <input> inside a <button> is
     invalid HTML, and the button swallows the clicks that would place a
     cursor in it. -->
{#snippet editRow(depth: number)}
  <div class="row editing" style="padding-left: {8 + depth * 14}px">
    <span class="chevron"></span>
    <img
      class="icon"
      alt=""
      aria-hidden="true"
      src={editing?.mode === 'create' && editing.type === 'dir'
        ? folderIconUrl(editing.name || 'folder', false)
        : fileIconUrl(editing?.name || 'file')}
    />
    <input
      class="name-input"
      value={editing?.name ?? ''}
      spellcheck="false"
      use:focusName
      oninput={(e) => { if (editing) editing.name = e.currentTarget.value; }}
      onkeydown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commitEdit(); }
        else if (e.key === 'Escape') { e.preventDefault(); editing = null; }
      }}
      onblur={() => { editing = null; }}
    />
  </div>
{/snippet}

{#snippet rows(nodes: TreeNode[], depth: number)}
  {#each nodes as node (node.path)}
    {#if editing?.mode === 'rename' && editing.path === node.path}
      {@render editRow(depth)}
    {:else}
    <button
      type="button"
      class="row"
      class:selected={selectionExplicit && selected.has(node.path)}
      class:active={node.path === activeRow}
      class:droptarget={dropDir === node.path}
      class:ignored={node.ignored}
      class:cut={cutSet.has(node.path)}
      data-path={node.path}
      style="padding-left: {8 + depth * 14}px"
      draggable="true"
      ondragstart={(e) => handleRowDragStart(e, node)}
      ondragover={(e) => handleRowDragOver(e, node)}
      ondragleave={() => { if (dropDir === dropParentFor(node)) dropDir = null; }}
      ondrop={(e) => handleRowDrop(e, node)}
      ondragend={() => { dragPaths = []; dropDir = null; }}
      onclick={(e) => handleClick(e, node)}
      ondblclick={() => handleDblClick(node)}
      oncontextmenu={(e) => handleContextMenu(e, node)}
      onkeydown={(e) => { if (e.key === 'F2') { e.preventDefault(); startRename(node.path); } }}
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
    {/if}
    {#if node.type === 'dir' && node.expanded && node.children}
      {#if editing?.mode === 'create' && editing.parent === node.path}
        {@render editRow(depth + 1)}
      {/if}
      {@render rows(node.children, depth + 1)}
    {/if}
  {/each}
{/snippet}

<div class="explorer">
  <div class="ehead">
    <span class="etitle">Explorer</span>
    {#if clip}
      <button type="button" class="clip-pill" title="Escape also cancels" onclick={() => (clip = null)}>
        {clip.mode === 'cut' ? 'cut' : 'copied'} {clip.paths.length} ✕
      </button>
    {/if}
    <button type="button" class="ebtn" title="New file" aria-label="New file" onclick={() => createAtRoot('file')}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4.5V13H4.5V3h4.25v3.25H12V7.5h1.5V5zM11.25 9.5v2.25H9v1.5h2.25V15.5h1.5v-2.25H15v-1.5h-2.25V9.5z" /></svg>
    </button>
    <button type="button" class="ebtn" title="New folder" aria-label="New folder" onclick={() => createAtRoot('dir')}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.5h4.2l1.3 1.6H14.5V8H13V5.6H6.3L5 4H3v7.4h5.5v1.5h-7zM11.25 9.5v2.25H9v1.5h2.25V15.5h1.5v-2.25H15v-1.5h-2.25V9.5z" /></svg>
    </button>
    <button
      type="button"
      class="ebtn"
      title={anyExpanded ? 'Collapse all folders' : 'Restore expanded folders'}
      aria-label="Collapse all folders"
      onclick={() => void toggleCollapseAll()}
    >
      {#if anyExpanded}
        <svg class="stroke" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3.4 8 7l4-3.6" /><path d="M4 12.6 8 9l4 3.6" /></svg>
      {:else}
        <svg class="stroke" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 7 8 3.4 12 7" /><path d="M4 9 8 12.6 12 9" /></svg>
      {/if}
    </button>
    <button
      type="button"
      class="ebtn"
      class:busy={refreshing}
      title="Refresh from disk"
      aria-label="Refresh explorer"
      disabled={refreshing}
      onclick={() => void refresh()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 0 5.32 6.9l-1.29-.34A4.2 4.2 0 1 1 8 3.8v2.2l3.2-2.75L8 .5z" /></svg>
    </button>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="tree"
    bind:this={treeEl}
    onkeydown={handleTreeKey}
    ondblclick={handleRootDblClick}
    ondragover={handleRootDragOver}
    ondrop={handleRootDrop}
  >
    {#if rootError}
      <div class="error">{rootError}</div>
    {:else}
      {#if editing?.mode === 'create' && editing.parent === folder}
        {@render editRow(0)}
      {/if}
      {@render rows(roots, 0)}
    {/if}
  </div>
</div>

{#if menu}
  <div class="ctx-menu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
    {#if menu.type === 'dir' && menu.paths.length === 1}
      <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && pickWorkspace(menu.path)}>
        Open workspace here
      </button>
    {/if}
    {#if menu.paths.length === 1}
      <button type="button" role="menuitem" class="ctx-item" onclick={() => void startCreate('file')}>
        New file…
      </button>
      <button type="button" role="menuitem" class="ctx-item" onclick={() => void startCreate('dir')}>
        New folder…
      </button>
      <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && startRename(menu.path)}>
        Rename…
      </button>
    {/if}
    <div class="ctx-sep"></div>
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && setClip(menu.paths, 'cut')}>
      Cut{#if menu.paths.length > 1}&nbsp;({menu.paths.length}){/if}
    </button>
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && setClip(menu.paths, 'copy')}>
      Copy{#if menu.paths.length > 1}&nbsp;({menu.paths.length}){/if}
    </button>
    <button
      type="button"
      role="menuitem"
      class="ctx-item"
      disabled={!clip}
      onclick={() => menu && paste(menu.type === 'dir' ? menu.path : parentOf(menu.path) || folder)}
    >
      Paste{#if clip}&nbsp;({clip.paths.length}){/if}
    </button>
    <div class="ctx-sep"></div>
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && copyAsContext(menu.paths)}>
      Copy as context{#if menu.paths.length > 1}&nbsp;({menu.paths.length}){/if}
    </button>
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && copyFullPath(menu.paths)}>
      Copy full path{#if menu.paths.length > 1}s&nbsp;({menu.paths.length}){/if}
    </button>
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && download(menu.paths)}>
      Download{#if menu.paths.length > 1}&nbsp;({menu.paths.length}&nbsp;as zip){:else if menu.type === 'dir'}&nbsp;as zip{/if}
    </button>
    <button type="button" role="menuitem" class="ctx-item" onclick={() => menu && terminalHere(menu)}>
      Open new terminal here
    </button>
    <div class="ctx-sep"></div>
    <button type="button" role="menuitem" class="ctx-item danger" onclick={() => menu && void deleteEntries(menu.paths)}>
      Delete{#if menu.paths.length > 1}&nbsp;({menu.paths.length}){/if}
    </button>
  </div>
{/if}
{#if toast}
  <div class="toast">{toast}</div>
{/if}
{#if overwriteAsk}
  <!-- Not a native confirm(): the answer is three-way, and seeing what is
       about to be overwritten is the whole reason for asking. -->
  <div class="ovw-back">
    <div class="ovw" role="dialog" aria-modal="true" aria-label="Files already exist">
      <div class="ovw-title">
        {overwriteAsk.names.length === 1 ? '1 file already exists' : `${overwriteAsk.names.length} files already exist`}
      </div>
      <ul class="ovw-list">
        {#each overwriteAsk.names.slice(0, 8) as n (n)}<li>{n}</li>{/each}
        {#if overwriteAsk.names.length > 8}<li class="more">…and {overwriteAsk.names.length - 8} more</li>{/if}
      </ul>
      <div class="ovw-btns">
        <button type="button" onclick={() => overwriteAsk?.resolve(null)}>Cancel</button>
        <button type="button" onclick={() => overwriteAsk?.resolve('skip')}>Skip existing</button>
        <button type="button" class="primary" onclick={() => overwriteAsk?.resolve('overwrite')}>Overwrite</button>
      </div>
    </div>
  </div>
{/if}
{#if jobs.length}
  <div class="dl-stack">
    {#each jobs as j (j.id)}
      <div class="dl">
        <div class="dl-top">
          <span class="dl-name" title={j.name}>{j.name}</span>
          {#if j.state === 'active'}
            <button type="button" class="dl-x" title="Cancel" aria-label="Cancel transfer" onclick={() => j.cancel()}>✕</button>
          {/if}
        </div>
        <div class="dl-bar" class:indet={j.state === 'active' && !j.total}>
          <span
            class:bad={j.state === 'error' || j.state === 'cancelled'}
            style="width: {j.total ? Math.min(100, (j.got / j.total) * 100) : 100}%"
          ></span>
        </div>
        <div class="dl-sub">
          {#if j.state === 'error'}{j.error}
          {:else if j.state === 'cancelled'}Cancelled.
          {:else if j.state === 'done'}{j.verb} · {fmtBytes(j.got)}
          {:else}{fmtBytes(j.got)}{#if j.total}&nbsp;of {j.est ? '~' : ''}{fmtBytes(j.total)}{/if}{/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Naming row. Shares .row so indent, height and icon slot line up with the
     rows above and below it. */
  .row.editing { display: flex; align-items: center; gap: 4px; }
  .name-input {
    flex: 1;
    min-width: 0;
    background: #1e1e1e;
    border: 1px solid #e58520;
    border-radius: 3px;
    color: #c5c8c6;
    font: inherit;
    padding: 1px 4px;
  }
  .name-input:focus { outline: none; }
  /* Folder a drag would land in. Reads on the folder row itself even when the
     pointer is over one of its files. */
  .row.droptarget { background: rgba(229, 133, 32, 0.22); }
  .explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .ehead {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 10px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.75;
    border-bottom: 1px solid rgba(127, 127, 127, 0.22);
  }
  .etitle { flex: 1; }
  .ebtn {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    padding: 2px;
    line-height: 0;
    border-radius: 3px;
  }
  .ebtn:hover { background: rgba(127, 127, 127, 0.22); }
  .ebtn svg { width: 14px; height: 14px; fill: currentColor; }
  .ebtn svg.stroke {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ebtn.busy { opacity: 0.5; }
  .ctx-sep {
    height: 1px;
    margin: 4px 6px;
    background: rgba(127, 127, 127, 0.28);
  }
  .ctx-item.danger { color: #f47067; }
  .tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    background: #1e1e1e;
    color: #c5c8c6;
    padding: 4px 0;
    box-sizing: border-box;
  }
  /* Rows size to their own content and are only FLOORED at the panel width, so
     a deeply nested name pushes the tree wider instead of being cut off, while
     short rows still take a full-width hover highlight. `.tree` scrolls both
     axes; nothing here may clip, or the scroll has nothing to reveal. */
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    width: max-content;
    min-width: 100%;
    box-sizing: border-box;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 2px 8px;
    cursor: pointer;
    white-space: nowrap;
    line-height: 20px;
  }
  .row:hover { background: rgba(255, 255, 255, 0.07); }
  .row.selected { background: rgba(229, 133, 32, 0.25); }
  .row.active { background: rgba(255, 255, 255, 0.08); }
  .guide {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #353535;
    pointer-events: none;
  }
  .guide.lit { background: #e58520; }
  .chevron {
    width: 12px;
    flex: 0 0 12px;
    display: inline-block;
    color: #949494;
  }
  .icon {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
  }
  .name {
    flex: 1 0 auto;
  }
  .name.dir { font-weight: 600; }
  /* Same signal VS Code gives a gitignored path: dimmed, never hidden. The
     row stays fully interactive — build output is still worth opening. */
  .row.ignored .name { color: #6e7681; }
  .row.ignored .icon { opacity: 0.5; }
  /* A pending cut. Deliberately a different kind of dim from the gitignore one
     above: that tints the name and leaves the row solid, this fades the whole
     row and leans it over, so the two stay legible even on the same row. */
  .row.cut { opacity: 0.45; }
  .row.cut .name { font-style: italic; }
  .loading { color: #949494; }
  .error {
    padding: 8px 12px;
    color: #ff7b72;
    font-size: 12px;
  }
  .ctx-menu {
    position: fixed;
    z-index: 100;
    background: #272727;
    border: 1px solid #404040;
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
  .ctx-item:hover { background: #444444; }
  .ctx-item:disabled { color: #6e7681; cursor: default; }
  .ctx-item:disabled:hover { background: transparent; }
  /* Reads as a status, not a button, until hovered — the cut is already the
     loud signal down in the tree. */
  .clip-pill {
    border: 1px solid #505050;
    border-radius: 10px;
    background: #2d2d2d;
    color: #949494;
    font: inherit;
    font-size: 10px;
    letter-spacing: 0;
    text-transform: none;
    padding: 0 6px;
    cursor: pointer;
  }
  .clip-pill:hover { background: #3a3a3a; color: #c5c8c6; }
  .ovw-back {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .ovw {
    width: 380px;
    max-width: calc(100vw - 32px);
    background: #272727;
    border: 1px solid #505050;
    border-radius: 4px;
    padding: 12px 14px;
    color: #c5c8c6;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    font-size: 13px;
  }
  .ovw-title { margin-bottom: 8px; }
  .ovw-list {
    max-height: 140px;
    overflow: auto;
    margin: 0 0 12px;
    padding-left: 16px;
    color: #949494;
    font-size: 12px;
  }
  .ovw-list .more { list-style: none; margin-left: -16px; }
  .ovw-btns {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .ovw-btns button {
    background: #2d2d2d;
    border: 1px solid #505050;
    border-radius: 3px;
    color: #c5c8c6;
    padding: 4px 12px;
    font-size: 12px;
    cursor: pointer;
  }
  .ovw-btns button:hover { background: #3a3a3a; }
  .ovw-btns button.primary { background: #0e639c; border-color: #0e639c; color: #ffffff; }
  .ovw-btns button.primary:hover { background: #1177bb; }

  .dl-stack {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 120;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 260px;
  }
  .dl {
    background: #272727;
    border: 1px solid #404040;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
    color: #c5c8c6;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }
  .dl-top {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dl-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dl-x {
    border: 0;
    background: none;
    color: #949494;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    padding: 0 2px;
  }
  .dl-x:hover { color: #f47067; }
  .dl-bar {
    height: 3px;
    margin: 6px 0 4px;
    border-radius: 2px;
    background: #3a3a3a;
    overflow: hidden;
  }
  .dl-bar span {
    display: block;
    height: 100%;
    background: #e58520;
  }
  .dl-bar span.bad { background: #f47067; }
  /* No length header means no honest fraction, so the bar sweeps instead of
     inventing one. */
  .dl-bar.indet span { animation: dl-sweep 1.1s ease-in-out infinite; }
  @keyframes dl-sweep {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  .dl-sub {
    color: #949494;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    background: #272727;
    border: 1px solid #404040;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    color: #c5c8c6;
    z-index: 120;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }
</style>
