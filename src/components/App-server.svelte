<script lang="ts">
  import FileTree from './server/FileTree.svelte';
  import MarkdownTab from './server/MarkdownTab.svelte';
  import CodeTab from './server/CodeTab.svelte';
  import SourceControlPanel from './server/SourceControlPanel.svelte';
  import DiffTab from './server/DiffTab.svelte';
  import SaveAsModal from './server/SaveAsModal.svelte';
  import WorkspaceBrowser from './server/WorkspaceBrowser.svelte';

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
    reveal?: { line: number; seq: number; select?: { from: number; to: number } };
    // Present on kind === 'diff' tabs: which repo/file/side the tab shows.
    git?: { repo: string; path: string; staged: boolean; untracked: boolean };
    // Present on kind === 'diff' tabs opened by a compare command: two
    // arbitrary inputs instead of a git side. rightText holds pasted content,
    // which lives in memory only.
    cmp?: { leftPath: string; rightPath?: string; rightText?: string; rightLabel: string };
  }

  import OutlinePanel from './server/OutlinePanel.svelte';
  import type { OutlineNode } from '../lib/code-outline';

  const folder = new URLSearchParams(location.search).get('folder') ?? '';

  // Which view the left sidebar shows. Both stay mounted (CSS-hidden) so the
  // explorer keeps its expanded folders and search keeps its results.
  let sideView = $state<'explorer' | 'search'>('explorer');

  // Outline lives as a collapsible section at the bottom of the explorer, VS
  // Code style. Collapsed by default; the choice is remembered per workspace.
  const OUTLINE_KEY = `ghmd.outlineOpen:${folder}`;
  let outlineOpen = $state(
    (() => {
      try { return localStorage.getItem(OUTLINE_KEY) === '1'; }
      catch { return false; }
    })()
  );
  function toggleOutline(force?: boolean) {
    outlineOpen = force ?? !outlineOpen;
    try { localStorage.setItem(OUTLINE_KEY, outlineOpen ? '1' : '0'); }
    catch { /* private mode — section just won't persist */ }
  }
  // Handle on the panel, so the header's collapse-all button can drive the
  // fold state that lives inside it.
  let outlinePanel = $state<{ toggleFoldAll: () => void } | undefined>(undefined);
  let revealSeq = 0;

  // Which view the bottom panel shows; the terminal keeps running when hidden.
  let bottomView = $state<'terminal' | 'ports'>('terminal');

  // ---- Quick open: centred modal, Ctrl/Cmd+Shift+F files, Ctrl/Cmd+Shift+X commands ----
  let qoQuery = $state('');
  let qoOpen = $state(false);
  let qoResults = $state<{ path: string }[]>([]);
  // Surfaced in the modal instead of being swallowed: a failed lookup used to
  // leave an empty dropdown that was indistinguishable from "no matches".
  let qoError = $state('');
  let qoLoading = $state(false);
  // Which mode the current results were fetched under. The mode flips the
  // instant the query string changes, but results arrive a round-trip later —
  // without this tag, files left over from the previous query paint under the
  // folder glyph, and picking one hands a file path to "open workspace here".
  let qoResultsMode = $state<'file' | 'folder'>('file');
  let qoSel = $state(0);
  let qoSeq = 0;

  // One modal, four modes, chosen by prefix — VS Code's scheme: bare text
  // searches files, `>` is the command palette, `#` the folder picker (which
  // the palette's Open Folder commands switch it to), `@` the symbol list of
  // whatever file is on screen.
  let qoFolderAction = $state<'same' | 'tab' | 'window'>('same');
  let qoMode = $derived(
    qoQuery.startsWith('>')
      ? 'cmd'
      : qoQuery.startsWith('#')
        ? 'folder'
        : qoQuery.startsWith('@')
          ? 'symbol'
          : 'file'
  );
  let qoTerm = $derived(qoQuery.replace(/^[>#@]\s*/, '').trim());
  // Never show results that belong to a mode other than the one being typed.
  let qoShown = $derived(qoResultsMode === qoMode ? qoResults : []);

  const COMMANDS: { label: string; hint?: string; run: () => void }[] = [
    { label: 'Open Workspace…', hint: 'this tab', run: () => { browse = { mode: 'workspace', action: 'same' }; } },
    { label: 'Open Workspace in New Tab', run: () => { browse = { mode: 'workspace', action: 'tab' }; } },
    { label: 'Open Workspace in New Window', run: () => { browse = { mode: 'workspace', action: 'window' }; } },
    { label: 'Open File…', run: () => { browse = { mode: 'file', action: 'same' }; } },
    { label: 'Close All Editor Tabs', run: closeAllTabs },
    { label: 'Close Other Editor Tabs', run: closeOtherTabs },
    { label: 'Refresh Explorer', run: () => window.dispatchEvent(new CustomEvent('gmd:refresh-explorer')) },
    { label: 'Refresh Outline', run: refreshOutline },
    { label: 'Show Outline', run: () => { layout.showLeft = true; sideView = 'explorer'; toggleOutline(true); } },
    { label: 'New Untitled File', hint: 'Alt+N', run: () => newUntitledTab() },
    { label: 'Format Document', hint: 'Shift+Alt+F', run: () => window.dispatchEvent(new CustomEvent('gmd:format-document')) },
    { label: 'Compare Active File With…', run: () => { if (compareSource()) browse = { mode: 'compare', action: 'same' }; } },
    { label: 'Compare Active File With Clipboard', run: () => void compareWithClipboard() },
  ];
  let qoCommands = $derived(
    qoTerm ? COMMANDS.filter((c) => c.label.toLowerCase().includes(qoTerm.toLowerCase())) : COMMANDS
  );

  async function qoSearch() {
    // Commands and symbols are filtered in memory; only files and folders
    // involve the server.
    if (qoMode === 'cmd' || qoMode === 'symbol') { qoSel = 0; return; }
    // Pin the mode at request time: the box can flip between send and receive.
    const mode = qoMode === 'folder' ? 'folder' : 'file';
    if (!qoTerm) {
      qoResults = [];
      qoResultsMode = mode;
      qoError = '';
      qoLoading = false;
      qoSel = 0;
      return;
    }
    const seq = ++qoSeq;
    qoLoading = true;
    const qs = new URLSearchParams({ q: qoTerm, path: folder || '.' });
    // Folder mode reuses the same endpoint; the server derives the directory
    // set from its cached file list rather than spawning a second scan.
    if (mode === 'folder') qs.set('dirs', '1');
    try {
      const r = await fetch(`/api/quickopen?${qs}`);
      if (!r.ok) throw new Error(`server returned ${r.status}`);
      const d = await r.json();
      if (seq !== qoSeq) return; // a newer keystroke owns the list
      qoResults = d.files ?? [];
      qoResultsMode = mode;
      qoError = '';
      qoSel = 0;
    } catch (err) {
      if (seq !== qoSeq) return;
      qoResults = [];
      qoResultsMode = mode;
      qoError = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === qoSeq) qoLoading = false;
    }
  }

  // ---- Recently opened, so an empty query still offers somewhere to go ----
  const RECENT_FILES_KEY = 'ghmd.recentFiles';
  const RECENT_WS_KEY = 'ghmd.recentWorkspaces';
  function readList<T>(key: string): T[] {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? '[]');
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  }
  // Files are recorded with the workspace they were opened from, so switching
  // workspaces does not offer paths that no longer resolve.
  let recentFiles = $state<{ folder: string; path: string }[]>(readList(RECENT_FILES_KEY));
  let recentWorkspaces = $state<string[]>(readList(RECENT_WS_KEY));

  function noteRecentFile(path: string) {
    const home = folder || '.';
    const next = [{ folder: home, path }, ...recentFiles.filter((r) => r.path !== path || r.folder !== home)];
    recentFiles = next.slice(0, 40);
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(recentFiles));
  }

  // Last five workspaces, most recent first. Reads the stored list rather than
  // the reactive one so writing the result cannot re-trigger this effect.
  let notedWorkspace = false;
  $effect(() => {
    const home = folder;
    if (!home || notedWorkspace) return;
    notedWorkspace = true;
    const next = [home, ...readList<string>(RECENT_WS_KEY).filter((w) => w !== home)].slice(0, 5);
    recentWorkspaces = next;
    localStorage.setItem(RECENT_WS_KEY, JSON.stringify(next));
  });

  function flattenOutline(
    list: OutlineNode[],
    depth = 0,
    out: { node: OutlineNode; depth: number }[] = []
  ): { node: OutlineNode; depth: number }[] {
    for (const n of list) {
      out.push({ node: n, depth });
      flattenOutline(n.children, depth + 1, out);
    }
    return out;
  }

  // Every mode reduces to the same row shape, so the modal renders one list
  // and never has to know which mode produced it.
  let qoItems = $derived.by<QoItem[]>(() => {
    if (qoMode === 'cmd') {
      return qoCommands.map((c) => ({
        key: `cmd:${c.label}`,
        label: c.label,
        detail: c.hint,
        glyph: '›',
        run: c.run,
      }));
    }
    if (qoMode === 'symbol') {
      const needle = qoTerm.toLowerCase();
      return flattenOutline(outlineNodes)
        .filter(({ node }) => !needle || node.text.toLowerCase().includes(needle))
        .slice(0, 200)
        .map(({ node, depth }) => ({
          key: `sym:${node.line}:${node.text}`,
          label: `${'  '.repeat(depth)}${node.text}`,
          detail: `line ${node.line}`,
          glyph: '#',
          run: () => outlineSelect(node),
        }));
    }
    if (qoMode === 'folder') {
      if (!qoTerm) {
        return recentWorkspaces.map((p) => ({
          key: `ws:${p}`,
          label: baseName(p) || p,
          detail: p,
          glyph: '▸',
          run: () => openWorkspaceIn(p, qoFolderAction),
        }));
      }
      return qoShown.map((r) => ({
        key: `dir:${r.path}`,
        label: r.path,
        glyph: '▸',
        run: () => {
          // Quick-open paths are relative to the anchored workspace; '.' is
          // the anchor itself.
          const target = r.path === '.' ? folder : folder ? `${folder}/${r.path}` : r.path;
          openWorkspaceIn(target, qoFolderAction);
        },
      }));
    }
    if (!qoTerm) {
      const home = folder || '.';
      return recentFiles
        .filter((r) => r.folder === home)
        .slice(0, 20)
        .map((r) => ({
          key: `recent:${r.path}`,
          label: baseName(r.path),
          detail: r.path,
          icon: fileIconUrl(baseName(r.path)),
          run: () => void openFile(r.path, { pinned: false }),
        }));
    }
    return qoShown.map((r) => ({
      key: `file:${r.path}`,
      label: baseName(r.path),
      detail: r.path,
      icon: fileIconUrl(baseName(r.path)),
      run: () => void openFile(folder ? `${folder}/${r.path}` : r.path, { pinned: false }),
    }));
  });

  let qoPlaceholder = $derived(
    qoMode === 'cmd'
      ? 'Type a command name'
      : qoMode === 'folder'
        ? 'Type a folder path to open as a workspace'
        : qoMode === 'symbol'
          ? 'Type a symbol name from the active file'
          : 'Search files by name — > commands, # folders, @ symbols'
  );

  // Never a blank panel: every empty-list case says why it is empty.
  let qoStatus = $derived(
    qoError
      ? `Search failed: ${qoError}`
      : qoLoading
        ? 'Searching…'
        : qoMode === 'symbol'
          ? 'No symbols in the active file'
          : qoTerm
            ? 'No matching results'
            : qoMode === 'folder'
              ? 'No recent workspaces yet — type a path'
              : 'No recently opened files yet — type to search'
  );

  function qoShow(prefix: string) {
    qoQuery = prefix;
    qoResults = [];
    qoError = '';
    qoSel = 0;
    qoOpen = true;
    void qoSearch();
  }

  function qoClose() {
    qoOpen = false;
    qoQuery = '';
    qoResults = [];
    qoError = '';
    qoSel = 0;
  }

  function qoPickItem(item: QoItem) {
    qoClose();
    item.run();
  }

  function workspaceUrl(path: string) {
    return `${location.pathname}?folder=${encodeURIComponent(path)}`;
  }

  // Same anchor semantics as "Open workspace here", with VS Code's three
  // destinations: this tab, a browser tab, a separate browser window.
  function openWorkspaceIn(path: string, how: 'same' | 'tab' | 'window') {
    const url = workspaceUrl(path);
    if (how === 'tab') window.open(url, '_blank');
    else if (how === 'window') window.open(url, '_blank', 'popup,width=1400,height=900');
    else location.href = url;
  }

  // The palette's three Open Folder entries differ only in where the chosen
  // folder lands, so they all reopen the modal in folder mode with that intent
  // remembered.
  function startFolderMode(how: 'same' | 'tab' | 'window') {
    qoFolderAction = how;
    qoShow('#');
  }

  // VS Code-style workspace browser: absolute-path navigation that can leave
  // the served root (that is the point — /api/browse exists for it).
  let browse = $state<{ mode: 'workspace' | 'file' | 'compare'; action: 'same' | 'tab' | 'window' } | null>(null);

  function browseStartPath(): string {
    if (folder.startsWith('/')) return folder; // already an absolute anchor
    const r = rootInfo?.root;
    if (!r) return folder || '/';
    const s = rootInfo?.sep ?? '/';
    return folder ? r + s + folder.split('/').join(s) : r;
  }

  // Inside the served root the short relative form keeps URLs and session
  // keys identical to what every existing workspace uses; outside it stays
  // absolute, which the server accepts everywhere.
  function toWorkspacePath(abs: string): string {
    const r = rootInfo?.root;
    if (!r) return abs;
    if (abs === r) return '';
    const s = rootInfo?.sep ?? '/';
    if (abs.startsWith(r + s)) return abs.slice(r.length + 1).split(s).join('/');
    return abs;
  }

  function browsePick(abs: string) {
    const b = browse;
    browse = null;
    if (!b) return;
    const p = toWorkspacePath(abs);
    if (b.mode === 'workspace') openWorkspaceIn(p, b.action);
    else if (b.mode === 'compare') {
      const t = compareSource();
      if (t) openCompare({ leftPath: t.path, rightPath: p, rightLabel: baseName(p) });
    } else void openFile(p, { pinned: true });
  }

  // ---- Sidebar outline ----
  // Editors push their structure up; only the active tab's push is kept, so
  // the panel always describes what is actually on screen.
  let outlineNodes = $state<OutlineNode[]>([]);
  let outlineSubject = $state('');
  let lastOutlineAsk = '';

  $effect(() => {
    const onOutline = (e: Event) => {
      const d = (e as CustomEvent).detail as { name?: string; nodes?: OutlineNode[] } | null;
      if (!d) return;
      const active = activeTab;
      if (!active || d.name !== active.name) return;
      outlineNodes = d.nodes ?? [];
      outlineSubject = active.name;
    };
    const onDeleted = (e: Event) => {
      const paths: string[] = (e as CustomEvent).detail?.paths ?? [];
      if (paths.length) dropTabsUnder(paths);
    };
    window.addEventListener('gmd:outline', onOutline);
    window.addEventListener('gmd:paths-deleted', onDeleted);
    return () => {
      window.removeEventListener('gmd:outline', onOutline);
      window.removeEventListener('gmd:paths-deleted', onDeleted);
    };
  });

  // Switching tabs (or restoring a session) leaves the sidebar describing the
  // wrong file until the new editor happens to push. Clear and ask instead of
  // waiting — mounted editors answer the request immediately.
  $effect(() => {
    const nm = activeTab?.name ?? '';
    // Guard on a plain variable, not reactive state: the active tab's object is
    // written to constantly (content, mtime, reveal) and every write re-runs
    // this effect. Without the guard those re-runs wipe the outline that was
    // just delivered — which is exactly what happens during session restore.
    if (nm === lastOutlineAsk) return;
    lastOutlineAsk = nm;
    outlineNodes = [];
    outlineSubject = nm;
    const ask = () => window.dispatchEvent(new CustomEvent('gmd:outline-request'));
    ask();
    // A restored tab only mounts once its content comes back from the server,
    // which routinely lands after this effect has already asked. Keep asking on
    // a short schedule until an editor answers, then stop. Reads of
    // `outlineNodes` inside the timer are untracked, so this cannot self-retrigger.
    let tries = 0;
    const poll = setInterval(() => {
      if (outlineNodes.length || ++tries > 8) clearInterval(poll);
      else ask();
    }, 300);
    return () => clearInterval(poll);
  });

  function outlineJump(line: number) {
    const t = activeTab;
    if (t) t.reveal = { line, seq: ++revealSeq };
  }

  // Double-click selects the whole declaration rather than parking the cursor
  // on its first line — the offsets ride along on the node the panel drew.
  function outlineSelect(node: OutlineNode) {
    const t = activeTab;
    if (t) t.reveal = { line: node.line, seq: ++revealSeq, select: { from: node.from, to: node.to } };
  }

  function refreshOutline() {
    window.dispatchEvent(new CustomEvent('gmd:outline-request'));
  }

  // `code-gh` in the integrated terminal, relayed here by the terminal view.
  // A folder replaces the workspace (in this tab with -r, a new one without);
  // a file opens pinned, since asking for it by name is a deliberate act.
  $effect(() => {
    const onOpenRequest = (e: Event) => {
      const d = (e as CustomEvent).detail as { kind?: string; path?: string; reuse?: boolean } | null;
      if (!d?.path) return;
      if (d.kind === 'folder') openWorkspaceIn(d.path, d.reuse ? 'same' : 'tab');
      else void openFile(d.path, { pinned: true });
    };
    window.addEventListener('gmd:open-request', onOpenRequest);
    return () => window.removeEventListener('gmd:open-request', onOpenRequest);
  });

  import QuickOpen from './server/QuickOpen.svelte';
  import type { QoItem } from '../lib/quickopen';
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
    outlineH: number;
    showLeft: boolean;
    showRight: boolean;
    showBottom: boolean;
  }
  const LAYOUT_KEY = 'ghmd.layout';
  const layoutDefaults: LayoutState = { leftW: 260, rightW: 320, bottomH: 220, outlineH: 240, showLeft: true, showRight: false, showBottom: false };
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
  function startDrag(e: PointerEvent, dims: { left?: boolean; right?: boolean; bottom?: boolean; outline?: boolean }) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const { leftW, rightW, bottomH, outlineH } = layout;
    document.body.style.cursor =
      dims.right && dims.bottom ? 'nwse-resize' : dims.bottom || dims.outline ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      if (dims.left) layout.leftW = clamp(leftW + (ev.clientX - startX), 140, window.innerWidth * 0.5);
      if (dims.right) layout.rightW = clamp(rightW - (ev.clientX - startX), 160, window.innerWidth * 0.6);
      if (dims.bottom) layout.bottomH = clamp(bottomH - (ev.clientY - startY), 80, window.innerHeight * 0.8);
      // The outline sits below the tree, so dragging the handle down gives it
      // less height, not more.
      if (dims.outline) layout.outlineH = clamp(outlineH - (ev.clientY - startY), 80, window.innerHeight * 0.7);
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
  // VS Code prints the containing folder dimmed beside the filename so two
  // tabs called index.ts stay distinguishable. Relative to the anchored
  // workspace folder, empty for files sitting at its root.
  function tabDir(p: string): string {
    if (!p || p.includes(':')) return '';
    const rel = folder && p.startsWith(`${folder}/`) ? p.slice(folder.length + 1) : p;
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
  }

  let activeTab = $derived(activeGroup.tabs.find((t) => t.path === activeGroup.activePath) ?? null);
  // A workspace outside the served root is already an absolute path, so
  // prefixing the root again would print /served/root//home/ken/dev.
  let title = $derived(
    folder && folder.startsWith('/')
      ? folder
      : rootInfo
        ? folder
          ? `${rootInfo.root}/${folder}`
          : rootInfo.root
        : folder
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
          // A pasted compare holds its right side in memory only — nothing on
          // disk can re-derive it, so it deliberately does not survive a reload.
          cmp: t.cmp?.rightPath ? t.cmp : undefined,
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
        } else if (st.kind === 'diff' && st.cmp) {
          tab = { path: st.path, name: st.name ?? st.path, kind: 'diff', pinned: !!st.pinned, content: '', savedContent: '', mtimeMs: 0, cmp: st.cmp };
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
        noteRecentFile(path);
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
    noteRecentFile(tab.path);
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

  // Compare two inputs. Unlike openDiff there is no repo and no index: the
  // server shells `git diff --no-index`, so the hunks arrive in the shape
  // DiffTab already renders.
  function openCompare(cmp: { leftPath: string; rightPath?: string; rightText?: string; rightLabel: string }) {
    const key = `gmd-cmp:${cmp.leftPath}:${cmp.rightPath ?? cmp.rightLabel}`;
    for (const g of groups) {
      const existing = g.tabs.find((t) => t.path === key);
      if (existing) {
        // Every pasted compare shares one key, so refresh the payload — the
        // same tab pointed at newly pasted text must show the new text.
        existing.cmp = cmp;
        activeGroupId = g.id;
        g.activePath = key;
        return;
      }
    }
    const tab: Tab = {
      path: key,
      name: `${baseName(cmp.leftPath)} ↔ ${cmp.rightLabel}`,
      kind: 'diff',
      pinned: false,
      content: '',
      savedContent: '',
      mtimeMs: 0,
      cmp,
    };
    const home = groups.includes(activeGroup) ? activeGroup : groups[0];
    const previewIdx = home.tabs.findIndex((t) => !t.pinned && !isDirty(t));
    if (previewIdx >= 0) home.tabs[previewIdx] = tab;
    else home.tabs.push(tab);
    home.activePath = key;
    activeGroupId = home.id;
  }

  // The left side of a compare is whatever real file is on screen. A diff tab
  // and an unsaved buffer have no path to hand to git.
  function compareSource(): Tab | null {
    const t = activeTab;
    if (!t || t.untitled || t.binary || t.kind === 'diff') return null;
    return t;
  }

  let pasteCompare = $state(false);
  let pasteText = $state('');

  async function compareWithClipboard() {
    const t = compareSource();
    if (!t) return;
    // readText() needs a secure context, and this app is routinely served over
    // plain http on a LAN — so the API being missing or rejecting is the
    // ordinary case here, not the exceptional one.
    try {
      const text = await navigator.clipboard?.readText();
      if (typeof text === 'string' && text.length) {
        openCompare({ leftPath: t.path, rightText: text, rightLabel: 'clipboard' });
        return;
      }
    } catch { /* fall through to the paste box */ }
    pasteText = '';
    pasteCompare = true;
  }

  function runPasteCompare() {
    const t = compareSource();
    const text = pasteText;
    pasteCompare = false;
    pasteText = '';
    if (t && text) openCompare({ leftPath: t.path, rightText: text, rightLabel: 'pasted text' });
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

  function closeAllTabs() {
    for (const g of [...groups]) for (const t of [...g.tabs]) closeTab(g, t.path);
  }

  function closeOtherTabs() {
    const keepGroup = activeGroupId;
    const keepPath = activeGroup.activePath;
    for (const g of [...groups]) {
      for (const t of [...g.tabs]) {
        if (g.id === keepGroup && t.path === keepPath) continue;
        closeTab(g, t.path);
      }
    }
  }

  // A deleted file's tab has nothing left to save back to — drop it without the
  // dirty prompt rather than leave a ghost buffer pointing at nothing.
  function dropTabsUnder(paths: string[]) {
    const hit = (p: string) => paths.some((d) => p === d || p.startsWith(`${d}/`));
    for (const g of [...groups]) {
      for (let i = g.tabs.length - 1; i >= 0; i--) if (hit(g.tabs[i].path)) g.tabs.splice(i, 1);
      if (!g.tabs.some((t) => t.path === g.activePath)) {
        g.activePath = g.tabs[g.tabs.length - 1]?.path ?? null;
      }
      if (g.tabs.length === 0 && groups.length > 1) removeGroup(g.id);
    }
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
      } else if ((e.metaKey || e.ctrlKey) && e.code === 'KeyG') {
        // Source control, with or without Shift: VS Code ships Cmd+Shift+G and
        // the bare chord is ours. CodeMirror's find-next binding for Mod-g is
        // filtered out of both editor keymaps precisely so it cannot fire
        // alongside this one — it preventDefaults but never stops propagation.
        e.preventDefault();
        layout.showRight = !layout.showRight;
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === 'KeyL') {
        // Explorer toggle, twin of Cmd+B. Firefox lets a page cancel the
        // address-bar focus this would otherwise trigger; Chrome does not,
        // which is why Cmd+B stays as the portable binding.
        e.preventDefault();
        layout.showLeft = !layout.showLeft;
      } else if ((e.metaKey || e.ctrlKey) && e.code === 'Digit1') {
        e.preventDefault();
        layout.showBottom = !layout.showBottom;
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyF') {
        // Quick open (user-chosen binding — find-in-files moved to the
        // activity-bar icon).
        e.preventDefault();
        qoShow('');
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyX') {
        // Command palette — same modal, `>` prefix.
        e.preventDefault();
        qoShow('>');
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
    <!-- Command centre: opens the modal, the way VS Code's title-bar box does.
         Not an input itself — typing happens in the modal. -->
    <button
      type="button"
      class="cmd-center"
      title="Go to file (Ctrl+Shift+F) — type &gt; for commands"
      onclick={() => qoShow('')}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" /><path d="M10.5 10.5 14 14" stroke="currentColor" /></svg>
      <span class="cmd-center-label">{folder ? baseName(folder) : 'Search'}</span>
    </button>
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

  <QuickOpen
    open={qoOpen}
    bind:query={qoQuery}
    bind:sel={qoSel}
    items={qoItems}
    term={qoTerm}
    placeholder={qoPlaceholder}
    status={qoStatus}
    onclose={qoClose}
    onpick={qoPickItem}
    oninput={() => void qoSearch()}
  />
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
      <div class="side-view stack" class:hidden={sideView !== 'explorer'}>
        <div class="stack-item grow">
          <FileTree {folder} {rootInfo} activePath={activeGroup.activePath ?? ''} onOpen={openFile} onOpenWorkspace={openWorkspace} onNewTerminal={newTerminalAt} />
        </div>
        <!-- Outline: collapsed by default, expands into a draggable lower pane. -->
        {#if outlineOpen}
          <div
            class="resizer h"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize outline"
            onpointerdown={(e) => startDrag(e, { outline: true })}
          ></div>
        {/if}
        <div
          class="stack-item outline"
          class:open={outlineOpen}
          style={outlineOpen ? `flex-basis: ${layout.outlineH}px` : ''}
        >
          <div class="section-head">
            <button type="button" class="sec-main" onclick={() => toggleOutline()}>
              <span class="sec-chev">{outlineOpen ? '▾' : '▸'}</span>
              <span class="sec-title">Outline</span>
              {#if outlineOpen && outlineSubject}<span class="sec-sub" title={outlineSubject}>{outlineSubject}</span>{/if}
            </button>
            {#if outlineOpen}
              <button
                type="button"
                class="sec-btn"
                title="Rebuild the outline from the current file contents"
                aria-label="Refresh outline"
                onclick={refreshOutline}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5V5h-2.5" /></svg>
              </button>
              <button
                type="button"
                class="sec-btn"
                title="Collapse or expand all sections"
                aria-label="Collapse all outline sections"
                onclick={() => outlinePanel?.toggleFoldAll()}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3.4 8 7l4-3.6" /><path d="M4 12.6 8 9l4 3.6" /></svg>
              </button>
            {/if}
          </div>
          {#if outlineOpen}
            <div class="section-body">
              <OutlinePanel bind:this={outlinePanel} nodes={outlineNodes} onJump={outlineJump} onSelect={outlineSelect} />
            </div>
          {/if}
        </div>
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
                  {#if tabDir(tab.path)}<span class="tab-dir">{tabDir(tab.path)}</span>{/if}
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
                  {:else if at.kind === 'diff' && at.cmp}
                    <DiffTab compare={at.cmp} />
                  {:else if at.kind === 'diff' && at.git}
                    <DiffTab repo={at.git.repo} path={at.git.path} staged={at.git.staged} untracked={at.git.untracked} />
                  {:else if at.kind === 'md'}
                    <MarkdownTab bind:value={at.content} name={at.name} reveal={at.reveal ?? null} />
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
{#if browse}
  <WorkspaceBrowser
    mode={browse.mode === 'workspace' ? 'workspace' : 'file'}
    title={browse.mode === 'compare' ? 'Compare With File'
      : browse.mode === 'file' ? 'Open File'
      : browse.action === 'tab' ? 'Open Workspace in New Tab'
      : browse.action === 'window' ? 'Open Workspace in New Window'
      : 'Open Workspace'}
    start={browseStartPath()}
    onCancel={() => { browse = null; }}
    onPick={browsePick}
  />
{/if}
{#if pasteCompare}
  <!-- The clipboard read needs a secure context that plain-http LAN serving
       does not provide, but a paste event always carries its data — so the
       textarea is the reliable path rather than the consolation prize. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="paste-back" onclick={() => { pasteCompare = false; pasteText = ''; }}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="paste-box" onclick={(e) => e.stopPropagation()}>
      <strong>Compare {activeTab?.name ?? ''} with pasted text</strong>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea bind:value={pasteText} autofocus placeholder="Paste here, then press Compare…"></textarea>
      <div class="paste-actions">
        <button type="button" onclick={() => { pasteCompare = false; pasteText = ''; }}>Cancel</button>
        <button type="button" disabled={!pasteText} onclick={runPasteCompare}>Compare</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .paste-back {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .paste-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(680px, 90vw);
    padding: 14px;
    border: 1px solid #505050;
    border-radius: 6px;
    background: #232323;
    color: #c5c8c6;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    font-size: 13px;
  }
  .paste-box textarea {
    height: 40vh;
    box-sizing: border-box;
    resize: vertical;
    padding: 6px;
    border: 1px solid #505050;
    border-radius: 3px;
    background: #1e1e1e;
    color: #c5c8c6;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .paste-box textarea:focus {
    outline: none;
    border-color: #e58520;
  }
  .paste-actions button {
    padding: 4px 12px;
    font-size: 12px;
    border: 1px solid #505050;
    border-radius: 3px;
    background: #2d2d2d;
    color: #c5c8c6;
    cursor: pointer;
  }
  .paste-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .paste-actions button:not(:disabled):hover { background: #3a3a3a; }
  .paste-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: #1e1e1e;
    color: #c5c8c6;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .titlebar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px;
    font-size: 12px;
    border-bottom: 1px solid #404040;
    background: #272727;
    white-space: nowrap;
    overflow: hidden;
  }
  .app-name { font-weight: 700; }
  .root-path {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    color: #949494;
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
    border-right: 1px solid #404040;
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
    background: #1e1e1e;
    border-right: 1px solid #404040;
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
    color: #8a8a8a;
    cursor: pointer;
  }
  .activitybar button:hover { color: #c5c8c6; }
  .activitybar button.on {
    color: #c5c8c6;
    border-left-color: #e58520;
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
  .resizer:active { background: #e58520; }
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
    border-top: 1px solid #404040;
    background: #1e1e1e;
  }
  .rightpanel {
    flex: 0 0 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid #404040;
    background: #1e1e1e;
  }
  .panel-title {
    flex: 0 0 auto;
    padding: 6px 12px 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #949494;
  }
  .layout-toggles {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  .layout-toggles button {
    border: none;
    background: transparent;
    color: #949494;
    padding: 2px 4px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
  }
  .layout-toggles button:hover { background: #444444; }
  .layout-toggles button.on { color: #c5c8c6; }
  .cmd-center {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 0 1 440px;
    min-width: 120px;
    margin: 0 auto;
    box-sizing: border-box;
    background: #1e1e1e;
    border: 1px solid #404040;
    border-radius: 6px;
    color: #949494;
    font-size: 12px;
    padding: 2px 10px;
    cursor: pointer;
  }
  .cmd-center:hover { border-color: #e58520; color: #c5c8c6; }
  .cmd-center-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Explorer sidebar = stacked sections (tree + outline), VS Code style. */
  .side-view.stack { display: flex; flex-direction: column; min-height: 0; }
  .stack-item { display: flex; flex-direction: column; min-height: 0; }
  .stack-item.grow { flex: 1 1 auto; }
  .stack-item.outline { flex: 0 0 auto; border-top: 1px solid #404040; }
  /* Height comes from the inline flex-basis the resizer writes; shrinking is
     allowed so a short window cannot push the tree out entirely. */
  .stack-item.outline.open { flex-grow: 0; flex-shrink: 1; min-height: 60px; }
  .section-head {
    display: flex;
    align-items: center;
    width: 100%;
    padding-right: 4px;
    box-sizing: border-box;
  }
  .sec-main {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.8;
    cursor: pointer;
    text-align: left;
  }
  .section-head:hover { background: rgba(127, 127, 127, 0.16); }
  .sec-btn {
    flex: 0 0 auto;
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    padding: 2px;
    line-height: 0;
    border-radius: 3px;
    opacity: 0.8;
  }
  .sec-btn:hover { background: rgba(127, 127, 127, 0.28); }
  .sec-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .sec-chev { flex: 0 0 10px; }
  .sec-sub {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .section-body { flex: 1; min-height: 0; overflow: hidden; }
  .panel-tabs {
    flex: 0 0 auto;
    display: flex;
    gap: 2px;
    padding: 2px 8px 0;
    border-bottom: 1px solid #404040;
    background: #272727;
  }
  .panel-tabs button {
    border: none;
    background: transparent;
    color: #949494;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 4px 8px;
    cursor: pointer;
    border-bottom: 1px solid transparent;
  }
  .panel-tabs button.on { color: #c5c8c6; border-bottom-color: #e58520; }
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
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(229, 133, 32, 0.45);
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
    border-bottom: 1px solid #404040;
    background: #272727;
    min-height: 30px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 0 12px;
    font-size: 12px;
    border-right: 1px solid #404040;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    background: transparent;
  }
  .tab.active {
    background: #1e1e1e;
    box-shadow: inset 0 -2px 0 #e58520;
  }
  .tab.preview .tab-name { font-style: italic; }
  .tab-dir {
    color: #8a8a8a;
    font-size: 10.5px;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
  }
  .dirty-dot {
    color: #e58520;
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
  .tab-close:hover { background: #444444; }
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
    color: #949494;
    font-size: 13px;
    padding: 20px;
    text-align: center;
  }
</style>
