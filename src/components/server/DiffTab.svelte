<script lang="ts">
  let { repo = '', path = '', staged = false, untracked = false, compare = null, base = '', baseLabel = '', to = '', toLabel = '' }: {
    repo?: string;
    path?: string;
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
    // arbitrary inputs, no repo, no index side. rightText carries pasted
    // content, which has no path of its own.
    compare?: { leftPath: string; rightPath?: string; rightText?: string; rightLabel: string } | null;
  } = $props();

  import { scopeForFilename, highlightToLines, type Tok } from '../../lib/diff-highlight';

  interface DiffLine { t: '+' | '-' | ' ' | '\\'; n: number | null; o: number | null; text: string }
  interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; section: string; lines: DiffLine[] }

  // What the diff is *about* — drives the header and the grammar pick. A
  // compare has no repo-relative path, so its left input names the tab.
  const subject = $derived(compare ? compare.leftPath : path);

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

  // Side-by-side is the default; the choice persists workspace-wide.
  const DIFFVIEW_KEY = 'ghmd.diffView';
  let view = $state<'split' | 'inline'>(localStorage.getItem(DIFFVIEW_KEY) === 'inline' ? 'inline' : 'split');
  function setView(v: 'split' | 'inline') {
    view = v;
    localStorage.setItem(DIFFVIEW_KEY, v);
  }

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
            body: JSON.stringify(compare),
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

  // Props are read synchronously (qs build) → tracked: a reused tab pointed
  // at another file/side refetches. Writes only — no self-invalidation.
  $effect(() => { void load(); });

  // Live refresh. `gmd:git-refresh` covers mutations made anywhere in this app;
  // `focus` covers everything done outside it — a terminal commit, a revert in
  // another window. Both take the auto path, which no-ops on an unchanged diff.
  $effect(() => {
    const onRefresh = () => { void load(true); };
    window.addEventListener('gmd:git-refresh', onRefresh);
    window.addEventListener('focus', onRefresh);
    return () => {
      window.removeEventListener('gmd:git-refresh', onRefresh);
      window.removeEventListener('focus', onRefresh);
    };
  });

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
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="difftab">
  <div class="diff-head">
    <span class="diff-path" title={subject}>{subject}</span>
    <span class="diff-side">{compare ? `vs ${compare.rightLabel}` : to ? `${toLabel || to.slice(0, 7)} vs ${baseLabel || base.slice(0, 7)}` : base ? `vs ${baseLabel || base.slice(0, 7)}` : staged ? 'staged' : untracked ? 'untracked' : 'working tree'}</span>
    <span class="viewtoggle">
      <button type="button" class:on={view === 'split'} onclick={() => setView('split')}>Split</button>
      <button type="button" class:on={view === 'inline'} onclick={() => setView('inline')}>Inline</button>
    </span>
    <button type="button" class="icon-btn" title="Reload" onclick={() => void load()}>⟳</button>
  </div>
  {#if error}<div class="diff-error">{error}</div>{/if}
  {#if loading}
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
                     side. Pasted text has no file, so no right target then. -->
                <button type="button" onclick={() => void applyCompare(hi, 'left')}>⇤ Apply {sel[hi]?.size ? 'selected' : 'hunk'} to left</button>
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
            <div class="splitwrap">
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
  /* starry-night ships style/both, whose palette flips with
     prefers-color-scheme. The diff chrome is hard-coded dark, so on a
     light-mode OS the tokens came out GitHub-light (near-black text on
     #1e1e1e). Pin the GitHub-dark palette here, scoped to .difftab, so the
     preview pane's code blocks stay system-following. Two classes beat the
     package's single-class rules on specificity, no !important needed. */
  .difftab :global(.pl-c) { color: #949494; font-style: italic; }
  .difftab :global(.pl-k) { color: #ff7b72; }
  .difftab :global(.pl-s),
  .difftab :global(.pl-pds),
  .difftab :global(.pl-s .pl-pse .pl-s1),
  .difftab :global(.pl-sr),
  .difftab :global(.pl-sr .pl-sra),
  .difftab :global(.pl-mq) { color: #a5d6ff; }
  .difftab :global(.pl-sr .pl-cce),
  .difftab :global(.pl-cce),
  .difftab :global(.pl-ent) { color: #7ee787; }
  .difftab :global(.pl-c1),
  .difftab :global(.pl-s .pl-v),
  .difftab :global(.pl-corl) { color: #79c0ff; }
  .difftab :global(.pl-e),
  .difftab :global(.pl-en) { color: #d2a8ff; }
  .difftab :global(.pl-v),
  .difftab :global(.pl-smw) { color: #ffa657; }
  .difftab :global(.pl-smi),
  .difftab :global(.pl-s .pl-s1),
  .difftab :global(.pl-vpf) { color: #c5c8c6; }
  .difftab :global(.pl-bu),
  .difftab :global(.pl-ii) { color: #f85149; }
  .difftab :global(.pl-mh) { color: #3655b5; font-weight: 600; }
  .difftab :global(.pl-ml) { color: #f2cc60; }
  .difftab :global(.pl-mb) { color: #c5c8c6; font-weight: 600; }
  .difftab :global(.pl-mi) { color: #c5c8c6; font-style: italic; }

  .difftab {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    color: #c5c8c6;
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
  .viewtoggle button.on {
    background: #353535;
    color: #c5c8c6;
  }
  /* Each side is its own horizontal scroller, VS Code style. A grid with
     max-content tracks does NOT work here: the tracks can never exceed the
     grid container's width, so long lines just painted across the gutter into
     the other column. Two independent scroll boxes also mean a wide old
     version doesn't drag the new one sideways.
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
