<script lang="ts">
  import { fileIconUrl, folderIconUrl } from '../../lib/file-icons';

  // VS Code's remote Open Folder dialog: one absolute path input, a listing
  // that follows the directory part of it, and a hard split between
  // navigating (clicks, arrow keys, Enter on a row) and committing (Enter
  // while the input owns the caret, or the Open button). Only the commit
  // path ever closes the dialog with a result.
  let { mode, title, start, onCancel, onPick }: {
    mode: 'workspace' | 'file';
    title: string;
    start: string;
    onCancel: () => void;
    onPick: (absPath: string) => void;
  } = $props();

  let sep = $state('/');
  let value = $state(start.endsWith('/') ? start : start + '/');
  let input: HTMLInputElement | null = null;
  let listEl: HTMLDivElement | null = null;
  let entries = $state<{ name: string; type: string }[]>([]);
  let parent = $state<string | null>(null);
  let listError = $state('');
  // -1 = the input owns Enter (commit); 0 = the `..` row; 1.. = entries.
  let sel = $state(-1);
  let listSeq = 0;
  let lastDir: string | null = null;

  // A trailing separator means "list this directory, no name filter yet";
  // anything after the last separator filters the listing as you type.
  function parts(): { dir: string; filter: string } {
    const v = value;
    const i = v.lastIndexOf(sep);
    if (i < 0) return { dir: v, filter: '' };
    return { dir: v.slice(0, i) || sep, filter: v.slice(i + 1) };
  }

  $effect(() => {
    const { dir } = parts();
    if (dir === lastDir) return; // typing the filter must not refetch
    lastDir = dir;
    const seq = ++listSeq;
    fetch(`/api/browse?path=${encodeURIComponent(dir)}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (seq !== listSeq) return;
        if (!ok) { entries = []; parent = null; listError = d.error ?? 'cannot list folder'; return; }
        listError = '';
        sep = d.sep ?? sep;
        parent = d.parent ?? null;
        entries = d.entries ?? [];
      })
      .catch(() => { if (seq === listSeq) { entries = []; listError = 'cannot list folder'; } });
  });

  let filtered = $derived.by(() => {
    const q = parts().filter.toLowerCase();
    let list = mode === 'workspace' ? entries.filter((e) => e.type === 'dir') : entries;
    if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
    return list.slice(0, 400);
  });

  function join(dir: string, name: string): string {
    return dir.endsWith(sep) ? dir + name : dir + sep + name;
  }

  function enterDir(name: string) {
    value = join(parts().dir, name) + sep;
    sel = -1;
    input?.focus();
  }

  function goUp() {
    if (!parent) return;
    value = parent.endsWith(sep) ? parent : parent + sep;
    sel = -1;
    input?.focus();
  }

  function pickRow(e: { name: string; type: string }) {
    if (e.type === 'dir') enterDir(e.name);
    // A file cannot be descended into — its navigation analogue is landing
    // in the input, one Enter (or Open) away from actually opening.
    else { value = join(parts().dir, e.name); sel = -1; input?.focus(); }
  }

  function commit() {
    let p = value.trim();
    if (!p) return;
    if (p.length > sep.length && p.endsWith(sep)) p = p.slice(0, -sep.length);
    onPick(p);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, -1); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // The split the dialog is built around: Enter commits ONLY from the
    // input (sel -1); on a row it navigates and the dialog stays open.
    if (sel === -1) commit();
    else if (sel === 0) goUp();
    else { const row = filtered[sel - 1]; if (row) pickRow(row); }
  }

  // Keep the keyboard selection on screen.
  $effect(() => {
    if (sel < 0 || !listEl) return;
    listEl.querySelector('.wrow.selected')?.scrollIntoView({ block: 'nearest' });
  });

  let focusedOnce = false;
  $effect(() => {
    if (focusedOnce || !input) return;
    focusedOnce = true;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" role="presentation" onclick={onCancel}>
  <div class="modal" onclick={(e) => e.stopPropagation()}>
    <div class="mtitle">{title}</div>
    <div class="mbar">
      <input bind:this={input} class="minput" bind:value onkeydown={onKeydown} oninput={() => { sel = -1; }} spellcheck="false" />
      <button type="button" class="mbtn primary" onclick={commit}>Open</button>
    </div>
    {#if listError}<div class="merror">{listError}</div>{/if}
    <div class="mlist" bind:this={listEl}>
      <button type="button" class="wrow" class:selected={sel === 0} onclick={goUp} disabled={!parent}>
        <span class="mup">↰</span>
        <span class="mname">..</span>
      </button>
      {#each filtered as e (e.name)}
        {@const i = filtered.indexOf(e)}
        <button type="button" class="wrow" class:selected={sel === i + 1} onclick={() => pickRow(e)}>
          <img class="micon" alt="" aria-hidden="true" src={e.type === 'dir' ? folderIconUrl(e.name, false) : fileIconUrl(e.name)} />
          <span class="mname" class:dir={e.type === 'dir'}>{e.name}</span>
        </button>
      {/each}
    </div>
    <div class="mactions">
      <span class="mhint">Enter in the path box opens · Enter on a row navigates</span>
      <button type="button" class="mbtn" onclick={onCancel}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
  }
  .modal {
    width: min(640px, 92vw);
    background: #272727;
    border: 1px solid #404040;
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .mtitle {
    padding: 8px 12px 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #949494;
    text-align: center;
  }
  .mbar {
    display: flex;
    gap: 8px;
    margin: 4px 10px;
    align-items: center;
  }
  .minput {
    flex: 1;
    padding: 5px 10px;
    background: #1e1e1e;
    border: 1px solid #404040;
    border-radius: 6px;
    color: #c5c8c6;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
  }
  .minput:focus { outline: none; border-color: #e58520; }
  .merror {
    padding: 2px 14px;
    color: #ff7b72;
    font-size: 12px;
  }
  .mlist {
    max-height: min(46vh, 420px);
    overflow-y: auto;
    padding: 4px 6px;
  }
  .wrow {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: #c5c8c6;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    text-align: left;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .wrow:hover { background: #444444; }
  .wrow.selected { background: #4e4e4e; }
  .wrow:disabled { opacity: 0.4; cursor: default; }
  .micon { width: 16px; height: 16px; flex: 0 0 16px; }
  .mup {
    width: 16px;
    flex: 0 0 16px;
    text-align: center;
    color: #949494;
  }
  .mname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mname.dir { font-weight: 600; }
  .mactions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid #404040;
  }
  .mhint {
    flex: 1;
    color: #8a8a8a;
    font-size: 11px;
  }
  .mbtn {
    background: #404040;
    color: #c5c8c6;
    border: 1px solid #505050;
    border-radius: 6px;
    padding: 4px 14px;
    font-size: 12px;
    cursor: pointer;
  }
  .mbtn:hover { border-color: #e58520; }
  .mbtn.primary {
    background: #565656;
    border-color: #707070;
    color: #ffffff;
  }
</style>
