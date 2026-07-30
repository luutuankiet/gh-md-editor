<script lang="ts">
  import FileTree from './server/FileTree.svelte';
  import MarkdownTab from './server/MarkdownTab.svelte';
  import CodeTab from './server/CodeTab.svelte';
  import SourceControlPanel from './server/SourceControlPanel.svelte';
  import DiffTab from './server/DiffTab.svelte';
  import SaveAsModal from './server/SaveAsModal.svelte';

  interface Tab {
    path: string;
    name: string;
    kind: 'md' | 'code' | 'diff';
    pinned: boolean;
    content: string;
    savedContent: string;
    mtimeMs: number;
    binary?: boolean;
    error?: string;
    // A blank Alt+N buffer never written to disk. `path` is a synthetic
    // `untitled:` key until Save As assigns a real one.
    untitled?: boolean;
    // Set by a search-result click; consumed by CodeTab to scroll + select.
    reveal?: { line: number; seq: number };
    // Present on kind === 'diff' tabs: which repo/file/side the tab shows.
    git?: { repo: string; path: string; staged: boolean; untracked: boolean };
  }

  const folder = new URLSearchParams(location.search).get('folder') ?? '';

  // Which view the left sidebar shows. Both stay mounted (CSS-hidden) so the
  // explorer keeps its expanded folders and search keeps its results.
  let sideView = $state<'explorer' | 'search'>('explorer');
  let revealSeq = 0;

  // Which view the bottom panel shows; the terminal keeps running when hidden.
  let bottomView = $state<'terminal' | 'ports'>('terminal');

  // ---- Quick open: header-center box, Ctrl/Cmd+Shift+F, fuzzy file dropdown ----
  let qoInput: HTMLInputElement | null = null;
  let qoQuery = $state('');
  let qoOpen = $state(false);
  let qoResults = $state<{ path: string }[]>([]);
  let qoSel = $state(0);
  let qoSeq = 0;

  async function qoSearch() {
    const seq = ++qoSeq;
    const qs = new URLSearchParams({ q: qoQuery.trim(), path: folder || '.' });
    try {
      const r = await fetch(`/api/quickopen?${qs}`);
      const d = await r.json();
      if (seq !== qoSeq) return; // a newer keystroke owns the dropdown
      qoResults = d.files ?? [];
      qoSel = 0;
    } catch { /* dropdown keeps last results */ }
  }

  function qoPick(p: string) {
    qoOpen = false;
    qoQuery = '';
    qoInput?.blur();
    void openFile(folder ? `${folder}/${p}` : p, { pinned: false });
  }

  function qoKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); qoSel = Math.min(qoSel + 1, qoResults.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); qoSel = Math.max(qoSel - 1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); if (qoResults[qoSel]) qoPick(qoResults[qoSel].path); }
    else if (e.key === 'Escape') { qoOpen = false; qoInput?.blur(); }
  }

  import TerminalPanel from './server/TerminalPanel.svelte';
  import SearchPanel from './server/SearchPanel.svelte';
  import PortsPanel from './server/PortsPanel.svelte';
  import { fileIconUrl } from '../lib/file-icons';
  import { TAB_DND_MIME, PATH_DND_MIME } from '../lib/dnd';

  // ---- Layout shell: VS Code-style panels (explorer / secondary side bar / bottom panel) ----
  interface LayoutState {
    leftW: number;
    rightW: number;
    bottomH: number;
    showLeft: boolean;
    showRight: boolean;
    showBottom: boolean;
  }
  const LAYOUT_KEY = 'ghmd.layout';
  const layoutDefaults: LayoutState = { leftW: 260, rightW: 320, bottomH: 220, showLeft: true, showRight: false, showBottom: false };
  function loadLayout(): LayoutState {
    try {
      return { ...layoutDefaults, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') };
    } catch {
      return { ...layoutDefaults };
    }
  }
  let layout = $state<LayoutState>(loadLayout());
  $effect(() => { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); });

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  // One drag handler for edges AND the corner joint: the dims flags pick which
  // dimensions follow the pointer (corner = right + bottom simultaneously).
  function startDrag(e: PointerEvent, dims: { left?: boolean; right?: boolean; bottom?: boolean }) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const { leftW, rightW, bottomH } = layout;
    document.body.style.cursor = dims.right && dims.bottom ? 'nwse-resize' : dims.bottom ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      if (dims.left) layout.leftW = clamp(leftW + (ev.clientX - startX), 140, window.innerWidth * 0.5);
      if (dims.right) layout.rightW = clamp(rightW - (ev.clientX - startX), 160, window.innerWidth * 0.6);
      if (dims.bottom) layout.bottomH = clamp(bottomH - (ev.clientY - startY), 80, window.innerHeight * 0.8);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  let rootInfo = $state<{ root: string; sep: string } | null>(null);

  // ---- Editor groups: split view. Tabs live in groups; groups render side-by-side. ----
  interface Group {
    id: number;
    size: number;
    tabs: Tab[];
    activePath: string | null;
  }
  let nextGroupId = 2;
  let groups = $state<Group[]>([{ id: 1, size: 1, tabs: [], activePath: null }]);
  let activeGroupId = $state(1);

  let activeGroup = $derived(groups.find((g) => g.id === activeGroupId) ?? groups[0]);
  let activeTab = $derived(activeGroup.tabs.find((t) => t.path === activeGroup.activePath) ?? null);
  let title = $derived(
    rootInfo ? (folder ? `${rootInfo.root}/${folder}` : rootInfo.root) : folder
  );

  $effect(() => {
    fetch('/api/root')
      .then((r) => r.json())
      .then((d) => { rootInfo = d; })
      .catch(() => { /* title bar stays folder-only */ });
  });

  // ---- Session persistence: reopen the same tabs/splits/panels after a
  // browser close or crash. Snapshot lives in localStorage (debounced, plus a
  // synchronous flush in beforeunload). Real files are NOT restored from the
  // cache — restore re-fetches from disk so mtimeMs stays a live freshness
  // token; a dirty buffer additionally carries its draft so a crash cannot
  // eat edits. Keyed per workspace folder.
  const SESSION_KEY = `ghmd.session:${folder}`;
  const DRAFT_CAP = 512 * 1024;
  let sessionRestored = false;
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;

  function sessionSnapshot() {
    return {
      activeGroupId,
      sideView,
      bottomView,
      groups: groups.map((g) => ({
        id: g.id,
        size: g.size,
        activePath: g.activePath,
        tabs: g.tabs.map((t) => ({
          path: t.path,
          name: t.name,
          kind: t.kind,
          pinned: t.pinned,
          git: t.git,
          untitled: t.untitled,
          // Untitled buffers live nowhere else; dirty files carry their draft.
          content: t.untitled && t.content.length <= DRAFT_CAP ? t.content : undefined,
          draft: !t.untitled && isDirty(t) && t.content.length <= DRAFT_CAP ? t.content : undefined,
        })),
      })),
    };
  }

  function saveSessionNow() {
    if (!sessionRestored) return;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(sessionSnapshot())); } catch { /* quota — drop */ }
  }

  $effect(() => {
    // Building the snapshot tracks every persisted field; the write itself is
    // debounced so keystrokes don't hammer localStorage.
    const json = JSON.stringify(sessionSnapshot());
    if (!sessionRestored) return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      try { localStorage.setItem(SESSION_KEY, json); } catch { /* quota — drop */ }
    }, 400);
  });

  async function restoreSession() {
    let snap: any = null;
    try { snap = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null'); } catch { /* corrupt — fresh start */ }
    if (!snap?.groups?.length) { sessionRestored = true; return; }
    const restored: Group[] = [];
    for (const g of snap.groups) {
      const grp: Group = { id: g.id, size: g.size ?? 1, tabs: [], activePath: null };
      for (const st of g.tabs ?? []) {
        if (typeof st?.path !== 'string') continue;
        let tab: Tab | null = null;
        if (st.untitled) {
          tab = { path: st.path, name: st.name ?? st.path, kind: 'code', pinned: true, content: st.content ?? '', savedContent: '', mtimeMs: 0, untitled: true };
        } else if (st.kind === 'diff' && st.git) {
          // Diff tabs own no content — DiffTab re-derives from git on mount.
          tab = { path: st.path, name: st.name ?? st.path, kind: 'diff', pinned: !!st.pinned, content: '', savedContent: '', mtimeMs: 0, git: st.git };
        } else {
          try {
            const res = await fetch(`/api/file?path=${encodeURIComponent(st.path)}`);
            if (!res.ok) continue; // vanished since last session — drop the tab
            const data = await res.json();
            if (data.binary) {
              tab = { path: st.path, name: st.name ?? baseName(st.path), kind: 'code', pinned: !!st.pinned, content: '', savedContent: '', mtimeMs: data.mtimeMs ?? 0, binary: true };
            } else {
              tab = {
                path: st.path,
                name: st.name ?? baseName(st.path),
                kind: kindOf(st.name ?? baseName(st.path)),
                pinned: !!st.pinned,
                content: typeof st.draft === 'string' ? st.draft : data.content,
                savedContent: data.content,
                mtimeMs: data.mtimeMs,
              };
            }
          } catch { continue; }
        }
        if (tab) grp.tabs.push(tab);
      }
      grp.activePath = grp.tabs.some((t) => t.path === g.activePath) ? g.activePath : (grp.tabs[0]?.path ?? null);
      if (grp.tabs.length) restored.push(grp);
    }
    if (restored.length) {
      groups = restored;
      nextGroupId = Math.max(...restored.map((g) => g.id)) + 1;
      activeGroupId = restored.some((g) => g.id === snap.activeGroupId) ? snap.activeGroupId : restored[0].id;
    }
    if (snap.sideView === 'explorer' || snap.sideView === 'search') sideView = snap.sideView;
    if (snap.bottomView === 'terminal' || snap.bottomView === 'ports') bottomView = snap.bottomView;
    sessionRestored = true;
  }
  void restoreSession();

  function isDirty(t: Tab): boolean {
    return !t.binary && !t.error && t.content !== t.savedContent;
  }

  function baseName(p: string): string {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
  }

  function kindOf(name: string): 'md' | 'code' {
    return /\.(md|markdown)$/i.test(name) ? 'md' : 'code';
  }

  // Guards the single-click-then-double-click race: the first click starts the
  // fetch; the double-click upgrades the pending open to pinned instead of
  // spawning a duplicate tab.
  const pendingOpens = new Map<string, { pinned: boolean }>();

  async function openFile(path: string, opts: { pinned: boolean; line?: number }) {
    // If open in ANY group, focus it there — duplicating a file across groups
    // would fork its content buffer and make saves ambiguous.
    for (const g of groups) {
      const existing = g.tabs.find((t) => t.path === path);
      if (existing) {
        if (opts.pinned) existing.pinned = true;
        if (opts.line) existing.reveal = { line: opts.line, seq: ++revealSeq };
        activeGroupId = g.id;
        g.activePath = path;
        return;
      }
    }
    const target = activeGroup;
    const pending = pendingOpens.get(path);
    if (pending) {
      if (opts.pinned) pending.pinned = true;
      return;
    }
    const opt = { pinned: opts.pinned };
    pendingOpens.set(path, opt);

    const name = baseName(path);
    let tab: Tab;
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) {
        tab = { path, name, kind: 'code', pinned: opt.pinned, content: '', savedContent: '', mtimeMs: 0, error: data.error ?? `HTTP ${res.status}` };
      } else if (data.binary) {
        tab = { path, name, kind: 'code', pinned: opt.pinned, content: '', savedContent: '', mtimeMs: data.mtimeMs ?? 0, binary: true };
      } else {
        tab = { path, name, kind: kindOf(name), pinned: opt.pinned, content: data.content, savedContent: data.content, mtimeMs: data.mtimeMs };
      }
    } catch (err) {
      tab = { path, name, kind: 'code', pinned: opt.pinned, content: '', savedContent: '', mtimeMs: 0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      pendingOpens.delete(path);
    }

    // VS Code preview-tab semantics: an unpinned preview tab is replaced by the
    // next preview open. A dirty preview is treated as pinned so edits are not
    // silently discarded.
    if (opts.line) tab.reveal = { line: opts.line, seq: ++revealSeq };

    const home = groups.includes(target) ? target : groups[0];
    const previewIdx = home.tabs.findIndex((t) => !t.pinned && !isDirty(t));
    if (!tab.pinned && previewIdx >= 0) {
      home.tabs[previewIdx] = tab;
    } else {
      home.tabs.push(tab);
    }
    home.activePath = tab.path;
    activeGroupId = home.id;
  }

  // A diff tab is keyed by repo+side+path so the staged and working-tree
  // views of the same file are two distinct tabs — exactly like VS Code's
  // "Index vs Working Tree" split.
  function openDiff(repo: string, file: { path: string; staged: boolean; untracked?: boolean }) {
    const key = `gmd-diff:${repo}:${file.staged ? 'S' : 'W'}:${file.path}`;
    for (const g of groups) {
      const existing = g.tabs.find((t) => t.path === key);
      if (existing) {
        activeGroupId = g.id;
        g.activePath = key;
        return;
      }
    }
    const tab: Tab = {
      path: key,
      name: `${baseName(file.path)} (${file.staged ? 'staged' : 'changes'})`,
      kind: 'diff',
      pinned: false,
      content: '',
      savedContent: '',
      mtimeMs: 0,
      git: { repo, path: file.path, staged: file.staged, untracked: !!file.untracked },
    };
    const home = groups.includes(activeGroup) ? activeGroup : groups[0];
    const previewIdx = home.tabs.findIndex((t) => !t.pinned && !isDirty(t));
    if (previewIdx >= 0) home.tabs[previewIdx] = tab;
    else home.tabs.push(tab);
    home.activePath = key;
    activeGroupId = home.id;
  }

  let saveAs = $state<{ tab: Tab } | null>(null);

  async function saveTab(tab: Tab) {
    if (tab.binary || tab.error) return;
    if (tab.untitled) { saveAs = { tab }; return; }
    const put = (baseMtimeMs: number) =>
      fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tab.path, content: tab.content, baseMtimeMs }),
      });

    const res = await put(tab.mtimeMs);
    if (res.ok) {
      const data = await res.json();
      tab.mtimeMs = data.mtimeMs;
      tab.savedContent = tab.content;
      return;
    }
    if (res.status === 409) {
      const data = await res.json();
      if (window.confirm('File changed on disk since you opened it. Overwrite disk version?')) {
        const res2 = await put(data.mtimeMs);
        if (res2.ok) {
          const d2 = await res2.json();
          tab.mtimeMs = d2.mtimeMs;
          tab.savedContent = tab.content;
        }
      } else {
        // Discard local edits, take the disk version.
        tab.content = data.content;
        tab.savedContent = data.content;
        tab.mtimeMs = data.mtimeMs;
      }
    }
  }

  // Save As landed: the untitled buffer becomes a real file tab in place.
  async function saveAsCommit(relPath: string) {
    const tab = saveAs?.tab;
    saveAs = null;
    if (!tab) return;
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relPath, content: tab.content, createDirs: true }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      window.alert(`Save failed: ${d.error ?? `HTTP ${res.status}`}`);
      return;
    }
    const data = await res.json();
    const oldPath = tab.path;
    tab.path = relPath;
    tab.name = baseName(relPath);
    tab.kind = kindOf(tab.name);
    tab.untitled = false;
    tab.savedContent = tab.content;
    tab.mtimeMs = data.mtimeMs;
    for (const g of groups) if (g.activePath === oldPath) g.activePath = relPath;
    window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
  }

  // Alt/Opt+N — blank buffer, VS Code's untitled model. Pinned from birth: a
  // preview-slot untitled tab would be silently replaced by the next open.
  let untitledSeq = 1;
  function newUntitledTab() {
    const used = new Set(groups.flatMap((g) => g.tabs.map((t) => t.path)));
    let n = untitledSeq;
    while (used.has(`untitled:Untitled-${n}`)) n++;
    untitledSeq = n + 1;
    const tab: Tab = { path: `untitled:Untitled-${n}`, name: `Untitled-${n}`, kind: 'code', pinned: true, content: '', savedContent: '', mtimeMs: 0, untitled: true };
    const home = activeGroup;
    home.tabs.push(tab);
    home.activePath = tab.path;
  }

  function closeTab(g: Group, path: string) {
    const idx = g.tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const tab = g.tabs[idx];
    if (isDirty(tab) && !window.confirm(`${tab.name} has unsaved changes. Close anyway?`)) return;
    g.tabs.splice(idx, 1);
    if (g.activePath === path) {
      g.activePath = g.tabs[Math.min(idx, g.tabs.length - 1)]?.path ?? null;
    }
    if (g.tabs.length === 0 && groups.length > 1) removeGroup(g.id);
  }

  function removeGroup(id: number) {
    const idx = groups.findIndex((g) => g.id === id);
    if (idx < 0 || groups.length === 1) return;
    groups.splice(idx, 1);
    if (activeGroupId === id) activeGroupId = groups[Math.max(0, idx - 1)].id;
    normalizeSizes();
  }

  // flex-grow sums below 1 leave free space undistributed — keep sizes summing
  // to the group count so splits/collapses never shrink the filled area.
  function normalizeSizes() {
    const total = groups.reduce((s, g) => s + g.size, 0) || 1;
    const scale = groups.length / total;
    for (const g of groups) g.size *= scale;
  }

  // Group splitter: converts pointer delta to flex-size units shared by the pair.
  function startGroupDrag(e: PointerEvent, gi: number) {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const width = container.getBoundingClientRect().width || 1;
    const total = groups.reduce((s, g) => s + g.size, 0);
    const startX = e.clientX;
    const a = groups[gi - 1].size;
    const b = groups[gi].size;
    const min = total * 0.12;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      const d = ((ev.clientX - startX) / width) * total;
      const na = clamp(a + d, min, a + b - min);
      groups[gi - 1].size = na;
      groups[gi].size = a + b - na;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ---- Tab drag & drop: drop on another group's strip/center to move the tab;
  // drop on the right 40% of a group's editor to split a new group to its right. ----
  let dragSrc: { groupId: number; path: string } | null = null;
  let dropTarget = $state<{ groupId: number; zone: 'center' | 'right' } | null>(null);

  function handleDragOver(e: DragEvent, groupId: number, tabstrip: boolean) {
    if (!dragSrc) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    let zone: 'center' | 'right' = 'center';
    if (!tabstrip) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      zone = e.clientX - r.left > r.width * 0.6 ? 'right' : 'center';
    }
    if (dropTarget?.groupId !== groupId || dropTarget?.zone !== zone) {
      dropTarget = { groupId, zone };
    }
  }

  function handleDrop(targetId: number) {
    const src = dragSrc;
    const zone = dropTarget?.zone ?? 'center';
    dragSrc = null;
    dropTarget = null;
    if (!src) return;
    const srcGroup = groups.find((g) => g.id === src.groupId);
    if (!srcGroup) return;
    const tabIdx = srcGroup.tabs.findIndex((t) => t.path === src.path);
    if (tabIdx < 0) return;
    const tab = srcGroup.tabs[tabIdx];

    const detach = () => {
      srcGroup.tabs.splice(tabIdx, 1);
      if (srcGroup.activePath === src.path) {
        srcGroup.activePath = srcGroup.tabs[Math.min(tabIdx, srcGroup.tabs.length - 1)]?.path ?? null;
      }
    };

    if (zone === 'right') {
      // Splitting a single-tab group to its own right recreates the same layout.
      if (src.groupId === targetId && srcGroup.tabs.length === 1) return;
      const tIdx = groups.findIndex((g) => g.id === targetId);
      if (tIdx < 0) return;
      detach();
      tab.pinned = true;
      const half = groups[tIdx].size / 2;
      groups[tIdx].size = half;
      groups.splice(tIdx + 1, 0, { id: nextGroupId++, size: half, tabs: [tab], activePath: tab.path });
      activeGroupId = groups[tIdx + 1].id;
      if (srcGroup.tabs.length === 0) removeGroup(srcGroup.id);
      normalizeSizes();
    } else {
      if (src.groupId === targetId) return;
      const targetGroup = groups.find((g) => g.id === targetId);
      if (!targetGroup) return;
      detach();
      tab.pinned = true;
      targetGroup.tabs.push(tab);
      targetGroup.activePath = tab.path;
      activeGroupId = targetId;
      if (srcGroup.tabs.length === 0) removeGroup(srcGroup.id);
    }
  }

  // Activity-bar click: switch view, or collapse the sidebar when the current
  // view is clicked again — VS Code's behaviour.
  function pickSide(v: 'explorer' | 'search') {
    if (layout.showLeft && sideView === v) {
      layout.showLeft = false;
      return;
    }
    layout.showLeft = true;
    sideView = v;
    if (v === 'search') window.dispatchEvent(new CustomEvent('gmd:focus-search'));
  }

  function openWorkspace(path: string) {
    location.search = '?folder=' + encodeURIComponent(path);
  }

  // Explorer context menu → spawn a shell cd'd into that folder. Reveal the
  // panel first so the new tab is visible when it lands.
  function newTerminalAt(cwd: string) {
    layout.showBottom = true;
    bottomView = 'terminal';
    window.dispatchEvent(new CustomEvent('gmd:new-terminal', { detail: { cwd } }));
  }

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') {
        e.preventDefault();
        if (activeTab) void saveTab(activeTab).then(() => window.dispatchEvent(new CustomEvent('gmd:git-refresh')));
      } else if (e.altKey && e.code === 'KeyW') {
        e.preventDefault();
        if (activeGroup.activePath) closeTab(activeGroup, activeGroup.activePath);
      } else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyN') {
        // Alt/Opt+N — new untitled buffer (the browser owns plain Ctrl/Cmd+N).
        e.preventDefault();
        newUntitledTab();
      } else if ((e.metaKey || e.ctrlKey) && e.code === 'KeyB') {
        e.preventDefault();
        layout.showLeft = !layout.showLeft;
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyG') {
        // VS Code's source-control binding — ours lives in the right panel.
        e.preventDefault();
        layout.showRight = !layout.showRight;
      } else if ((e.metaKey || e.ctrlKey) && e.code === 'Digit1') {
        e.preventDefault();
        layout.showBottom = !layout.showBottom;
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyF') {
        // Quick open (user-chosen binding — find-in-files moved to the
        // activity-bar icon). Focus the header box, select any old query.
        e.preventDefault();
        qoOpen = true;
        qoInput?.focus();
        qoInput?.select();
        void qoSearch();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'Backquote') {
        // VS Code's new-terminal binding. Reveal the panel first, then let the
        // terminal panel (always mounted) do the spawn.
        e.preventDefault();
        layout.showBottom = true;
        bottomView = 'terminal';
        window.dispatchEvent(new CustomEvent('gmd:new-terminal'));
      } else if ((e.metaKey || e.ctrlKey) && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
        // Terminal-focused height nudge, VS Code style.
        const inTerminal = (e.target as HTMLElement | null)?.closest?.('.bottompanel');
        if (inTerminal && layout.showBottom) {
          e.preventDefault();
          layout.bottomH = clamp(layout.bottomH + (e.code === 'ArrowUp' ? 40 : -40), 80, window.innerHeight * 0.8);
        }
      }
    };
    // Always-on leave guard — unconditional by design. Also the last chance
    // to flush the session snapshot (the autosave is debounced).
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      saveSessionNow();
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  });
</script>

