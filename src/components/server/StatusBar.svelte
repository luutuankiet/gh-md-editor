<script lang="ts">
  // The bottom strip: which machine is serving this workspace, what git is
  // doing in the anchored repository, and how big the open file is in the unit
  // that actually matters when the file is headed for a model. Every segment
  // is either a fact or a button — nothing decorative.
  import { formatTokens } from '../../lib/token-estimate';

  type Repo = {
    repo: string;
    branch?: string;
    ahead?: number;
    behind?: number;
    changes?: number;
    error?: string;
    // 'repo' is an ordinary checkout, 'worktree' one linked to another, and
    // 'worktree-broken' one whose link the server could not put back.
    kind?: string;
    // The owning checkout, shared by a repository and every worktree of it —
    // the key the picker groups on.
    group?: string;
    worktree?: string;
    // Context rather than content: the owner and siblings of the worktree the
    // workspace was opened on, which nobody asked to see but everybody wants
    // once they are looking at one branch of a repository.
    related?: boolean;
    // The exact command that puts a broken worktree link back. Composed by the
    // server because only it can tell which repository owns this checkout.
    fix?: string;
  };

  let {
    host = '',
    folder = '',
    anchor = $bindable(''),
    blocked = $bindable(false),
    tokens = 0,
    tokenLabel = '',
    onPickRef,
  }: {
    host?: string;
    folder?: string;
    // Repo-relative path of the repository every git segment refers to. Bound
    // so the command palette can act on the same choice this bar displays.
    anchor?: string;
    // True when the anchored checkout is one git refuses to open. The panels
    // read it to stay out of the way: a repository that cannot answer
    // `status` has nothing useful to say about diffs, history or staging
    // either, and three panels each inventing their own wording for that is
    // how one workspace ends up giving several different accounts of itself.
    blocked?: boolean;
    // Token estimate for the active editor; 0 when nothing countable is open.
    tokens?: number;
    tokenLabel?: string;
    onPickRef: (repo: string) => void;
  } = $props();

  let repos = $state<Repo[]>([]);
  let menuOpen = $state(false);

  // A workspace with several repos has no natural "main" one, so the choice is
  // remembered per workspace rather than globally — switching workspaces must
  // not drag the previous one's anchor along.
  const KEY = 'ghmd.gitAnchor';
  // Both remembered maps are workspace-keyed objects, and a stored value of
  // any other shape has to be discarded rather than written into. Assigning a
  // property to a parsed array survives JSON.stringify by being silently
  // dropped; assigning to a parsed string throws under this module's strict
  // mode and lands in the same catch as a quota error. Either way the choice
  // is never persisted, and it looks from outside like the picker forgetting.
  function readMap<T>(key: string): Record<string, T> {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null');
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {};
    } catch {
      return {};
    }
  }
  function writeMap(key: string, value: unknown) {
    try {
      const all = readMap<unknown>(key);
      all[folder || '.'] = value;
      localStorage.setItem(key, JSON.stringify(all));
    } catch {
      /* private mode */
    }
  }
  const readAnchors = () => readMap<string>(KEY);
  const rememberAnchor = (repo: string) => writeMap(KEY, repo);

  // Which repository groups are folded shut, remembered the same way and for
  // the same reason as the anchor: per workspace, because a fold that made
  // sense in one has nothing to say about the next.
  const GROUPS_KEY = 'ghmd.repoGroups';
  let collapsed = $state(new Set<string>());
  // Whether this workspace has ever been folded by hand. Until it has, the
  // fold state is a default the scan gets to choose rather than a preference
  // that has to be preserved.
  let collapsedStored = false;
  function loadCollapsed() {
    const mine = readMap<string[]>(GROUPS_KEY)[folder || '.'];
    collapsedStored = Array.isArray(mine);
    collapsed = new Set(collapsedStored ? mine : []);
  }
  function toggleGroup(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed = next;
    collapsedStored = true;
    writeMap(GROUPS_KEY, [...next]);
  }

  // Confirmation that the repair command reached the clipboard. That command
  // is the entire point of the broken-worktree row, and a copy button that
  // gives no sign of having worked gets pressed three times and trusted none.
  let toast = $state('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; }, 4500);
  }
  $effect(() => () => clearTimeout(toastTimer));

  async function copyFix(cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      showToast('Command copied. Run it in a terminal, then Scan again.');
    } catch {
      // The clipboard is unavailable outside a secure context, which is how
      // this server is most often reached. The command is on screen either
      // way, so say that rather than appearing to do nothing.
      showToast('Could not copy — select the command and copy it by hand.');
    }
  }

  // Four things start a scan — the workspace changing, the palette opening the
  // picker, any git action anywhere in the app, and the button below — so
  // several are routinely in flight at once. Without a token the slowest one
  // wins, and the anchor rule re-runs against a list already out of date.
  let scan = 0;
  async function refresh() {
    const mine = ++scan;
    let next: Repo[] = [];
    try {
      const r = await fetch(`/api/git/repos?base=${encodeURIComponent(folder)}`);
      const d = await r.json();
      next = r.ok ? (d.repos ?? []) : [];
    } catch {
      next = [];
    }
    if (mine !== scan) return;
    repos = next;
    // Only ever settle on a repository git will actually answer questions
    // about. Anchoring on a broken one used to leave this bar saying "git
    // error" while the panels beside it, which skip those, said "no repository
    // selected" — one workspace, two answers, neither of them useful. The
    // workspace's own checkouts win over the context pulled in beside them.
    const usable = (x: Repo) => !x.error;
    const remembered = readAnchors()[folder || '.'];
    if (remembered && repos.some((x) => x.repo === remembered && usable(x))) anchor = remembered;
    else if (!repos.some((x) => x.repo === anchor && usable(x)))
      // Last resort is the broken one rather than nothing at all: it is still
      // the folder that was opened, and anchoring on it is what lets the
      // panels show why it will not open instead of each inventing its own
      // empty state for a repository they have quietly declined to name.
      anchor = (repos.find((x) => usable(x) && !x.related) ?? repos.find(usable) ?? repos[0])?.repo ?? '';
    // Folded by default unless the anchored repository is inside. A workspace
    // opened on one worktree has no use for a list of the others until it asks
    // for one, and a group holding the thing being looked at is not noise.
    if (!collapsedStored) {
      const mineGroup = repos.find((x) => x.repo === anchor)?.group;
      collapsed = new Set(repos.map((x) => x.group).filter((g): g is string => !!g && g !== mineGroup));
    }
  }

  // Re-scan when the workspace changes…
  $effect(() => {
    void folder;
    loadCollapsed();
    void refresh();
  });
  // The command palette cannot reach into this component, so "Open Git
  // Repository…" arrives the same way git changes do.
  $effect(() => {
    const on = () => { menuOpen = true; void refresh(); };
    window.addEventListener('gmd:open-repo-picker', on);
    return () => window.removeEventListener('gmd:open-repo-picker', on);
  });
  // …and whenever something in the app moved git. Staging, committing and
  // branch switches all fire this, so the bar never shows a stale branch.
  $effect(() => {
    const on = () => void refresh();
    window.addEventListener('gmd:git-changed', on);
    return () => window.removeEventListener('gmd:git-changed', on);
  });

  let current = $derived(repos.find((r) => r.repo === anchor) ?? null);
  // A broken checkout stays anchored on purpose — it is still the folder that
  // was opened, and the row for it is the only place that can say what is
  // wrong and what to type. What must not happen is the git panels going on
  // treating it as a repository they can act on.
  $effect(() => { blocked = !!current?.error; });

  // A repository and its worktrees are one thing seen from several places, so
  // the menu nests them under the checkout they share rather than listing
  // siblings that look unrelated. Anything without an owner stays flat.
  type Row = { r: Repo; depth: number; groupKey: string; kids: number };
  let rows = $derived.by(() => {
    const out: Row[] = [];
    // An owning checkout the scan found on its own merits carries no `group`
    // of its own — only rows pulled in as context around a worktree do.
    // Collecting the keys first is what stops that owner being listed twice:
    // once as a group head with no branch and no counts, and again further
    // down as itself.
    const keys = new Set<string>();
    for (const r of repos) if (r.group) keys.add(r.group);
    const groups = new Map<string, Repo[]>();
    const loose: Repo[] = [];
    for (const r of repos) {
      const key = r.group ?? (keys.has(r.repo) ? r.repo : '');
      if (!key) { loose.push(r); continue; }
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    for (const [key, members] of groups) {
      const kids = members.filter((m) => m.repo !== key).length;
      out.push({ r: members.find((m) => m.repo === key) ?? { repo: key }, depth: 0, groupKey: key, kids });
      // Folding a group must never hide the repository currently anchored:
      // when the workspace was opened on a worktree, that row is the only
      // child of its owner, and folding it left a menu with no way back.
      const holdsAnchor = members.some((m) => m.repo === anchor && m.repo !== key);
      if (collapsed.has(key) && !holdsAnchor) continue;
      for (const m of members) if (m.repo !== key) out.push({ r: m, depth: 1, groupKey: key, kids: 0 });
    }
    for (const r of loose) out.push({ r, depth: 0, groupKey: '', kids: 0 });
    return out;
  });

  // What the repo segment says about itself on hover: which repository this
  // is, and — once it has been touched — that its link was put back.
  let anchorTitle = $derived(
    !current
      ? 'No repository — click to look again'
      : [
          current.kind === 'worktree' && current.group
            ? `worktree of ${current.group}`
            : current.repo || '‹root›',
          current.error ? 'git cannot open it — click for the fix' : '',
          'click to switch',
        ]
          .filter(Boolean)
          .join(' — '),
  );

  function pickRepo(repo: string) {
    anchor = repo;
    rememberAnchor(repo);
    menuOpen = false;
  }

  const leafOf = (p: string) => {
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i === -1 ? t : t.slice(i + 1);
  };
</script>

<!-- A menu with no keyboard way out is a trap, and the command palette can
     open this one — the palette being the route that never involves a mouse. -->
<svelte:window onkeydown={(e) => { if (menuOpen && e.key === 'Escape') menuOpen = false; }} />

<footer class="statusbar">
  {#if host}
    <span class="host-chip" title="Served from {host}">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7l2 3v8h-11v-8zm0 3h7M6 8h4M6 10.5h4" /></svg>
      <span>{host}</span>
    </span>
  {/if}

  {#if current}
    {@const cur = current}
    {#if cur.error}
      <!-- A branch name is a fact, and there isn't one here. Printing
           'detached' in its place names a real state this repository is not
           in, and sends people looking for a checkout they never made. -->
      <!-- A dead end that cannot be clicked is just a complaint. This one
           opens the picker, where the row for this repository carries the
           reason and the command that fixes it. -->
      <button type="button" class="seg err" title={cur.error} onclick={() => (menuOpen = true)}>
        ⚠ {leafOf(cur.repo) || 'repository'} — {cur.kind === 'worktree-broken' ? 'broken worktree' : 'unavailable'}
      </button>
    {:else}
      <button
        type="button"
        class="seg"
        title="Switch or create a branch in {cur.repo || 'this repository'}"
        onclick={() => onPickRef(cur.repo)}
      >
        <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9M11 3.5v2a3 3 0 0 1-3 3H5" /><circle cx="5" cy="2.6" r="1.4" /><circle cx="5" cy="13.4" r="1.4" /><circle cx="11" cy="2.6" r="1.4" /></svg>
        <span class="branch">{cur.branch || 'detached'}</span>
        {#if cur.behind}<span class="num">↓{cur.behind}</span>{/if}
        {#if cur.ahead}<span class="num">↑{cur.ahead}</span>{/if}
      </button>
      {#if cur.changes}
        <span class="seg flat" title="{cur.changes} changed file{cur.changes === 1 ? '' : 's'}">● {cur.changes}</span>
      {/if}
    {/if}
  {/if}

  <!-- Always present. Hiding this button whenever the scan happened to return
       a single repository is what left a workspace with one *unusable* repo
       with no way to reach any other — the one moment a picker is needed most.
       It also stopped the bar jumping sideways between workspaces. -->
  <button type="button" class="seg" title={anchorTitle} onclick={() => (menuOpen = !menuOpen)}>
    {#if current?.kind === 'worktree'}<span class="wt" aria-hidden="true" title="linked worktree">⌗</span>{/if}
    <span class="repo-name">{repos.length ? leafOf(anchor) || '‹root›' : 'no repository'}</span>
    <span class="caret">▴</span>
  </button>

  <span class="gap"></span>

  {#if tokens > 0}
    <span class="seg flat" title="{tokenLabel || 'Active file'} — estimate, not an exact tokenizer count">
      ~{formatTokens(tokens)} tokens
    </span>
  {/if}
</footer>

{#if menuOpen}
  <!-- Scrim first so a click anywhere else dismisses without also activating
       whatever was underneath. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sb-scrim" onmousedown={() => (menuOpen = false)}></div>
  <div class="repo-menu" role="menu" aria-label="Git repositories">
    {#if !rows.length}
      <div class="rm-empty">No git repository in this workspace.</div>
    {/if}
    {#each rows as row (row.groupKey + '\u0000' + row.r.repo)}
      {@const r = row.r}
      <!-- role="none" because a row is two controls in a flex box, and a menu
           whose children are bare divs is announced as empty. -->
      <div class="rm-line" role="none" style="padding-left: {6 + row.depth * 14}px">
        {#if row.kids}
          <button
            type="button"
            class="rm-chev"
            aria-expanded={!collapsed.has(row.groupKey)}
            title={collapsed.has(row.groupKey)
              ? `Show ${row.kids} worktree${row.kids === 1 ? '' : 's'}`
              : 'Hide worktrees'}
            onclick={() => toggleGroup(row.groupKey)}
          >{collapsed.has(row.groupKey) ? '▸' : '▾'}</button>
        {:else if row.depth}
          <span class="rm-chev wt" title="linked worktree">⌗</span>
        {:else}
          <span class="rm-chev"></span>
        {/if}
        <button
          type="button"
          role="menuitem"
          class="rm-row"
          class:on={r.repo === anchor}
          aria-current={r.repo === anchor}
          title={r.error || r.repo}
          onclick={() => pickRepo(r.repo)}
        >
          <!-- Two worktrees of one repository can sit in directories whose
               last segment is the same word. The name git knows them by is the
               one guaranteed to differ. -->
          <span class="rm-path">{row.depth ? r.worktree || leafOf(r.repo) : r.repo || '‹root›'}</span>
          {#if r.error}
            <span class="rm-branch err">⚠ {r.kind === 'worktree-broken' ? 'broken' : 'unavailable'}</span>
          {:else}
            <span class="rm-branch">{r.branch ?? ''}</span>
            {#if r.behind}<span class="num">↓{r.behind}</span>{/if}
            {#if r.ahead}<span class="num">↑{r.ahead}</span>{/if}
            {#if r.changes}<span class="num">● {r.changes}</span>{/if}
          {/if}
        </button>
      </div>
      {#if r.error}
        <!-- The row above can only afford one word for this. Here is where the
             workspace gets told what actually happened and what to type, in
             the one place that already knows which repository it means. -->
        <div class="rm-note" style="padding-left: {20 + row.depth * 14}px">
          <span>{r.error}</span>
          {#if r.fix}
            <button type="button" class="rm-fix" title="Copy to clipboard" onclick={() => copyFix(r.fix ?? '')}>
              <code>{r.fix}</code>
              <span class="rm-copy">copy</span>
            </button>
          {/if}
        </div>
      {/if}
    {/each}
    <div class="rm-sep"></div>
    <button type="button" class="rm-row action" onclick={() => void refresh()}>Scan again</button>
  </div>
{/if}

{#if toast}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sb-toast" role="status" aria-live="polite" title="Dismiss" onmousedown={() => (toast = '')}>{toast}</div>
{/if}

<style>
  .statusbar {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    height: 22px;
    background: #232323;
    border-top: 1px solid #404040;
    font-size: 11px;
    color: #c5c8c6;
    user-select: none;
  }
  .gap { flex: 1 1 auto; }

  /* VS Code's remote indicator sits hard left and is the one coloured thing
     down here, because "which machine am I editing on" is the question a row
     of identical-looking browser tabs cannot answer. */
  .host-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px;
    background: #0e639c;
    color: #ffffff;
    font-weight: 500;
  }
  .host-chip svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
  }

  .seg {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: #c5c8c6;
    font: inherit;
    white-space: nowrap;
  }
  button.seg { cursor: pointer; }
  button.seg:hover { background: #3a3a3a; }
  .seg.flat { color: #949494; }
  .seg.err { color: #e58520; }
  .ico {
    width: 12px;
    height: 12px;
    fill: currentColor;
    stroke: currentColor;
    stroke-width: 1.1;
  }
  .branch {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .num { color: #949494; }
  .repo-name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .caret {
    color: #949494;
    font-size: 9px;
  }
  /* Says "this folder is one branch of a repository, not the whole of it"
     without spending a word on it — which is also what stops a silent link
     repair reading as a surprise later. */
  .wt {
    color: #949494;
    font-size: 11px;
  }

  .rm-line {
    display: flex;
    align-items: baseline;
    gap: 2px;
  }
  .rm-line:hover { background: #3a3a3a; }
  .rm-chev {
    flex: 0 0 auto;
    width: 14px;
    padding: 0;
    border: 0;
    background: transparent;
    color: #949494;
    font: inherit;
    font-size: 10px;
    text-align: center;
    cursor: pointer;
  }
  .rm-chev:hover { color: #e0e0e0; }
  .rm-chev.wt { cursor: default; font-size: 11px; }
  .rm-branch.err { color: #e58520; }
  .rm-note {
    padding: 0 10px 6px 6px;
    max-width: 520px;
    color: #949494;
    font-size: 11px;
    line-height: 1.45;
  }
  .rm-fix {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin-top: 4px;
    padding: 4px 6px;
    border: 1px solid #505050;
    background: #1e1e1e;
    color: #c5c8c6;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rm-fix:hover { border-color: #e58520; }
  .rm-fix { align-items: flex-start; }
  /* Wrapped rather than scrolled. The whole point of this box is a command
     that can be read and copied, and a horizontal scrollbar in a menu this
     narrow hides the half of it that says which repository to run it in. */
  .rm-fix code {
    flex: 1 1 auto;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .rm-copy {
    flex: 0 0 auto;
    color: #949494;
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .rm-sep {
    height: 1px;
    margin: 4px 0;
    background: #505050;
  }
  .rm-row.action { color: #949494; }
  .rm-empty {
    padding: 8px 10px;
    color: #949494;
    font-size: 12px;
  }

  /* Bottom-right, gone in a few seconds. Loud enough that nobody wonders why
     an error became a branch; quiet enough that it is not a dialog about a
     thing that cannot go wrong. Bottom-left would lay it across the picker
     menu's lowest rows — "Scan again" among them — and eat the click. */
  .sb-toast {
    position: fixed;
    right: 10px;
    bottom: 30px;
    z-index: 42;
    max-width: 340px;
    padding: 6px 10px;
    background: #272727;
    border: 1px solid #505050;
    border-left: 3px solid #e58520;
    box-shadow: 0 -4px 14px rgba(0, 0, 0, 0.4);
    color: #c5c8c6;
    font-size: 12px;
    cursor: default;
  }

  .sb-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  /* Anchored to the bottom-left rather than to the button: the bar is 22px
     tall, so a menu positioned relative to it would need an escape hatch out
     of the flex row anyway. */
  .repo-menu {
    position: fixed;
    left: 0;
    bottom: 22px;
    z-index: 41;
    min-width: 240px;
    max-width: min(520px, 90vw);
    max-height: 50vh;
    overflow-y: auto;
    background: #272727;
    border: 1px solid #505050;
    box-shadow: 0 -4px 14px rgba(0, 0, 0, 0.4);
  }
  .rm-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 10px 5px 4px;
    border: 0;
    background: transparent;
    color: #c5c8c6;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .rm-row:hover { background: #3a3a3a; }
  .rm-row.on { color: #e58520; }
  .rm-path {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rm-branch {
    flex: 0 0 auto;
    color: #949494;
    font-size: 11px;
  }
</style>
