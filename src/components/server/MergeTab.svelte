<script lang="ts">
  import { untrack } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import CodeTab from './CodeTab.svelte';
  import MergePane from './MergePane.svelte';
  import type { PaneAction } from './MergePane.svelte';

  let { repo, path }: { repo: string; path: string } = $props();

  // Git reports paths relative to its own checkout; the file and show
  // endpoints are anchored at the workspace root.
  const full = $derived(repo && repo !== '.' ? `${repo}/${path}` : path);

  interface Conflict {
    // Offsets into the result document, marker lines included, so accepting a
    // side is one splice that takes the markers with it.
    start: number;
    end: number;
    // Each side already ends in a newline when it has content, so the splice
    // never has to reason about line endings.
    ours: string;
    theirs: string;
    // Only present when the file was written with the diff3 conflict style;
    // the merge is still resolvable without it, just with less context.
    base: string | null;
    oursLabel: string;
    theirsLabel: string;
  }

  let base = $state<string | null>(null);
  let ours = $state<string | null>(null);
  let theirs = $state<string | null>(null);
  let result = $state('');
  let saved = $state('');
  let mtimeMs = 0;
  let error = $state('');
  let notice = $state('');
  let loading = $state(true);
  let current = $state(0);
  let busy = $state(false);
  let root = $state<HTMLDivElement | null>(null);
  let revealSeq = 0;
  let reveal = $state<{ line: number; seq: number } | null>(null);

  // One switch for all four panes. Its own storage key: the code editor's
  // Alt+Z setting is per-editor and this view overrides it for its own panes,
  // which would otherwise mean toggling wrap in four places.
  const WRAP_KEY = 'ghmd.mergeWrap';
  let wrap = $state(false);
  try { wrap = localStorage.getItem(WRAP_KEY) === 'on'; } catch { /* noop */ }
  function setWrap(on: boolean) {
    wrap = on;
    try { localStorage.setItem(WRAP_KEY, on ? 'on' : 'off'); } catch { /* noop */ }
  }

  const dirty = $derived(result !== saved);
  const leaf = $derived(path.slice(path.lastIndexOf('/') + 1));

  // The three sides come from git's index rather than from the markers in the
  // file: the markers only carry the conflicting regions, and the whole point
  // of this view is to see each version entire.
  async function showStage(stage: number): Promise<string | null> {
    const r = await fetch(`/api/git/show?path=${encodeURIComponent(full)}&stage=${stage}`);
    const d = await r.json();
    if (!r.ok || !d.tracked || d.binary) return null;
    return d.content as string;
  }

  async function load() {
    loading = true;
    error = '';
    notice = '';
    try {
      const [b, o, t, f] = await Promise.all([
        showStage(1),
        showStage(2),
        showStage(3),
        fetch(`/api/file?path=${encodeURIComponent(full)}`).then((r) => r.json()),
      ]);
      base = b;
      ours = o;
      theirs = t;
      if (f.binary) { error = 'This file is binary.'; return; }
      if (typeof f.content !== 'string') { error = f.error ?? 'cannot read the working copy'; return; }
      result = f.content;
      saved = f.content;
      mtimeMs = f.mtimeMs ?? 0;
      // Staging the file removes its stage entries, so an already-resolved
      // file lands here with no sides to compare. Say so rather than showing
      // three empty panes.
      if (o === null && t === null) notice = 'This file is not in a merge conflict. The working copy is shown below.';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Reads of `full` inside load() are deliberately untracked: the effect must
  // depend on the path alone, never on the state load() writes.
  $effect(() => {
    void full;
    untrack(() => { void load(); });
  });

  // Reparsed from the document on every keystroke rather than tracked as
  // positions, so hand-editing the markers can never desynchronise the list
  // from what is actually in the buffer.
  function parseConflicts(text: string): Conflict[] {
    const out: Conflict[] = [];
    let off = 0;
    let start = -1;
    let oursLines: string[] = [];
    let baseLines: string[] | null = null;
    let theirsLines: string[] = [];
    let oursLabel = '';
    let side: 'ours' | 'base' | 'theirs' | null = null;
    for (const line of text.split('\n')) {
      const len = line.length + 1;
      if (line.startsWith('<<<<<<<')) {
        start = off;
        oursLines = [];
        baseLines = null;
        theirsLines = [];
        oursLabel = line.slice(7).trim();
        side = 'ours';
      } else if (side && line.startsWith('|||||||')) {
        baseLines = [];
        side = 'base';
      } else if (side && line.startsWith('=======')) {
        side = 'theirs';
      } else if (side && line.startsWith('>>>>>>>')) {
        const join = (ls: string[]) => (ls.length ? `${ls.join('\n')}\n` : '');
        out.push({
          start,
          // Clamped: a conflict that ends the file has no newline after its
          // closing marker.
          end: Math.min(text.length, off + len),
          ours: join(oursLines),
          theirs: join(theirsLines),
          base: baseLines === null ? null : join(baseLines),
          oursLabel: oursLabel || 'current',
          theirsLabel: line.slice(7).trim() || 'incoming',
        });
        side = null;
      } else if (side === 'ours') oursLines.push(line);
      else if (side === 'base' && baseLines) baseLines.push(line);
      else if (side === 'theirs') theirsLines.push(line);
      off += len;
    }
    return out;
  }

  const conflicts = $derived(parseConflicts(result));
  const active = $derived(conflicts[current] ?? null);

  // Tints every conflict still in the buffer, brightest on the selected one,
  // so the result reads as a list of outstanding work rather than as a wall of
  // angle brackets.
  const marks = $derived(conflicts.map((c, i) => ({
    from: c.start,
    to: c.end,
    cls: i === current ? 'cm-conflictBlockActive' : 'cm-conflictBlock',
  })));

  // Resolving the last conflict must not leave the counter pointing past the
  // end. `current` is written but never tracked here — tracking it would make
  // the effect reschedule itself.
  $effect(() => {
    const n = conflicts.length;
    untrack(() => { if (current > 0 && current >= n) current = Math.max(0, n - 1); });
  });

  // Where a conflicting region sits inside a full side. The text came out of
  // that side verbatim, so an exact search is enough — and searching forward
  // from the previous conflict keeps repeated lines matching in order.
  function locate(doc: string | null, needle: string, from: number): [number, number] | null {
    if (!doc || !needle) return null;
    let i = doc.indexOf(needle, from);
    if (i < 0) i = doc.indexOf(needle);
    return i < 0 ? null : [i, i + needle.length];
  }

  const spans = $derived.by(() => {
    const c = active;
    if (!c) return { ours: null, theirs: null, base: null };
    let po = 0;
    let pt = 0;
    let pb = 0;
    for (let i = 0; i < current; i++) {
      const a = locate(ours, conflicts[i].ours, po);
      if (a) po = a[1];
      const b = locate(theirs, conflicts[i].theirs, pt);
      if (b) pt = b[1];
      const d = locate(base, conflicts[i].base ?? '', pb);
      if (d) pb = d[1];
    }
    return {
      ours: locate(ours, c.ours, po),
      theirs: locate(theirs, c.theirs, pt),
      base: locate(base, c.base ?? '', pb),
    };
  });

  function go(delta: number) {
    if (!conflicts.length) return;
    current = (current + delta + conflicts.length) % conflicts.length;
    show(current);
  }

  function show(i: number) {
    const c = conflicts[i];
    if (!c) return;
    let line = 1;
    for (let k = 0; k < c.start; k++) if (result[k] === '\n') line++;
    reveal = { line, seq: ++revealSeq };
  }

  // An ordinary edit to the buffer, which is what makes every accept undoable
  // with the editor's own history and saved by the same button as a hand edit.
  type Pick = 'ours' | 'theirs' | 'both' | 'both-theirs' | 'base';

  function replacement(c: Conflict, pick: Pick): string {
    if (pick === 'ours') return c.ours;
    if (pick === 'theirs') return c.theirs;
    if (pick === 'both') return c.ours + c.theirs;
    if (pick === 'both-theirs') return c.theirs + c.ours;
    return c.base ?? '';
  }

  function accept(pick: Pick) {
    const c = active;
    if (!c) return;
    result = result.slice(0, c.start) + replacement(c, pick) + result.slice(c.end);
  }

  // Back to front so that each splice leaves the offsets of the conflicts
  // still to come untouched.
  function acceptAll(pick: Pick) {
    const cs = conflicts;
    if (!cs.length) return;
    let next = result;
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      next = next.slice(0, c.start) + replacement(c, pick) + next.slice(c.end);
    }
    result = next;
    current = 0;
  }

  // Accepting neither side means the region goes back to what both branches
  // started from, which is only knowable when the markers carry an ancestor
  // section — that is, when the file was written in the diff3 conflict style.
  const canIgnore = $derived(active?.base !== null && active?.base !== undefined);
  const IGNORE_TITLE = 'Take neither change: restore this region to the common ancestor';
  const IGNORE_BLOCKED = 'Needs the diff3 conflict style — these markers carry no common ancestor to restore';

  const currentActions = $derived.by<PaneAction[]>(() => (active ? [
    { label: 'Accept Current', title: 'Replace this conflict with the version from this branch', run: () => accept('ours') },
    { label: 'Accept Combination (Current First)', title: 'Keep both versions, this branch first', run: () => accept('both') },
    { label: 'Ignore', title: canIgnore ? IGNORE_TITLE : IGNORE_BLOCKED, run: () => accept('base'), disabled: !canIgnore },
  ] : []));

  const incomingActions = $derived.by<PaneAction[]>(() => (active ? [
    { label: 'Accept Incoming', title: 'Replace this conflict with the version being merged in', run: () => accept('theirs') },
    { label: 'Accept Combination (Incoming First)', title: 'Keep both versions, incoming first', run: () => accept('both-theirs') },
    { label: 'Ignore', title: canIgnore ? IGNORE_TITLE : IGNORE_BLOCKED, run: () => accept('base'), disabled: !canIgnore },
  ] : []));

  const baseActions = $derived.by<PaneAction[]>(() => (active?.base ? [
    { label: 'Accept Base', title: 'Replace this conflict with the common ancestor, discarding both changes', run: () => accept('base') },
  ] : []));

  // Lockstep scrolling across the reference panes and the result. The three
  // sides are different lengths, so this matches by fraction rather than by
  // line: exact alignment is not on offer, but keeping four panes roughly in
  // the same neighbourhood is most of the value.
  const paneViews = new Map<string, EditorView>();
  let syncing = false;

  // Keyed by slot rather than collected in a set: a side can unmount on its
  // own when it turns out not to exist in that version, and a set would have
  // to guess which entry that was.
  function registerPane(v: EditorView | null, slot: 'ours' | 'base' | 'theirs') {
    if (v) paneViews.set(slot, v);
    else paneViews.delete(slot);
  }

  function resultScroller(): HTMLElement | null {
    return root?.querySelector('.result-editor .cm-scroller') ?? null;
  }

  function mirror(el: HTMLElement, frac: number, left: number) {
    const span = el.scrollHeight - el.clientHeight;
    el.scrollTop = span > 0 ? frac * span : 0;
    el.scrollLeft = left;
  }

  function syncFrom(src: EditorView) {
    if (syncing) return;
    syncing = true;
    const s = src.scrollDOM;
    const span = s.scrollHeight - s.clientHeight;
    const frac = span > 0 ? s.scrollTop / span : 0;
    for (const v of paneViews.values()) {
      if (v !== src) mirror(v.scrollDOM, frac, s.scrollLeft);
    }
    const rs = resultScroller();
    if (rs) mirror(rs, frac, s.scrollLeft);
    // Released on the next frame: the mirrored writes fire their own scroll
    // events, and without the guard the panes would drive each other forever.
    requestAnimationFrame(() => { syncing = false; });
  }

  async function save(): Promise<boolean> {
    busy = true;
    try {
      const r = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: full, content: result, baseMtimeMs: mtimeMs }),
      });
      const d = await r.json();
      if (!r.ok) {
        error = d.conflict ? 'This file changed on disk while it was open here. Reopen it before saving.' : (d.error ?? `HTTP ${r.status}`);
        return false;
      }
      mtimeMs = d.mtimeMs;
      saved = result;
      error = '';
      window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy = false;
    }
  }

  // Staging is what actually clears the conflict as far as git is concerned:
  // it collapses the three index entries into one.
  async function complete() {
    if (conflicts.length && !window.confirm(`${conflicts.length} conflict${conflicts.length > 1 ? 's are' : ' is'} still marked in this file. Mark it resolved anyway?`)) return;
    if (!(await save())) return;
    busy = true;
    try {
      const r = await fetch('/api/git/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, op: 'stage', paths: [path] }),
      });
      const d = await r.json();
      if (!r.ok) { error = d.error ?? `HTTP ${r.status}`; return; }
      notice = 'Resolved and staged. Finish the merge from the Source Control panel.';
      window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet pane(title: string, label: string, text: string | null, span: [number, number] | null, actions: PaneAction[], slot: 'ours' | 'base' | 'theirs')}
  <div class="pane">
    <div class="pane-head">
      <span class="pane-title">{title}</span>
      <span class="pane-label" title={label}>{label}</span>
    </div>
    {#if text === null}
      <div class="pane-empty">not present in this version</div>
    {:else}
      <MergePane
        {text}
        filename={leaf}
        {span}
        {wrap}
        {actions}
        reveal={current}
        onview={(v) => registerPane(v, slot)}
        onscroll={syncFrom}
      />
    {/if}
  </div>
{/snippet}

<div class="merge" bind:this={root}>
  <div class="bar">
    <span class="file" title={full}>{leaf}</span>
    {#if conflicts.length}
      <span class="counter">Conflict {current + 1} of {conflicts.length}</span>
      <button type="button" class="btn" onclick={() => go(-1)} title="Previous conflict">↑</button>
      <button type="button" class="btn" onclick={() => go(1)} title="Next conflict">↓</button>
      <button type="button" class="btn" onclick={() => acceptAll('ours')} title="Resolve every remaining conflict with this branch's version">All current</button>
      <button type="button" class="btn" onclick={() => acceptAll('theirs')} title="Resolve every remaining conflict with the incoming version">All incoming</button>
    {:else if !loading}
      <span class="counter clean">No conflicts remain</span>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="btn" class:on={wrap} onclick={() => setWrap(!wrap)} title="Word wrap in every pane">Wrap</button>
    <button type="button" class="btn" disabled={busy || !dirty} onclick={() => void save()}>{dirty ? 'Save' : 'Saved'}</button>
    <button type="button" class="btn primary" disabled={busy} onclick={() => void complete()} title="Save and stage, which is what clears the conflict in git">Complete Merge</button>
  </div>
  {#if error}<div class="banner err">{error}</div>{/if}
  {#if notice}<div class="banner">{notice}</div>{/if}
  {#if loading}
    <div class="banner">Loading…</div>
  {:else}
    <div class="panes">
      {@render pane('Current', active?.oursLabel ?? 'in this branch', ours, spans.ours, currentActions, 'ours')}
      <!-- The ancestor is always shown — seeing what the line started as is
           most of why this view exists — but it can only be accepted when the
           markers carry an ancestor section to accept, which is to say when
           the file was written in the diff3 conflict style. Offering the
           button otherwise would splice in nothing and read as a delete. -->
      {@render pane('Base', 'common ancestor', base, spans.base, baseActions, 'base')}
      {@render pane('Incoming', active?.theirsLabel ?? 'being merged in', theirs, spans.theirs, incomingActions, 'theirs')}
    </div>
    <div class="result">
      <div class="pane-head">
        <span class="pane-title">Result</span>
        <span class="pane-label">working copy — edit freely</span>
      </div>
      <div class="result-editor">
        <CodeTab bind:value={result} filename={leaf} gitPath="" {reveal} {wrap} {marks} />
      </div>
    </div>
  {/if}
</div>

<style>
  .merge {
    /* The tab body is a block container, so a flex grow factor here would be
       ignored and the whole view would size to its own content. */
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    font-size: 12px;
    color: #c5c8c6;
  }
  .bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #272727;
    border-bottom: 1px solid #404040;
  }
  .file { font-weight: 600; }
  .counter { color: #949494; }
  .counter.clean { color: #81c995; }
  .spacer { flex: 1 1 auto; }
  .btn {
    font: inherit;
    padding: 1px 8px;
    border-radius: 3px;
    border: 1px solid #505050;
    background: #2d2d2d;
    color: #c5c8c6;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: #3a3a3a; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.primary { border-color: #e58520; }
  .btn.on { border-color: #e58520; color: #e58520; }
  .banner {
    flex: 0 0 auto;
    padding: 3px 8px;
    background: #232323;
    border-bottom: 1px solid #404040;
    color: #949494;
  }
  .banner.err { color: #f28b82; }
  .panes {
    flex: 0 0 38%;
    min-height: 0;
    display: flex;
    gap: 1px;
    background: #404040;
  }
  .pane {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
  }
  .pane-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    background: #272727;
    border-bottom: 1px solid #404040;
  }
  .pane-title { font-weight: 600; }
  .pane-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #949494;
  }
  .pane-empty {
    flex: 1 1 0;
    padding: 8px;
    color: #949494;
  }
  .result {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .result-editor {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
  }
</style>