<div class="app">
  <header class="titlebar">
    <span class="app-name">gh-md-editor</span>
    <span class="root-path" title={title}>{title}</span>
    <div class="quickopen">
      <input
        bind:this={qoInput}
        class="qo-input"
        placeholder="Go to file… (Ctrl+Shift+F)"
        bind:value={qoQuery}
        onfocus={() => { qoOpen = true; void qoSearch(); }}
        onblur={() => { qoOpen = false; }}
        oninput={() => void qoSearch()}
        onkeydown={qoKeydown}
      />
      {#if qoOpen && qoResults.length}
        <div class="qo-drop">
          {#each qoResults as r, i (r.path)}
            <button
              type="button"
              class="qo-item"
              class:sel={i === qoSel}
              onmousedown={(e) => { e.preventDefault(); qoPick(r.path); }}
            >
              <img class="qo-icon" alt="" src={fileIconUrl(baseName(r.path))} />
              <span class="qo-name">{baseName(r.path)}</span>
              <span class="qo-path">{r.path}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="layout-toggles">
      <button type="button" class:on={layout.showLeft} title="Toggle explorer (Ctrl+B)" aria-pressed={layout.showLeft} onclick={() => { layout.showLeft = !layout.showLeft; }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" /><path d="M6 3v10" stroke="currentColor" />{#if layout.showLeft}<rect x="2.75" y="3.75" width="2.25" height="8.5" fill="currentColor" />{/if}</svg>
      </button>
      <button type="button" class:on={layout.showBottom} title="Toggle panel (Ctrl+1)" aria-pressed={layout.showBottom} onclick={() => { layout.showBottom = !layout.showBottom; }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" /><path d="M2 9.5h12" stroke="currentColor" />{#if layout.showBottom}<rect x="2.75" y="10.5" width="10.5" height="2" fill="currentColor" />{/if}</svg>
      </button>
      <button type="button" class:on={layout.showRight} title="Toggle source control (Ctrl+Shift+G)" aria-pressed={layout.showRight} onclick={() => { layout.showRight = !layout.showRight; }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" /><path d="M10 3v10" stroke="currentColor" />{#if layout.showRight}<rect x="11" y="3.75" width="2.25" height="8.5" fill="currentColor" />{/if}</svg>
      </button>
    </div>
  </header>
  <div class="body">
    <nav class="activitybar">
      <button
        type="button"
        class:on={layout.showLeft && sideView === 'explorer'}
        title="Explorer (Ctrl+B)"
        onclick={() => pickSide('explorer')}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2h4.2l1.3 1.6h7.5v10.4H1.5zm1.3 1.3v9.4h10.9V4.9H6.4L5.1 3.3z" /></svg>
      </button>
      <button
        type="button"
        class:on={layout.showLeft && sideView === 'search'}
        title="Search (Ctrl+Shift+F)"
        onclick={() => pickSide('search')}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.7 9.6a4.6 4.6 0 1 0-1.1 1.1l3.4 3.4 1.1-1.1zM3.1 6.7a3.3 3.3 0 1 1 6.6 0 3.3 3.3 0 0 1-6.6 0z" /></svg>
      </button>
    </nav>
    <aside class="sidebar" class:hidden={!layout.showLeft} style="flex-basis: {layout.leftW}px">
      <!-- Both views stay mounted: remounting the explorer would collapse every
           expanded folder, remounting search would drop the result set. -->
      <div class="side-view" class:hidden={sideView !== 'explorer'}>
        <FileTree {folder} {rootInfo} onOpen={openFile} onOpenWorkspace={openWorkspace} onNewTerminal={newTerminalAt} />
      </div>
      <div class="side-view" class:hidden={sideView !== 'search'}>
        <SearchPanel onOpen={(p, line) => openFile(p, { pinned: false, line })} />
      </div>
    </aside>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="resizer v" class:hidden={!layout.showLeft} onpointerdown={(e) => startDrag(e, { left: true })}></div>
    <main class="main">
      <div class="center">
      <div class="groups">
        {#each groups as g, gi (g.id)}
          {@const at = g.tabs.find((t) => t.path === g.activePath) ?? null}
          {#if gi > 0}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="resizer v" onpointerdown={(e) => startGroupDrag(e, gi)}></div>
          {/if}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <section class="group" style="flex: {g.size} 1 0%" onpointerdown={() => { activeGroupId = g.id; }}>
            <div
              class="tabstrip"
              role="tablist"
              tabindex="-1"
              ondragover={(e) => handleDragOver(e, g.id, true)}
              ondrop={(e) => { e.preventDefault(); handleDrop(g.id); }}
            >
              {#each g.tabs as tab (tab.path)}
                <div
                  class="tab"
                  class:active={tab.path === g.activePath}
                  class:preview={!tab.pinned}
                  role="tab"
                  tabindex="0"
                  aria-selected={tab.path === g.activePath}
                  title={tab.path}
                  draggable="true"
                  ondragstart={(e) => { dragSrc = { groupId: g.id, path: tab.path }; e.dataTransfer?.setData(TAB_DND_MIME, tab.path); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; }}
                  ondragend={() => { dragSrc = null; dropTarget = null; }}
                  onclick={() => { g.activePath = tab.path; }}
                  ondblclick={() => { tab.pinned = true; }}
                  onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(g, tab.path); } }}
                  onkeydown={(e) => { if (e.key === 'Enter') g.activePath = tab.path; }}
                >
                  <span class="tab-name">{tab.name}</span>
                  {#if isDirty(tab)}<span class="dirty-dot" aria-label="Unsaved changes">●</span>{/if}
                  <button
                    type="button"
                    class="tab-close"
                    aria-label="Close tab"
                    onclick={(e) => { e.stopPropagation(); closeTab(g, tab.path); }}
                    ondblclick={(e) => e.stopPropagation()}
                  >×</button>
                </div>
              {/each}
            </div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="content"
              ondragover={(e) => handleDragOver(e, g.id, false)}
              ondrop={(e) => { e.preventDefault(); handleDrop(g.id); }}
            >
              {#key g.activePath}
                {#if at}
                  {#if at.error}
                    <div class="placeholder">Cannot open {at.name}: {at.error}</div>
                  {:else if at.binary}
                    <div class="placeholder">{at.name} is a binary file.</div>
                  {:else if at.kind === 'diff' && at.git}
                    <DiffTab repo={at.git.repo} path={at.git.path} staged={at.git.staged} untracked={at.git.untracked} />
                  {:else if at.kind === 'md'}
                    <MarkdownTab bind:value={at.content} />
                  {:else}
                    <CodeTab bind:value={at.content} filename={at.name} reveal={at.reveal ?? null} />
                  {/if}
                {:else}
                  <div class="placeholder">Open a file from the tree.</div>
                {/if}
              {/key}
              {#if dropTarget?.groupId === g.id}
                <div class="drop-overlay" class:right={dropTarget?.zone === 'right'}></div>
              {/if}
            </div>
          </section>
        {/each}
      </div>
      </div>
      <!-- Terminal stays mounted when the panel is hidden — toggling the
           panel must not kill the running shell session. CSS-hide, like the
           sidebar. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="resizer h" class:hidden={!layout.showBottom} onpointerdown={(e) => startDrag(e, { bottom: true })}></div>
      <section class="bottompanel" class:hidden={!layout.showBottom} style="flex-basis: {layout.bottomH}px">
        <div class="panel-tabs">
          <button type="button" class:on={bottomView === 'terminal'} onclick={() => { bottomView = 'terminal'; }}>Terminal</button>
          <button type="button" class:on={bottomView === 'ports'} onclick={() => { bottomView = 'ports'; }}>Ports</button>
        </div>
        <!-- Both stay mounted: hiding the terminal must not kill the shell. -->
        <div class="panel-view" class:hidden={bottomView !== 'terminal'}>
          <TerminalPanel visible={layout.showBottom && bottomView === 'terminal'} />
        </div>
        <div class="panel-view" class:hidden={bottomView !== 'ports'}>
          <PortsPanel visible={layout.showBottom && bottomView === 'ports'} />
        </div>
      </section>
    </main>
    <!-- Kept mounted when hidden: remounting would drop repo selection and
         the in-progress commit message. CSS-hide, like the sidebar views. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="resizer v" class:hidden={!layout.showRight} onpointerdown={(e) => startDrag(e, { right: true })}>
      {#if layout.showBottom}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="corner"
          style="bottom: {layout.bottomH - 5}px"
          onpointerdown={(e) => { e.stopPropagation(); startDrag(e, { right: true, bottom: true }); }}
        ></div>
      {/if}
    </div>
    <aside class="rightpanel" class:hidden={!layout.showRight} style="flex-basis: {layout.rightW}px">
      <div class="panel-title">Source Control</div>
      <SourceControlPanel visible={layout.showRight} onOpenDiff={openDiff} />
    </aside>
  </div>
</div>

{#if saveAs}
  <SaveAsModal
    root={rootInfo}
    {folder}
    initialName={saveAs.tab.name}
    onCancel={() => { saveAs = null; }}
    onSave={saveAsCommit}
  />
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: #0d1117;
    color: #c9d1d9;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .titlebar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px;
    font-size: 12px;
    border-bottom: 1px solid #30363d;
    background: #161b22;
    white-space: nowrap;
    overflow: hidden;
  }
  .app-name { font-weight: 700; }
  .root-path {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    color: #8b949e;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: row;
  }
  .sidebar {
    flex: 0 0 auto;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border-right: 1px solid #30363d;
  }
  .side-view {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .activitybar {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 0;
    background: #0d1117;
    border-right: 1px solid #30363d;
  }
  .activitybar button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    border-left: 2px solid transparent;
    background: transparent;
    color: #6e7681;
    cursor: pointer;
  }
  .activitybar button:hover { color: #c9d1d9; }
  .activitybar button.on {
    color: #c9d1d9;
    border-left-color: #58a6ff;
  }
  .activitybar svg {
    width: 19px;
    height: 19px;
    fill: currentColor;
  }
  .hidden { display: none !important; }
  .center {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .resizer {
    flex: 0 0 4px;
    background: transparent;
    transition: background 0.12s ease-in;
    z-index: 2;
  }
  .resizer:hover,
  .resizer:active { background: #58a6ff; }
  .resizer.v { cursor: col-resize; position: relative; }
  .resizer.h { cursor: row-resize; }
  .corner {
    position: absolute;
    left: -5px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    z-index: 3;
  }
  .bottompanel {
    flex: 0 0 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid #30363d;
    background: #0d1117;
  }
  .rightpanel {
    flex: 0 0 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid #30363d;
    background: #0d1117;
  }
  .panel-title {
    flex: 0 0 auto;
    padding: 6px 12px 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8b949e;
  }
  .layout-toggles {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  .layout-toggles button {
    border: none;
    background: transparent;
    color: #8b949e;
    padding: 2px 4px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
  }
  .layout-toggles button:hover { background: rgba(56, 139, 253, 0.15); }
  .layout-toggles button.on { color: #c9d1d9; }
  .quickopen {
    position: relative;
    flex: 0 1 440px;
    min-width: 120px;
    margin: 0 auto;
  }
  .qo-input {
    width: 100%;
    box-sizing: border-box;
    background: #010409;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    font-size: 12px;
    padding: 2px 10px;
  }
  .qo-input:focus { outline: none; border-color: #58a6ff; }
  .qo-drop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    max-height: 320px;
    overflow-y: auto;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(1, 4, 9, 0.85);
    z-index: 50;
  }
  .qo-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: #c9d1d9;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    text-align: left;
  }
  .qo-item.sel, .qo-item:hover { background: rgba(56, 139, 253, 0.15); }
  .qo-icon { width: 16px; height: 16px; flex: 0 0 16px; }
  .qo-name { flex: 0 0 auto; white-space: nowrap; }
  .qo-path {
    color: #8b949e;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
  }
  .panel-tabs {
    flex: 0 0 auto;
    display: flex;
    gap: 2px;
    padding: 2px 8px 0;
    border-bottom: 1px solid #30363d;
    background: #161b22;
  }
  .panel-tabs button {
    border: none;
    background: transparent;
    color: #8b949e;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 4px 8px;
    cursor: pointer;
    border-bottom: 1px solid transparent;
  }
  .panel-tabs button.on { color: #c9d1d9; border-bottom-color: #58a6ff; }
  .panel-view {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .groups {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: row;
  }
  .group {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .drop-overlay {
    position: absolute;
    inset: 0;
    background: rgba(88, 166, 255, 0.12);
    border: 1px solid rgba(88, 166, 255, 0.4);
    pointer-events: none;
    z-index: 5;
  }
  .drop-overlay.right {
    left: 50%;
  }
  .main {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .tabstrip {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    overflow-x: auto;
    border-bottom: 1px solid #30363d;
    background: #161b22;
    min-height: 30px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 0 12px;
    font-size: 12px;
    border-right: 1px solid #30363d;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    background: transparent;
  }
  .tab.active {
    background: #0d1117;
    box-shadow: inset 0 -2px 0 #58a6ff;
  }
  .tab.preview .tab-name { font-style: italic; }
  .dirty-dot {
    color: #58a6ff;
    font-size: 10px;
    line-height: 1;
  }
  .tab-close {
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .tab-close:hover { background: rgba(56, 139, 253, 0.15); }
  .content {
    flex: 1 1 0;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
  .placeholder {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #8b949e;
    font-size: 13px;
    padding: 20px;
    text-align: center;
  }
</style>
