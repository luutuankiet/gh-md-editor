<script lang="ts">
  let { repo = '', path = '', staged = false, untracked = false, compare = null, onScratch = undefined, base = '', baseLabel = '', to = '', toLabel = '', viewKey = '' }: {
    repo?: string;
    path?: string;
    // Which tab this diff is hosted in, for the state the tab remembers on its
    // behalf: word wrap, which of the three view modes, and scroll position.
    viewKey?: string;
    staged?: boolean;
    untracked?: boolean;
    // Pinned sha of a tree-compare base: the diff's old side is that commit's
    // tree instead of the index. baseLabel is the human name the user picked.
    base?: string;
    baseLabel?: string;
    // Pinned sha of the incoming side. Empty means the working tree, which is
    // the only shape where a hunk can be staged or restored: with both sides
    // pinned to commits there is nothing on disk for a patch to land in, so
    // the whole view goes read-only.
    to?: string;
    toLabel?: string;
    // Set instead of repo/path when the tab came from a compare command: two
    // arbitrary inputs, no repo, no index side. Either column can be text held
    // in memory — pasted content, or an unsaved buffer — which has no path.
    compare?: { leftPath?: string; leftText?: string; leftLabel?: string; rightPath?: string; rightText?: string; rightLabel: string; rightTab?: string } | null;
    // Called when the editable column has no file behind it to save to: the new
    // text goes back to whoever owns the buffer instead.
    onScratch?: (text: string) => void;
  } = $props();

  import { untrack } from 'svelte';
  import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
  import { search, searchKeymap, openSearchPanel, getSearchQuery, searchPanelOpen } from '@codemirror/search';
  import { matchCountBadge } from '../../lib/search-count';
  import { multiCursorMouse } from '../../lib/cm-multi-cursor';
  import { restoreScrollTop } from '../../lib/cm-scroll-anchor';
  import { EditorState } from '@codemirror/state';
  import type { Extension } from '@codemirror/state';
  import { MergeView, unifiedMergeView } from '@codemirror/merge';
  import { isCollapsedAt, revealSearchMatch } from '../../lib/cm-merge-reveal';
  import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
  import { bracketMatching, indentOnInput } from '@codemirror/language';
  import { grammarFor } from '../../lib/lang-detect';
  import { monokaiCodeBundle } from '../../lib/monokai-dimmed';
  import { scopeForFilename, highlightToLines, type Tok } from '../../lib/diff-highlight';
  import { wrapFor, toggleWrapFor, diffViewFor, tabViewOf, patchTabView } from '../../lib/tab-view-state.svelte';
  import { makeSplitHandle } from '../../lib/split-handle';

  interface DiffLine { t: '+' | '-' | ' ' | '\\'; n: number | null; o: number | null; text: string }
  interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; section: string; lines: DiffLine[] }

  // What the diff is *about* — drives the header and the grammar pick. A
  // compare has no repo-relative path, so its left input names the tab.
  const subject = $derived(compare ? (compare.leftPath || compare.rightPath || compare.leftLabel || compare.rightLabel) : path);

  // Two commits, no working tree — nothing here can be staged or reverted.
  const readOnly = $derived(!!to);

  let hunks = $state<Hunk[]>([]);
  let flags = $state<{ binary?: boolean; tooBig?: boolean }>({});
  let error = $state('');
  let loading = $state(true);
  // One Set of selected line indices per hunk. Cleared on every reload — the
  // server rebuilds the patch against the CURRENT diff, so stale indices
  // after an apply would target the wrong lines.
  let sel = $state<Set<number>[]>([]);

  // Syntax tokens per (hunk, line, side). Both sides are highlighted
  // separately: a '-' line belongs to the old file version and a '+' line to
  // the new one, and within one hunk each side's lines ARE contiguous, so
  // multi-line constructs resolve correctly there.
  let hl = $state<Map<string, Tok[]>>(new Map());
  const HL_LINE_CAP = 6000;

  function toks(hi: number, li: number, side: 'o' | 'n'): Tok[] | null {
    return hl.get(`${hi}:${li}:${side}`) ?? null;
  }

  async function highlightHunks(hs: Hunk[]) {
    const total = hs.reduce((n, h) => n + h.lines.length, 0);
    const scope = total > HL_LINE_CAP ? null : await scopeForFilename(subject);
    if (!scope) { hl = new Map(); return; }
    const map = new Map<string, Tok[]>();
    for (let hi = 0; hi < hs.length; hi++) {
      for (const side of ['o', 'n'] as const) {
        const idxs: number[] = [];
        const texts: string[] = [];
        hs[hi].lines.forEach((l, li) => {
          const onSide = side === 'o' ? l.t === '-' || l.t === ' ' : l.t === '+' || l.t === ' ';
          if (onSide) { idxs.push(li); texts.push(l.text); }
        });
        if (!texts.length) continue;
        const out = await highlightToLines(texts.join('\n'), scope);
        idxs.forEach((li, k) => { if (out[k]?.length) map.set(`${hi}:${li}:${side}`, out[k]); });
      }
    }
    // Reassign, not mutate: a fresh Map is what re-renders the token spans.
    hl = map;
  }

  // Side-by-side is the default. `hunks` is the original patch renderer, kept as
  // its own mode: it is the only view that can stage or revert INDIVIDUAL LINES,
  // because the server rebuilds the patch from a hunk index plus line indices
  // and an editor has neither.
  //
  // The mode belongs to the tab. The workspace-wide key is only the default for
  // a diff nobody has switched yet — dropping into Hunks to stage single lines
  // used to silently turn every other diff in the workspace into a patch view.
  type ViewMode = 'split' | 'inline' | 'hunks';
  const DIFFVIEW_KEY = 'ghmd.diffView';
  const storedView = typeof localStorage !== 'undefined' ? localStorage.getItem(DIFFVIEW_KEY) : null;
  const defaultView: ViewMode = storedView === 'inline' || storedView === 'hunks' ? storedView : 'split';
  let view = $state<ViewMode>(untrack(() => diffViewFor(viewKey, defaultView)));
  function setView(v: ViewMode) {
    view = v;
    if (viewKey) { patchTabView(viewKey, { diffView: v }); return; }
    try { localStorage.setItem(DIFFVIEW_KEY, v); } catch { /* private mode */ }
  }

  // Wrap belongs to the tab too, defaulting to the app-wide preference, so the
  // patch columns below and the CodeMirror panes always agree with each other.
  const wrap = $derived(wrapFor(viewKey));
  // A full rebuild rather than a compartment reconfigure: the merge view
  // measures chunk heights when its field is installed, so changing what a line
  // occupies underneath it leaves the two sides aligned to stale rows.
  let builtWrap = untrack(() => wrapFor(viewKey));
  $effect(() => {
    const on = wrapFor(viewKey);
    if (on === builtWrap) return;
    builtWrap = on;
    pendingScroll = scroller()?.scrollTop ?? null;
    docsVersion++;
  });

  // Remember where this diff was scrolled to.
  //
  // Nothing here holds a reference to the scrolling element. Which element that
  // is depends on the active mode, and it is replaced wholesale on every
  // rebuild — but more importantly it does not exist yet when this runs. The
  // effect that builds the editors is declared further down the file and so runs
  // AFTER this one, and the diff itself arrives from the server later still.
  // Attaching to the scroller directly therefore found nothing on the first
  // pass, and nothing this effect had read would ever change to bring it back:
  // the listener was never installed at all, for the whole life of the tab.
  //
  // The container is the one element that outlives every rebuild, so the
  // listener goes there instead, in the capture phase. Scroll events do not
  // bubble, but capture still reaches an ancestor on the way down, so one
  // listener covers whichever descendant ends up owning the overflow — including
  // the patch columns of hunks mode, which have no editor behind them.
  $effect(() => {
    const h = host;
    const key = viewKey;
    if (!h || !key) return;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: HTMLElement | null = null;
    const remember = (e: Event) => {
      // `scroller()` is the authority where it resolves: in split mode the
      // overflow is on the merge container while the two inner scrollers move
      // horizontally, and reading scrollTop off one of those would persist a
      // zero over a perfectly good position. Only fall back to the event's own
      // target for the modes it does not know about.
      const sc = scroller() ?? (e.target as HTMLElement | null);
      if (!sc || !(sc instanceof HTMLElement) || sc.scrollHeight <= sc.clientHeight) return;
      pending = sc;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (pending) patchTabView(key, { px: pending.scrollTop });
      }, 150);
    };
    h.addEventListener('scroll', remember, { capture: true, passive: true });
    return () => {
      clearTimeout(saveTimer);
      h.removeEventListener('scroll', remember, { capture: true });
    };
  });

  // Find inside the diff, when the caret is not in one of the panes. The panes
  // carry their own search extension and handle the chord themselves whenever
  // one of them has focus; everywhere else in the tab the keystroke used to
  // reach the browser and open ITS find bar over the page, which searches the
  // rendered DOM rather than the document and cannot see the folded-away
  // regions at all. Routed to the editable side by default, since that is the
  // one being worked on.
  $effect(() => {
    const h = host;
    if (!h) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.code !== 'KeyF') return;
      const focused = document.activeElement;
      const outside = focused === document.body || focused === document.documentElement;
      if (!outside && !h.contains(focused)) return;
      const target = mv ? (mv.a.dom.contains(focused) ? mv.a : mv.b) : uv;
      if (!target) return;
      e.preventDefault();
      // Same node as any sibling group's handler, so stopping propagation is
      // not enough to keep a second diff from opening its panel too.
      e.stopImmediatePropagation();
      target.focus();
      openSearchPanel(target);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  interface SplitCell { line: DiffLine; idx: number }
  interface SplitRow { left: SplitCell | null; right: SplitCell | null }
  // Pair deletions with the additions that replaced them: context rows span
  // both sides; a run of '-' zips against the run of '+' that follows it.
  // idx is the position in h.lines, so line-level selection keeps working
  // identically in both views.
  function splitRows(h: Hunk): SplitRow[] {
    const rows: SplitRow[] = [];
    let i = 0;
    while (i < h.lines.length) {
      const l = h.lines[i];
      if (l.t === ' ' || l.t === '\\') {
        rows.push({ left: { line: l, idx: i }, right: { line: l, idx: i } });
        i++;
        continue;
      }
      const dels: SplitCell[] = [];
      const adds: SplitCell[] = [];
      while (i < h.lines.length && h.lines[i].t === '-') dels.push({ line: h.lines[i], idx: i++ });
      while (i < h.lines.length && h.lines[i].t === '+') adds.push({ line: h.lines[i], idx: i++ });
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      }
    }
    return rows;
  }

  // The wire shape of a compare. The in-memory columns are read UNTRACKED on
  // purpose: an edit in a scratch pane flows back out to the tab that owns the
  // buffer, and re-reading it here would have the load effect refetch and
  // rebuild the editor under the user's cursor, mid-keystroke.
  function comparePayload() {
    if (!compare) return null;
    const c = compare;
    return {
      leftPath: c.leftPath,
      rightPath: c.rightPath,
      ...untrack(() => ({ leftText: c.leftText, rightText: c.rightText })),
    };
  }

  async function load(auto = false) {
    // A background reload keeps the current diff on screen while it runs: the
    // spinner would otherwise flash on every window focus.
    if (!auto) loading = true;
    let next: Hunk[] = [];
    try {
      // Two request shapes, one response shape. A compare carries no repo and
      // no side, and pasted text has no path at all — hence the POST.
      const r = compare
        ? await fetch('/api/diff/compare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(comparePayload()),
          })
        : await fetch(`/api/git/diff?${new URLSearchParams({ repo, path, staged: staged ? '1' : '0', untracked: untracked ? '1' : '0', ...(base ? { base } : {}), ...(to ? { to } : {}) })}`);
      const d = await r.json();
      if (!r.ok) { error = d.error ?? `HTTP ${r.status}`; hunks = []; sel = []; loading = false; return; }
      error = '';
      next = d.hunks ?? [];
      flags = { binary: d.binary, tooBig: d.tooBig };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      loading = false;
      return;
    }
    // An automatic reload that finds the diff unchanged must not touch state.
    // Resetting would wipe a line selection the user is still building, and a
    // focus event fires every time they tab away to check something.
    if (auto && JSON.stringify(next) === JSON.stringify(hunks)) { loading = false; return; }
    hunks = next;
    sel = hunks.map(() => new Set());
    loading = false;
    // Fire-and-forget: the diff paints as plain text immediately and upgrades
    // to coloured tokens when the grammar finishes loading.
    hl = new Map();
    void highlightHunks(hunks);
  }

  // ---------------------------------------------------------------------------
  // Full-file editable diff
  //
  // The patch renderer above can only ever show what git printed: the changed
  // hunks, as text, with no document behind them. Reading the surrounding code
  // meant opening the file in another tab, and fixing anything meant editing it
  // there and coming back. Both views below are real CodeMirror documents of
  // the WHOLE file instead, so the unchanged parts are present (collapsed until
  // clicked) and the incoming side is the working copy, typed into directly.
  // ---------------------------------------------------------------------------

  // Beyond this the merge view's per-line decorations cost more than the diff is
  // worth; the patch renderer handles those files instead.
  const MAX_CM_LINES = 20000;

  // Root-relative, which is what every file and git endpoint takes. `repo` is
  // itself root-relative and `path` is relative to the repo.
  const fullPath = $derived(compare ? '' : repo ? `${repo}/${path}` : path);
  // Where an edit lands. A scratch right side has no file, so it has none.
  const rightSavePath = $derived(compare ? compare.rightPath ?? '' : fullPath);
  // Whether the incoming pane takes typing at all. A staged diff's right side
  // is the index and a pinned `to` is a commit — neither is a document anyone
  // can edit. A compare always is: a column with no file behind it is still a
  // buffer, and editing it is the whole point of comparing against one.
  const writable = $derived(!to && !staged);
  // Whether those edits have anywhere on disk to go. When they do not they go
  // back to the tab that owns the buffer instead — see save().
  const savable = $derived(writable && !!rightSavePath);

  let leftText = $state<string | null>(null);
  let rightText = $state<string | null>(null);
  let rightMtime = 0;
  let cmError = $state('');
  let dirty = $state(false);
  let saving = $state(false);
  let saveErr = $state('');
  let busy = $state(false);
  let commitMsg = $state('');
  let host = $state<HTMLDivElement | null>(null);
  // Bumped when a fresh pair of documents needs a NEW editor. A reload that
  // only changes the text dispatches into the existing one instead, so the
  // cursor and scroll position survive every background refresh.
  let docsVersion = $state(0);

  // Binary or oversized inputs have no editable form, and neither does a
  // 2 MB-plus diff — all three fall back to the patch renderer.
  const cmBlocked = $derived(!!flags.binary || !!flags.tooBig || !!cmError);
  const shownView = $derived<ViewMode>(cmBlocked ? 'hunks' : view);

  let mv: MergeView | null = null;
  let uv: EditorView | null = null;
  // Carried across a rebuild so a background refresh does not throw the reader
  // back to the top of the file.
  // Seeded from what the tab remembered, so the first build after a tab switch
  // or a reload lands where the reader left off rather than at the top.
  let pendingScroll: number | null = untrack(() => (viewKey ? tabViewOf(viewKey)?.px ?? null : null));
  let langExt: Extension = [];
  let langFor = '';
  let docsToken = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const countLines = (s: string) => { let n = 1; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; };

  async function fetchFile(p: string): Promise<{ content: string; mtimeMs: number }> {
    const r = await fetch(`/api/file?path=${encodeURIComponent(p)}`);
    if (r.status === 413) throw new Error('too-large');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
    if (d.binary) throw new Error('binary');
    return { content: d.content ?? '', mtimeMs: d.mtimeMs ?? 0 };
  }

  async function fetchShow(p: string, q: Record<string, string>): Promise<string | null> {
    const r = await fetch(`/api/git/show?${new URLSearchParams({ path: p, ...q })}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
    if (d.binary) return null;
    // Untracked, or added since the ref asked for: the old side is empty, which
    // is exactly what git's own diff against /dev/null shows.
    if (!d.tracked) return '';
    return d.content ?? '';
  }

  async function fetchLeft(): Promise<string | null> {
    if (compare) {
      const c = compare;
      const mem = untrack(() => c.leftText);
      if (typeof mem === 'string') return mem;
      return c.leftPath ? (await fetchFile(c.leftPath)).content : '';
    }
    if (untracked) return '';
    // A pinned base wins; a staged diff measures against HEAD; otherwise the
    // index (falling back to HEAD), which is what makes the view show UNSTAGED
    // work only — the same rule the editor's change gutter follows.
    return await fetchShow(fullPath, base ? { ref: base } : staged ? { ref: 'HEAD' } : {});
  }

  async function fetchRight(): Promise<string | null> {
    if (compare) {
      const c = compare;
      const mem = untrack(() => c.rightText);
      if (typeof mem === 'string') return mem;
      return c.rightPath ? (await fetchFile(c.rightPath)).content : '';
    }
    if (to) return await fetchShow(fullPath, { ref: to });
    if (staged) return await fetchShow(fullPath, { stage: '0' });
    const f = await fetchFile(fullPath);
    // Kept for the conflict guard on save: the server rejects a write whose
    // base mtime is older than the copy on disk.
    rightMtime = f.mtimeMs;
    return f.content;
  }

  async function loadDocs(auto = false) {
    const token = ++docsToken;
    try {
      const [l, r] = await Promise.all([fetchLeft(), fetchRight()]);
      if (token !== docsToken) return;
      if (l === null || r === null) { cmError = 'Binary file — no editable diff.'; return; }
      if (countLines(l) > MAX_CM_LINES || countLines(r) > MAX_CM_LINES) {
        cmError = `Over ${MAX_CM_LINES.toLocaleString()} lines — showing hunks only.`;
        return;
      }
      if (langFor !== subject) {
        langExt = await grammarFor(subject);
        langFor = subject;
        if (token !== docsToken) return;
      }
      cmError = '';
      if (auto && leftText !== null && rightText !== null) { applyIncoming(l, r); return; }
      leftText = l;
      rightText = r;
      dirty = false;
      docsVersion++;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      cmError = m === 'too-large'
        ? 'File exceeds the server size cap — showing hunks only.'
        : m === 'binary'
          ? 'Binary file — no editable diff.'
          : m;
    }
  }

  // A background reload must never throw away work in progress, and must never
  // cost the user their place in the file: both sides are patched into the
  // LIVE editors rather than rebuilt.
  // --- Match ticks on the shared scrollbar ---
  // The code editor draws its rail against its own scroller. A split diff has
  // no such thing: the merge container owns the vertical scroll for both
  // columns, so there is exactly one scrollbar to hang ticks off while two
  // panes can be hunting different strings at the same time. Ticks from either
  // column therefore land on the same rail, and the current one is whichever
  // match the cursor is sitting on, in whichever pane that happens to be.
  // A tick carries which column produced it and whether the line it marks is
  // currently folded away. Both get drawn: the column picks a lane, because
  // two panes hunting different strings otherwise pile seventy identical marks
  // onto one strip with no way to tell whose is whose; the fold picks a hollow
  // marker, because every match inside one collapsed region shares that
  // region's single y and five hits would read as one.
  let matchTicks = $state<{ y: number; side: number; hidden: boolean }[]>([]);
  let currentTickY = $state<number | null>(null);
  let currentTickSide = $state(0);
  let paneCount = $state(1);

  function tickY(vw: EditorView, sc: HTMLElement, pos: number): number | null {
    const sh = sc.scrollHeight;
    const ch = sc.clientHeight;
    if (!sh || !ch) return null;
    try {
      // `lineBlockAt` measures from the top of this editor's own content, which
      // is not the top of the scrollable area -- the find panel sits above it,
      // and in split mode the two columns need not start level either. Adding
      // the content box's offset within the scroller, plus whatever is already
      // scrolled past, converts a per-editor measurement into a position in the
      // range the rail is scaled to. Independent of scroll position by
      // construction, so scrolling alone never needs a recompute.
      const top = vw.lineBlockAt(pos).top;
      const offset = vw.contentDOM.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      return ((top + offset) / sh) * ch;
    } catch { return null; }
  }

  function recomputeTicks() {
    const sc = scroller();
    const panes = mv ? [mv.a, mv.b] : uv ? [uv] : [];
    paneCount = panes.length || 1;
    if (!sc || !panes.length) { matchTicks = []; currentTickY = null; return; }
    const ticks: { y: number; side: number; hidden: boolean }[] = [];
    let current: number | null = null;
    let currentSide = 0;
    for (let side = 0; side < panes.length; side++) {
      const vw = panes[side];
      // Gated on the panel, not on the query alone. CodeMirror drops its inline
      // match decorations the moment the panel unmounts but keeps the query, so
      // ticks keyed off the query outlive the box that produced them and Escape
      // would leave a rail full of marks for a search nobody can see.
      if (!searchPanelOpen(vw.state)) continue;
      const q = getSearchQuery(vw.state);
      if (!q || !q.search || !q.valid) continue;
      const sel = vw.state.selection.main;
      const cur = q.getCursor(vw.state.doc);
      let safety = 5000;
      let next = cur.next();
      while (!next.done && safety-- > 0) {
        const r = next.value;
        const y = tickY(vw, sc, r.from);
        if (y != null) ticks.push({ y, side, hidden: isCollapsedAt(vw, r.from) != null });
        if (r.from === sel.from && r.to === sel.to) { current = y; currentSide = side; }
        next = cur.next();
      }
    }
    matchTicks = ticks;
    currentTickY = current;
    currentTickSide = currentSide;
  }

  function scroller(): HTMLElement | null {
    if (!host) return null;
    // Split mode scrolls the merge container, not either editor: the package
    // gives `.cm-mergeView` the overflow so both sides move together.
    return (host.querySelector('.cm-mergeView') as HTMLElement | null) ?? uv?.scrollDOM ?? null;
  }

  function applyIncoming(l: string, r: string) {
    const leftChanged = l !== leftText;
    // Unsaved edits outrank the disk copy — adopting it would silently discard
    // them. The dirty pill stays up and the next save resolves it.
    const rightChanged = r !== rightText && !dirty;
    if (!leftChanged && !rightChanged) return;
    if (leftChanged) leftText = l;
    if (rightChanged) rightText = r;
    // A rebuild, rather than a dispatch into the live editor, is what re-folds
    // the unchanged stretches. The merge package computes them once, when its
    // field is installed, and from then on only ever DROPS the ranges a new
    // chunk touches — patching the document in place would leave the file
    // permanently expanded. Reconfiguring does not help either: the field
    // already exists, so its initialiser never runs again.
    pendingScroll = scroller()?.scrollTop ?? null;
    docsVersion++;
  }

  // Props are read synchronously (qs build) → tracked: a reused tab pointed
  // at another file/side refetches. Writes only — no self-invalidation.
  $effect(() => { void load(); void loadDocs(); });

  // Live refresh. `gmd:git-refresh` covers mutations made anywhere in this app;
  // `focus` covers everything done outside it — a terminal commit, a revert in
  // another window. Both take the auto path, which no-ops on an unchanged diff.
  $effect(() => {
    const onRefresh = () => { void load(true); void loadDocs(true); };
    window.addEventListener('gmd:git-refresh', onRefresh);
    window.addEventListener('focus', onRefresh);
    return () => {
      window.removeEventListener('gmd:git-refresh', onRefresh);
      window.removeEventListener('focus', onRefresh);
    };
  });

  function baseExtensions(): Extension[] {
    return [
      lineNumbers(),
      history(),
      drawSelection(),
      multiCursorMouse,
      bracketMatching(),
      indentOnInput(),
      // Find, per pane. In split mode that means each column gets its own panel
      // and its own query, which is the point of putting it here rather than
      // over the tab as a whole: the string being hunted is usually present on
      // one side only. Mod-g is left to the browser exactly as the code editor
      // leaves it — the panel's own field still steps through matches.
      search({ top: true }),
      matchCountBadge,
      EditorView.updateListener.of((u) => {
        if (
          u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged ||
          u.transactions.some((tr) => tr.effects.length > 0)
        ) recomputeTicks();
        // Stepping through find can land on a line that is folded away, and a
        // block-replaced line draws nothing: the counter says "5 of 24" while
        // the screen shows a grey strip and no highlight anywhere. Unfold on
        // arrival, both columns at once. Deferred, because a view cannot
        // dispatch into itself from inside its own update.
        if (u.selectionSet && !u.state.selection.main.empty && searchPanelOpen(u.state)) {
          const pos = u.state.selection.main.from;
          if (isCollapsedAt(u.view, pos) != null) {
            requestAnimationFrame(() => revealSearchMatch(u.view, pos));
          }
        }
      }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { void save(); return true; } },
        ...searchKeymap.filter((b) => b.key !== 'Mod-g' && b.key !== 'Shift-Mod-g'),
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      monokaiCodeBundle,
      langExt,
      // Off by default: a diff is read by column as much as by line, and
      // reflowing each side on its own width destroys that alignment. On
      // demand it is still the only way to read a long prose line whole.
      ...(wrap ? [EditorView.lineWrapping] : []),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', lineHeight: '1.5' },
      }),
    ];
  }

  const onEdit = () => EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    dirty = true;
    scheduleSave();
  });

  // The library's own accept/reject buttons, relabelled: "accept" only moves
  // the comparison forward in memory (a review marker), while "reject" is the
  // revert people actually come here for.
  function mergeControl(type: 'reject' | 'accept', action: (e: MouseEvent) => void): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `gmd-mc gmd-mc-${type}`;
    el.textContent = type === 'reject' ? 'Revert' : 'Reviewed';
    el.title = type === 'reject'
      ? 'Restore this chunk to the version on the left, then save'
      : 'Stop flagging this chunk as a change in this view';
    el.addEventListener('click', action);
    return el;
  }

  function unifiedExt(original: string): Extension {
    return unifiedMergeView({
      original,
      gutter: true,
      highlightChanges: true,
      allowInlineDiffs: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
      mergeControls: writable ? mergeControl : false,
    });
  }

  function buildEditor(h: HTMLDivElement, mode: ViewMode) {
    const l = leftText ?? '';
    const r = rightText ?? '';
    if (mode === 'split') {
      mv = new MergeView({
        a: { doc: l, extensions: [...baseExtensions(), EditorState.readOnly.of(true)] },
        b: {
          doc: r,
          extensions: [
            ...baseExtensions(),
            EditorState.readOnly.of(!writable),
            ...(writable ? [highlightActiveLine(), onEdit()] : []),
          ],
        },
        parent: h,
        // The whole point of the rewrite: the unchanged body of the file is
        // present, folded to a clickable strip until someone wants it.
        collapseUnchanged: { margin: 3, minSize: 4 },
        highlightChanges: true,
        gutter: true,
        // Arrows that copy a chunk from the base onto the working copy — the
        // revert, without leaving the diff. Pointless when nothing is writable.
        ...(writable ? { revertControls: 'a-to-b' as const } : {}),
      });
      syncX(mv.a.scrollDOM, mv.b.scrollDOM);
      installSplit();
    } else {
      uv = new EditorView({
        doc: r,
        parent: h,
        extensions: [
          ...baseExtensions(),
          EditorState.readOnly.of(!writable),
          ...(writable ? [highlightActiveLine(), onEdit()] : []),
          unifiedExt(l),
        ],
      });
    }
  }

  // The merge package gives each side its own scroller, so a view that only
  // lines up vertically is half a diff. Mirroring scrollLeft needs the guard:
  // the assignment fires the peer's own scroll event, which would assign
  // straight back and pin the pair mid-gesture.
  let syncing = false;
  let unsync: (() => void) | null = null;
  function syncX(a: HTMLElement, b: HTMLElement) {
    const mirror = (from: HTMLElement, to: HTMLElement) => () => {
      if (syncing) return;
      syncing = true;
      to.scrollLeft = from.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    };
    const ab = mirror(a, b);
    const ba = mirror(b, a);
    a.addEventListener('scroll', ab, { passive: true });
    b.addEventListener('scroll', ba, { passive: true });
    unsync = () => {
      a.removeEventListener('scroll', ab);
      b.removeEventListener('scroll', ba);
      unsync = null;
    };
  }

  // The merge package sizes its two editors flex-grow:1 / flex-basis:0 and
  // offers no way to move the boundary — which leaves a mostly-empty left side
  // eating half the width on a file that is nearly all additions. Both sides
  // are ordinary flex children, so a handle dropped into that row is the whole
  // fix: no fork, nothing reimplemented.
  const SPLIT_KEY = 'ghmd.diffSplit';
  let split: { destroy(): void } | null = null;
  function installSplit() {
    split?.destroy();
    split = null;
    const row = mv?.dom.querySelector('.cm-mergeViewEditors') as HTMLElement | null;
    if (!row) return;
    const wraps = ([...row.children] as HTMLElement[])
      .filter((c) => c.classList.contains('cm-mergeViewEditor'));
    if (wraps.length !== 2) return;
    const h = makeSplitHandle(wraps[0], wraps[1], { axis: 'x', key: SPLIT_KEY, initial: 0.5 });
    // Anchored to the node rather than to an index: the package inserts its
    // revert gutter as the second child, so counting positions would put the
    // handle in the wrong gap.
    row.insertBefore(h.el, wraps[1]);
    split = h;
  }

  // Same lockstep for the patch renderer's two columns, which are plain divs
  // rather than editors and so need their own listeners.
  function syncCols(node: HTMLElement) {
    let held = false;
    const offs: (() => void)[] = [];
    const cols = [...node.querySelectorAll('.splitcol')] as HTMLElement[];
    const on = (from: HTMLElement, to: HTMLElement) => {
      const h = () => {
        if (held) return;
        held = true;
        to.scrollLeft = from.scrollLeft;
        requestAnimationFrame(() => { held = false; });
      };
      from.addEventListener('scroll', h, { passive: true });
      offs.push(() => from.removeEventListener('scroll', h));
    };
    if (cols.length === 2) {
      on(cols[0], cols[1]);
      on(cols[1], cols[0]);
      // Same handle, same stored ratio: switching between the merge view and
      // the patch renderer should not silently rearrange the columns.
      const h = makeSplitHandle(cols[0], cols[1], { axis: 'x', key: SPLIT_KEY, initial: 0.5 });
      cols[1].parentElement?.insertBefore(h.el, cols[1]);
      offs.push(() => h.destroy());
    }
    return { destroy() { for (const off of offs) off(); } };
  }

  function destroyEditor() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    unsync?.();
    split?.destroy();
    split = null;
    mv?.destroy();
    uv?.destroy();
    mv = null;
    uv = null;
  }

  // Tracks exactly three things: the container, the chosen view, and the
  // document generation. Everything the builder reads is untracked, so the
  // effect cannot invalidate itself on the state it writes.
  $effect(() => {
    const h = host;
    const mode = view;
    const gen = docsVersion;
    if (!h || !gen) return;
    untrack(() => buildEditor(h, mode));
    return destroyEditor;
  });

  // Put the reader back where they were, once per build — which includes the
  // first build after a tab switch or a reload, and the rebuild that a wrap
  // change forces. Declared after the builder so the container it needs already
  // exists, and retried rather than assigned once: the split view folds every
  // unchanged region on install and measures over several frames, so for the
  // first of them it is far shorter than the saved offset.
  $effect(() => {
    // Waits for a generation, not just for the effect to run. The diff arrives
    // from the server well after mount, and until it does there are no editors
    // and nothing to scroll; spending the retry budget on that dead time is how
    // this lands on zero. A generation means the builder above has just run, and
    // since that runs first, the container is already populated here.
    const gen = docsVersion;
    void shownView;
    if (!gen || pendingScroll === null) return;
    const top = pendingScroll;
    pendingScroll = null;
    return restoreScrollTop(() => scroller(), top);
  });

  function scheduleSave() {
    if (!writable) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; void save(); }, 900);
  }

  async function save() {
    const b = mv ? mv.b : uv;
    if (!writable || !b) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const content = b.state.doc.toString();
    if (!savable) {
      // Nothing on disk to write to, so the edit goes back to whoever owns the
      // buffer and the hunks refresh against it. The auto path deliberately:
      // the text already on screen is the text that was just typed, and a
      // rebuild would cost the cursor for nothing.
      rightText = content;
      dirty = false;
      onScratch?.(content);
      void load(true);
      return;
    }
    saving = true;
    try {
      const r = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: rightSavePath, content, baseMtimeMs: rightMtime }),
      });
      const d = await r.json();
      if (r.status === 409) {
        // Someone else wrote the file after this view loaded. Adopting their
        // mtime as the new base means a second save deliberately overwrites —
        // the user has been told, and the choice is theirs.
        rightMtime = d.mtimeMs ?? rightMtime;
        saveErr = 'This file changed on disk after the diff loaded. Save again to overwrite it, or reload to take the disk copy.';
        return;
      }
      if (!r.ok) { saveErr = d.error ?? `HTTP ${r.status}`; return; }
      saveErr = '';
      rightMtime = d.mtimeMs ?? 0;
      rightText = content;
      dirty = false;
      window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
    } catch (e) {
      saveErr = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  // Stage this one file — and, with a message, commit it — without leaving the
  // diff. Unsaved edits are flushed first, or the commit would capture the
  // version on disk rather than the one on screen.
  async function stageAndCommit(alsoCommit: boolean) {
    if (!repo || compare || busy) return;
    busy = true;
    try {
      if (dirty) await save();
      if (saveErr) return;
      const post = (body: unknown) => fetch('/api/git/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const s = await post({ op: 'stage', repo, paths: [path] });
      const sd = await s.json();
      if (!s.ok) { saveErr = sd.error ?? `HTTP ${s.status}`; return; }
      if (alsoCommit) {
        const c = await post({ op: 'commit', repo, message: commitMsg });
        const cd = await c.json();
        if (!c.ok) { saveErr = cd.error ?? `HTTP ${c.status}`; return; }
        commitMsg = '';
      }
      saveErr = '';
      window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
      await load();
      await loadDocs(true);
    } catch (e) {
      saveErr = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function reloadAll() {
    dirty = false;
    leftText = null;
    rightText = null;
    saveErr = '';
    cmError = '';
    void load();
    void loadDocs();
  }

  function toggle(h: number, i: number) {
    const s = new Set(sel[h]);
    if (s.has(i)) s.delete(i); else s.add(i);
    sel[h] = s;
  }

  async function apply(h: number, mode: 'stage' | 'unstage' | 'revert') {
    const n = sel[h]?.size ?? 0;
    const q = base
      ? `Restore ${n || 'all'} line(s) of this hunk to the base version? The working tree file is overwritten.`
      : `Revert ${n || 'all'} line(s) of this hunk in the working tree? This cannot be undone.`;
    if (mode === 'revert' && !window.confirm(q)) return;
    try {
      const r = await fetch('/api/git/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'apply', repo, path, mode, hunk: h, lines: [...(sel[h] ?? [])], untracked, ...(base ? { base } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) { error = d.error ?? `HTTP ${r.status}`; return; }
      window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
      await load();
      await loadDocs(true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Copy one hunk (or the selected lines of it) onto one side of a compare —
  // VS Code's per-change arrows. The target file is rewritten on disk, so it
  // always confirms first.
  async function applyCompare(h: number, target: 'left' | 'right') {
    if (!compare) return;
    const n = sel[h]?.size ?? 0;
    const dest = target === 'left' ? compare.leftPath : compare.rightPath ?? '';
    if (!window.confirm(`Apply ${n || 'all'} line(s) of this hunk to ${dest}? The file on disk is modified.`)) return;
    try {
      const r = await fetch('/api/diff/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...compare, target, hunk: h, lines: [...(sel[h] ?? [])] }),
      });
      const d = await r.json();
      if (!r.ok) { error = d.error ?? `HTTP ${r.status}`; return; }
      window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
      await load();
      await loadDocs(true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="difftab pl-dark">
  <div class="diff-head">
    <span class="diff-path" title={subject}>{subject}</span>
    <span class="diff-side">{compare ? `vs ${compare.rightLabel}` : to ? `${toLabel || to.slice(0, 7)} vs ${baseLabel || base.slice(0, 7)}` : base ? `vs ${baseLabel || base.slice(0, 7)}` : staged ? 'staged' : untracked ? 'untracked' : 'working tree'}</span>
    {#if shownView !== 'hunks' && writable}
      {#if dirty}
        <button type="button" class="pill dirtypill" title={savable ? 'Unsaved edits — click to save now' : 'Unsaved edits — click to fold them back into the buffer'} onclick={() => void save()}>● unsaved</button>
      {:else if saving}
        <span class="pill">saving…</span>
      {:else if !savable}
        <span class="pill" title="This side is a buffer, not a file — edits stay in the tab that owns it">scratch</span>
      {/if}
    {:else if shownView !== 'hunks'}
      <span class="pill">read-only</span>
    {/if}
    <span class="viewtoggle">
      <button type="button" class:on={wrap} title="Word wrap in this tab (Alt/Opt+Z)" onclick={() => toggleWrapFor(viewKey)}>Wrap</button>
    </span>
    <span class="viewtoggle">
      <button type="button" class:on={shownView === 'split'} disabled={cmBlocked} onclick={() => setView('split')}>Split</button>
      <button type="button" class:on={shownView === 'inline'} disabled={cmBlocked} onclick={() => setView('inline')}>Inline</button>
      <button type="button" class:on={shownView === 'hunks'} onclick={() => setView('hunks')}>Hunks</button>
    </span>
    <button type="button" class="icon-btn" title="Reload both sides from disk" onclick={reloadAll}>⟳</button>
  </div>
  {#if shownView !== 'hunks' && savable && repo && !compare}
    <!-- Commit without switching tabs: the file is staged first, so the commit
         captures exactly what is on screen rather than whatever happened to be
         in the index already. -->
    <div class="commitbar">
      <input
        type="text"
        placeholder="Commit message for this file…"
        bind:value={commitMsg}
        disabled={busy}
        onkeydown={(e) => { if (e.key === 'Enter' && commitMsg.trim()) void stageAndCommit(true); }}
      />
      <button type="button" disabled={busy} onclick={() => void stageAndCommit(false)}>Stage file</button>
      <button type="button" class="primary" disabled={busy || !commitMsg.trim()} onclick={() => void stageAndCommit(true)}>Stage &amp; commit</button>
    </div>
  {/if}
  {#if error}<div class="diff-error">{error}</div>{/if}
  {#if saveErr}<div class="diff-error">{saveErr}</div>{/if}
  {#if cmError && view !== 'hunks'}<div class="diff-note">{cmError}</div>{/if}
  {#if shownView !== 'hunks'}
    {#if leftText === null || rightText === null}
      <div class="empty">Loading file…</div>
    {:else}
      <div class="cmarea">
        <div class="cmwrap" bind:this={host}></div>
        <div class="diff-tick-rail" class:split={paneCount > 1} aria-hidden="true">
          {#each matchTicks as t, i (i + ':dmatch')}
            <span class="tick" class:right={t.side === 1} class:hidden-match={t.hidden} style="top: {t.y}px"></span>
          {/each}
          {#if currentTickY !== null}
            <span class="tick current" class:right={currentTickSide === 1} style="top: {currentTickY}px"></span>
          {/if}
        </div>
      </div>
    {/if}
  {:else if loading}
    <div class="empty">Loading diff…</div>
  {:else if flags.binary}
    <div class="empty">Binary file — no text diff.</div>
  {:else if flags.tooBig}
    <div class="empty">Diff exceeds 2 MB — open the file instead.</div>
  {:else if !hunks.length}
    <div class="empty">{compare ? 'Both inputs are identical.' : 'No changes on this side.'}</div>
  {:else}
    <div class="hunks">
      {#each hunks as h, hi (hi)}
        <div class="hunk">
          <div class="hunk-head">
            <code>@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@ {h.section}</code>
            <span class="hunk-actions">
              {#if sel[hi]?.size}<span class="selcount">{sel[hi].size} selected</span>{/if}
              {#if readOnly}
                <!-- Both sides are pinned commits: no working tree exists for
                     a patch to land in, so no action is offered at all. -->
                <span class="selcount">read-only</span>
              {:else if compare}
                <!-- VS Code's per-change arrows: copy this change onto either
                     side. A column with no file behind it is not a target —
                     the split view edits it directly instead. -->
                {#if compare.leftPath}
                  <button type="button" onclick={() => void applyCompare(hi, 'left')}>⇤ Apply {sel[hi]?.size ? 'selected' : 'hunk'} to left</button>
                {/if}
                {#if compare.rightPath}
                  <button type="button" onclick={() => void applyCompare(hi, 'right')}>Apply {sel[hi]?.size ? 'selected' : 'hunk'} to right ⇥</button>
                {/if}
              {:else if base}
                <button type="button" class="danger" onclick={() => void apply(hi, 'revert')}>Restore {sel[hi]?.size ? 'selected' : 'hunk'} from base</button>
              {:else if staged}
                <button type="button" onclick={() => void apply(hi, 'unstage')}>Unstage {sel[hi]?.size ? 'selected' : 'hunk'}</button>
              {:else}
                <button type="button" onclick={() => void apply(hi, 'stage')}>Stage {sel[hi]?.size ? 'selected' : 'hunk'}</button>
                <button type="button" class="danger" onclick={() => void apply(hi, 'revert')}>Revert {sel[hi]?.size ? 'selected' : 'hunk'}</button>
              {/if}
            </span>
          </div>
          {#if view === 'split'}
            {@const rows = splitRows(h)}
            <div class="splitwrap" class:wrapon={wrap} use:syncCols>
              {#each [0, 1] as side (side)}
              <div class="splitcol">
                {#each rows as row, ri (ri)}
                  {@const cell = side === 0 ? row.left : row.right}
                  {#if cell && (cell.line.t === '+' || cell.line.t === '-')}
                    {@const tk = toks(hi, cell.idx, side === 0 ? 'o' : 'n')}
                    <div
                      class="scell changed"
                      class:add={cell.line.t === '+'}
                      class:del={cell.line.t === '-'}
                      class:selected={sel[hi]?.has(cell.idx)}
                      role="button"
                      tabindex="0"
                      title="Click to include/exclude this line from the next stage/unstage/revert"
                      onclick={() => toggle(hi, cell.idx)}
                      onkeydown={(e) => { if (e.key === 'Enter') toggle(hi, cell.idx); }}
                    >
                      <span class="gut">{(side === 0 ? cell.line.o : cell.line.n) ?? ''}</span>
                      <span class="mark">{cell.line.t}</span>
                      <span class="text">{#if tk}{#each tk as k, ki (ki)}<span class={k.cls}>{k.text}</span>{/each}{:else}{cell.line.text}{/if}</span>
                    </div>
                  {:else}
                    {@const tk = cell ? toks(hi, cell.idx, side === 0 ? 'o' : 'n') : null}
                    <div class="scell" class:blank={!cell}>
                      <span class="gut">{cell ? ((side === 0 ? cell.line.o : cell.line.n) ?? '') : ''}</span>
                      <span class="mark"></span>
                      <span class="text">{#if tk}{#each tk as k, ki (ki)}<span class={k.cls}>{k.text}</span>{/each}{:else}{cell?.line.text ?? ''}{/if}</span>
                    </div>
                  {/if}
                {/each}
              </div>
              {/each}
            </div>
          {:else}
          <div class="linewrap">
          {#each h.lines as l, li (li)}
            {#if l.t === '+' || l.t === '-'}
              {@const tk = toks(hi, li, l.t === '-' ? 'o' : 'n')}
              <div
                class="dline changed"
                class:add={l.t === '+'}
                class:del={l.t === '-'}
                class:selected={sel[hi]?.has(li)}
                role="button"
                tabindex="0"
                title="Click to include/exclude this line from the next stage/unstage/revert"
                onclick={() => toggle(hi, li)}
                onkeydown={(e) => { if (e.key === 'Enter') toggle(hi, li); }}
              >
                <span class="gut">{l.o ?? ''}</span>
                <span class="gut">{l.n ?? ''}</span>
                <span class="mark">{l.t}</span>
                <span class="text">{#if tk}{#each tk as k, ki (ki)}<span class={k.cls}>{k.text}</span>{/each}{:else}{l.text}{/if}</span>
              </div>
            {:else}
              {@const tk = toks(hi, li, 'n')}
              <div class="dline" class:meta={l.t === '\\'}>
                <span class="gut">{l.o ?? ''}</span>
                <span class="gut">{l.n ?? ''}</span>
                <span class="mark">{l.t === '\\' ? '\\' : ''}</span>
                <span class="text">{#if tk}{#each tk as k, ki (ki)}<span class={k.cls}>{k.text}</span>{/each}{:else}{l.text}{/if}</span>
              </div>
            {/if}
          {/each}
          </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* The GitHub-dark token palette this pane needs lives in app.css under
     `pl-dark`, shared with every other hard-coded-dark code surface. */

  /* @codemirror/merge ships a light-first palette. Every rule below is two
     classes deep so it outranks the package's own base theme without
     !important, exactly like the starry-night block above. */
  /* Height belongs to the merge container alone. Handing it to the editors
     row as well capped both sides at the pane height while their content kept
     its real size, and the package's own `.cm-mergeViewEditor { overflow:
     hidden }` then clipped the overflow — so the container that owns the
     scroll had nothing left to scroll and split mode lost its scrollbar. */
  .difftab :global(.cm-mergeView) { height: 100%; }
  /* `min-width: 0` so a flex column can actually shrink. `clip` rather than the
     package's own `hidden` for a subtler reason: the two clip identically, but
     `hidden` also makes the box a scroll container -- and a scroll container is
     exactly what `position: sticky` measures itself against. CodeMirror's base
     theme makes the find panel sticky, so while this wrapper counted as one the
     panel pinned itself to the top of a box as tall as the whole file, scrolled
     away with the text, and left the reader typing into a find box that was no
     longer on screen. `clip` is not a scroll container, so the panel now
     measures against the merge container -- the element that really scrolls --
     and stays put at the top of its pane. */
  .difftab :global(.cm-mergeViewEditor) { min-width: 0; overflow: clip; }
  /* The package hands the container the vertical scroll and leaves each
     editor overflow-hidden, which is why a line wider than its pane simply
     vanished off the right edge instead of revealing a scrollbar. Restore
     that axis per side; script keeps the two sides in lockstep. */
  .difftab :global(.cm-merge-a .cm-scroller),
  .difftab :global(.cm-merge-b .cm-scroller) {
    overflow-x: auto;
    /* Setting one axis to `auto` promotes the computed value of the other from
       `visible` to `auto`. That handed each side its own vertical scrollbar and
       left the merge container — the element that actually owns vertical
       scroll — with nothing to scroll once the pane got short. */
    overflow-y: hidden;
  }
  .difftab :global(.cm-merge-a .cm-changedLine),
  .difftab :global(.cm-deletedChunk) { background: rgba(248, 81, 73, 0.13); }
  .difftab :global(.cm-merge-a .cm-changedText),
  .difftab :global(.cm-deletedChunk .cm-deletedText) { background: rgba(248, 81, 73, 0.32); }
  .difftab :global(.cm-merge-b .cm-changedLine),
  .difftab :global(.cm-insertedLine),
  .difftab :global(.cm-inlineChangedLine) { background: rgba(46, 160, 67, 0.13); }
  .difftab :global(.cm-merge-b .cm-changedText),
  .difftab :global(.cm-insertedLine .cm-changedText) { background: rgba(46, 160, 67, 0.32); }
  .difftab :global(.cm-changeGutter) { background: transparent; }
  .difftab :global(.cm-changedLineGutter) { background: #e58520; }
  .difftab :global(.cm-deletedLineGutter) { background: #f28b82; }
  .difftab :global(.cm-inlineChangedLineGutter) { background: #e2c08d; }
  /* The collapsed strip IS the new feature's affordance — it has to read as a
     button, not as a stray blank line. */
  .difftab :global(.cm-collapsedLines) {
    padding: 3px 6px 3px 12px;
    background: #262626;
    border-top: 1px solid #3a3a3a;
    border-bottom: 1px solid #3a3a3a;
    color: #949494;
    font-size: 11px;
    cursor: pointer;
  }
  .difftab :global(.cm-collapsedLines:hover) { background: #303030; color: #c5c8c6; }

  /* CodeMirror's base theme puts the find panel in flow above the scroller.
     Harmless in a single editor, wrong in a diff: opening find in one column
     pushes that column's rows down by the panel's height and the two sides
     stop lining up -- until the other column's panel happens to open too, at
     which point they silently line up again. Floating it over the text keeps
     both scrollers the same height whatever is open. */
  .difftab :global(.cm-panels.cm-panels-top) {
    position: absolute;
    top: 0;
    right: 0;
    left: auto;
    width: max-content;
    max-width: 100%;
    z-index: 12;
    border-bottom: 1px solid #404040;
    border-left: 1px solid #404040;
    border-radius: 0 0 0 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  }
  .difftab :global(.cm-chunkButtons) { gap: 4px; }
  /* Built imperatively by @codemirror/merge, so scoped styles never reach
     them — these have to be :global. */
  .difftab :global(.gmd-mc) {
    border: 1px solid #505050;
    background: #2d2d2d;
    color: #c5c8c6;
    border-radius: 4px;
    font-size: 10px;
    padding: 0 6px;
    cursor: pointer;
  }
  .difftab :global(.gmd-mc:hover) { background: #3a3a3a; }
  .difftab :global(.gmd-mc-reject) { color: #f28b82; }
  .difftab :global(.cm-merge-revert button) {
    color: #c5c8c6;
    background: #2d2d2d;
    border: 1px solid #505050;
  }

  .difftab {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    color: #c5c8c6;
  }
  .cmarea {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    display: flex;
  }
  .cmwrap {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  /* Both columns' ticks land on this one rail, because a split diff has only
     one vertical scrollbar to mark up. Amber is a match, orange is the one the
     cursor is on -- the same reading as the code editor's rail. */
  .diff-tick-rail {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 24px;
    pointer-events: none;
    z-index: 5;
  }
  .diff-tick-rail .tick {
    position: absolute;
    right: 2px;
    width: 20px;
    height: 3px;
    border-radius: 1px;
    background: rgba(255, 195, 0, 0.85);
  }
  /* Split mode runs two independent searches against one rail. Halving it
     gives each column a lane, so twenty-four hits on the left and forty-six on
     the right stay readable as two sets instead of seventy anonymous marks. */
  .diff-tick-rail.split .tick { width: 9px; right: 13px; }
  .diff-tick-rail.split .tick.right { right: 2px; }
  /* Hollow means the line is folded away behind an unchanged-lines strip, so
     every match in that stretch shares this one y. Stepping onto it unfolds
     the strip and the marks separate. */
  .diff-tick-rail .tick.hidden-match {
    background: transparent;
    height: 5px;
    box-shadow: inset 0 0 0 1px rgba(255, 195, 0, 0.95);
  }
  .diff-tick-rail .tick.current {
    background: #ff6b00;
    height: 4px;
    width: 22px;
    right: 1px;
  }
  .diff-tick-rail.split .tick.current { width: 11px; right: 12px; }
  .diff-tick-rail.split .tick.current.right { right: 1px; }
  /* Built in script — the merge package and the patch renderer each assemble
     their own DOM — so the rule has to escape component scoping. */
  .difftab :global(.gmd-split-handle) {
    flex: 0 0 6px;
    align-self: stretch;
    box-sizing: border-box;
    cursor: col-resize;
    background: #2b2b2b;
    border-left: 1px solid #404040;
    border-right: 1px solid #404040;
    /* Without this the browser claims the gesture for panning and the drag
       never reaches the pointer handlers on a touch screen. */
    touch-action: none;
  }
  .difftab :global(.gmd-split-handle:hover),
  .difftab :global(.gmd-split-handle.active) {
    background: #0e639c;
    border-color: #0e639c;
  }
  .diff-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid #404040;
    background: #272727;
    font-size: 12px;
  }
  .diff-path {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .diff-side {
    flex: 0 0 auto;
    color: #949494;
    font-size: 11px;
    border: 1px solid #404040;
    border-radius: 8px;
    padding: 0 8px;
  }
  .pill {
    flex: 0 0 auto;
    font-size: 11px;
    color: #949494;
    border: 1px solid #404040;
    border-radius: 8px;
    padding: 0 8px;
    background: transparent;
  }
  .dirtypill { color: #e58520; border-color: #e58520; cursor: pointer; }
  .commitbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-bottom: 1px solid #404040;
    background: #232323;
  }
  .commitbar input {
    flex: 1 1 auto;
    min-width: 0;
    background: #1e1e1e;
    border: 1px solid #505050;
    border-radius: 4px;
    color: #c5c8c6;
    font-size: 12px;
    padding: 2px 8px;
  }
  .commitbar input:focus { outline: none; border-color: #e58520; }
  .commitbar button {
    flex: 0 0 auto;
    border: 1px solid #505050;
    background: #2d2d2d;
    color: #c5c8c6;
    border-radius: 4px;
    font-size: 11px;
    padding: 2px 10px;
    cursor: pointer;
  }
  .commitbar button:hover:not(:disabled) { background: #3a3a3a; }
  .commitbar button:disabled { opacity: 0.5; cursor: default; }
  .commitbar button.primary { border-color: #e58520; color: #e58520; }
  .diff-error {
    flex: 0 0 auto;
    margin: 6px 10px 0;
    padding: 4px 8px;
    background: rgba(248, 81, 73, 0.15);
    border: 1px solid rgba(248, 81, 73, 0.4);
    border-radius: 4px;
    color: #f28b82;
    font-size: 12px;
  }
  .diff-note {
    flex: 0 0 auto;
    margin: 6px 10px 0;
    padding: 4px 8px;
    background: rgba(229, 133, 32, 0.12);
    border: 1px solid rgba(229, 133, 32, 0.35);
    border-radius: 4px;
    color: #e2c08d;
    font-size: 12px;
  }
  .hunks {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    padding-bottom: 24px;
  }
  .hunk { margin-top: 10px; }
  .hunk-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 10px;
    background: rgba(255, 255, 255, 0.05);
    border-top: 1px solid #404040;
    border-bottom: 1px solid #404040;
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .hunk-head code {
    color: #79c0ff;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hunk-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }
  .hunk-actions button {
    border: 1px solid #404040;
    background: #353535;
    color: #c5c8c6;
    border-radius: 4px;
    font-size: 11px;
    padding: 1px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .hunk-actions button:hover { background: #404040; }
  .hunk-actions button.danger { color: #f28b82; }
  .selcount { color: #e58520; font-size: 11px; }
  /* One horizontal scroller per hunk: a long line in hunk 3 must not widen
     hunk 1, and clipping (the old overflow:hidden) hid code outright. */
  .linewrap { overflow-x: auto; }
  .dline {
    display: flex;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
    /* max-content so the row grows with the code, min 100% so the +/- row
       tint still spans the full pane on short lines. */
    width: max-content;
    min-width: 100%;
  }
  .dline.changed { cursor: pointer; }
  .dline.add { background: rgba(46, 160, 67, 0.15); }
  .dline.del { background: rgba(248, 81, 73, 0.15); }
  .dline.add .mark { color: #81c995; }
  .dline.del .mark { color: #f28b82; }
  .dline.selected { outline: 1px solid #e58520; outline-offset: -1px; }
  .dline.meta { color: #949494; font-style: italic; }
  .gut {
    flex: 0 0 44px;
    text-align: right;
    padding-right: 8px;
    color: #8a8a8a;
    user-select: none;
  }
  .mark {
    flex: 0 0 16px;
    text-align: center;
    user-select: none;
  }
  /* Never flex-shrink: the text span's own width is what makes the row's
     max-content width (and therefore the scroll range) correct. */
  .text { flex: 0 0 auto; padding-right: 12px; }
  .icon-btn {
    border: none;
    background: transparent;
    color: #949494;
    cursor: pointer;
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 13px;
  }
  .icon-btn:hover { background: #444444; color: #c5c8c6; }
  .viewtoggle {
    display: flex;
    flex: 0 0 auto;
    margin-left: auto;
    border: 1px solid #404040;
    border-radius: 6px;
    overflow: hidden;
  }
  .viewtoggle button {
    border: none;
    background: transparent;
    color: #949494;
    font-size: 11px;
    padding: 1px 8px;
    cursor: pointer;
  }
  .viewtoggle button:disabled { opacity: 0.4; cursor: default; }
  .viewtoggle button.on {
    background: #353535;
    color: #c5c8c6;
  }
  /* Each side is its own horizontal scroller, VS Code style. A grid with
     max-content tracks does NOT work here: the tracks can never exceed the
     grid container's width, so long lines just painted across the gutter into
     the other column.
     The two boxes scroll independently in the DOM but are mirrored from
     script: reading a diff means comparing the same column on both sides, so
     letting one drift sideways from the other defeats the whole view.
     overflow-y stays effectively visible: the columns are never height-capped,
     so nothing ever overflows vertically and .hunks keeps owning that axis. */
  .splitwrap {
    display: flex;
    align-items: flex-start;
  }
  .splitcol {
    flex: 1 1 50%;
    min-width: 0;
    overflow-x: auto;
  }
  .splitcol + .splitcol { border-left: 1px solid #404040; }
  /* Wrapped: nothing overflows, so those scrollers would render a dead track.
     Rows give up their max-content width and reflow in place instead. */
  .splitwrap.wrapon .splitcol { overflow-x: hidden; }
  .splitwrap.wrapon .scell { width: auto; white-space: pre-wrap; }
  .splitwrap.wrapon .scell .text { overflow-wrap: anywhere; }
  .scell {
    display: flex;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
    width: max-content;
    min-width: 100%;
    /* The two columns are now independent scrollers, so a blank cell has no
       flex sibling to stretch against: without a floor its empty spans give it
       zero height and the sides drift out of alignment. 1.5em == line-height. */
    min-height: 1.5em;
  }
  .scell.changed { cursor: pointer; }
  .scell.add { background: rgba(46, 160, 67, 0.15); }
  .scell.del { background: rgba(248, 81, 73, 0.15); }
  .scell.add .mark { color: #81c995; }
  .scell.del .mark { color: #f28b82; }
  .scell.selected { outline: 1px solid #e58520; outline-offset: -1px; }
  .scell.blank { background: rgba(110, 118, 129, 0.06); }
  .scell .gut { flex: 0 0 40px; }
  .empty {
    padding: 24px;
    color: #949494;
    text-align: center;
    font-size: 13px;
  }
</style>