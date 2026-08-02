<script lang="ts">
  import { untrack } from 'svelte';
  import CodeTab from './CodeTab.svelte';

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

  // Both panes and the result editor follow the selected conflict, so moving
  // through them never means hunting for the matching region by eye.
  $effect(() => {
    void current;
    void spans;
    const r = root;
    if (!r) return;
    queueMicrotask(() => {
      for (const el of r.querySelectorAll('.hit')) el.scrollIntoView({ block: 'center' });
    });
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
  function accept(pick: 'ours' | 'theirs' | 'both' | 'base') {
    const c = active;
    if (!c) return;
    const text =
      pick === 'ours' ? c.ours :
      pick === 'theirs' ? c.theirs :
      pick === 'both' ? c.ours + c.theirs :
      (c.base ?? '');
    result = result.slice(0, c.start) + text + result.slice(c.end);
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
      notice = 'Marked resolved and staged.';
      window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet pane(title: string, label: string, text: string | null, span: [number, number] | null, pick: 'ours' | 'theirs' | 'base' | null)}
  <div class="pane">
    <div class="pane-head">
      <span class="pane-title">{title}</span>
      <span class="pane-label" title={label}>{label}</span>
      {#if pick}
        <button type="button" class="btn" disabled={!active} onclick={() => accept(pick)} title="Replace the selected conflict with this version">Accept</button>
      {/if}
    </div>
    {#if text === null}
      <div class="pane-empty">not present in this version</div>
    {:else}
      <pre class="pane-body">{#if span}{text.slice(0, span[0])}<mark class="hit">{text.slice(span[0], span[1])}</mark>{text.slice(span[1])}{:else}{text}{/if}</pre>
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
      <button type="button" class="btn" onclick={() => accept('both')} title="Keep both versions, current first">Accept both</button>
    {:else if !loading}
      <span class="counter clean">No conflicts remain</span>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="btn" disabled={busy || !dirty} onclick={() => void save()}>{dirty ? 'Save' : 'Saved'}</button>
    <button type="button" class="btn primary" disabled={busy} onclick={() => void complete()} title="Save and stage, which is what clears the conflict in git">Mark resolved</button>
  </div>
  {#if error}<div class="banner err">{error}</div>{/if}
  {#if notice}<div class="banner">{notice}</div>{/if}
  {#if loading}
    <div class="banner">Loading…</div>
  {:else}
    <div class="panes">
      {@render pane('Current', active?.oursLabel ?? 'in this branch', ours, spans.ours, 'ours')}
      <!-- The ancestor is always shown — seeing what the line started as is
           most of why this view exists — but it can only be accepted when the
           markers carry an ancestor section to accept, which is to say when
           the file was written in the diff3 conflict style. Offering the
           button otherwise would splice in nothing and read as a delete. -->
      {@render pane('Base', 'common ancestor', base, spans.base, active?.base ? 'base' : null)}
      {@render pane('Incoming', active?.theirsLabel ?? 'being merged in', theirs, spans.theirs, 'theirs')}
    </div>
    <div class="result">
      <div class="pane-head">
        <span class="pane-title">Result</span>
        <span class="pane-label">working copy — edit freely</span>
      </div>
      <div class="result-editor">
        <CodeTab bind:value={result} filename={leaf} gitPath="" {reveal} />
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
  .pane-body {
    flex: 1 1 0;
    min-height: 0;
    margin: 0;
    padding: 4px 6px;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.4;
  }
  .pane-empty {
    flex: 1 1 0;
    padding: 8px;
    color: #949494;
  }
  .hit {
    background: rgba(229, 133, 32, 0.22);
    color: inherit;
    outline: 1px solid rgba(229, 133, 32, 0.6);
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
