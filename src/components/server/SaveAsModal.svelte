<script lang="ts">
  import { fileIconUrl, folderIconUrl } from '../../lib/file-icons';

  // VS Code-style Save As: one path input + a live directory listing that
  // follows the folder part of what you type. Clicking a folder descends
  // (updating the input), `..` ascends, and typing filters the listing by the
  // trailing segment. Paths are DISPLAYED absolute (like VS Code) but the
  // server API speaks workspace-relative — the translation lives here.
  let { root, folder, initialName, onCancel, onSave }: {
    root: { root: string; sep: string } | null;
    folder: string;
    initialName: string;
    onCancel: () => void;
    onSave: (relPath: string) => void;
  } = $props();

  const sep = root?.sep ?? '/';
  const prefix = root ? root.root + sep : '';

  let value = $state(
    prefix + (folder ? folder.split('/').join(sep) + sep : '') + initialName
  );
  let input: HTMLInputElement | null = null;
  let entries = $state<{ name: string; type: string }[]>([]);
  let listError = $state('');
  let listSeq = 0;
  let lastDir: string | null = null;

  // Split the typed value into the folder being listed and the name filter.
  function parts() {
    let v = value;
    if (prefix && v.startsWith(prefix)) v = v.slice(prefix.length);
    else if (root && v.startsWith(root.root)) v = v.slice(root.root.length).replace(/^[/\\]/, '');
    const norm = v.split(sep).join('/');
    const i = norm.lastIndexOf('/');
    return { dir: i >= 0 ? norm.slice(0, i) : '', name: i >= 0 ? norm.slice(i + 1) : norm };
  }

  $effect(() => {
    const { dir } = parts();
    if (dir === lastDir) return; // typing the filename must not refetch
    lastDir = dir;
    const seq = ++listSeq;
    fetch(`/api/tree?path=${encodeURIComponent(dir || '.')}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (seq !== listSeq) return;
        if (!ok) { entries = []; listError = d.error ?? 'cannot list folder'; return; }
        listError = '';
        entries = d.entries ?? [];
      })
      .catch(() => { if (seq === listSeq) { entries = []; listError = 'cannot list folder'; } });
  });

  let filtered = $derived.by(() => {
    const { name } = parts();
    const q = name.toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    return list.slice(0, 200);
  });

  function setPath(dir: string, name: string) {
    value = prefix + (dir ? dir.split('/').join(sep) + sep : '') + name;
    input?.focus();
  }

  function clickEntry(e: { name: string; type: string }) {
    const { dir, name } = parts();
    if (e.type === 'dir') setPath(dir ? `${dir}/${e.name}` : e.name, name || initialName);
    else setPath(dir, e.name);
  }

  function goUp() {
    const { dir, name } = parts();
    const i = dir.lastIndexOf('/');
    setPath(i >= 0 ? dir.slice(0, i) : '', name || initialName);
  }

  function commit() {
    const { dir, name } = parts();
    if (!name) return;
    onSave(dir ? `${dir}/${name}` : name);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  }

  // Focus once on mount, selecting just the filename for quick renaming.
  // No reactive reads in here — it must not rerun (and reselect) per keystroke.
  let focusedOnce = false;
  $effect(() => {
    if (focusedOnce || !input) return;
    focusedOnce = true;
    input.focus();
    const v = input.value;
    const i = v.lastIndexOf(sep);
    input.setSelectionRange(i + 1, v.length);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="overlay" role="presentation" onclick={onCancel}>
  <div class="modal" onclick={(e) => e.stopPropagation()}>
    <div class="mtitle">Save As</div>
    <input bind:this={input} class="minput" bind:value onkeydown={onKeydown} spellcheck="false" />
    {#if listError}<div class="merror">{listError}</div>{/if}
    <div class="mlist">
      <button type="button" class="mrow" onclick={goUp}>
        <span class="mup">↰</span>
        <span class="mname">..</span>
      </button>
      {#each filtered as e (e.name)}
        <button type="button" class="mrow" onclick={() => clickEntry(e)}>
          <img class="micon" alt="" aria-hidden="true" src={e.type === 'dir' ? folderIconUrl(e.name, false) : fileIconUrl(e.name)} />
          <span class="mname" class:dir={e.type === 'dir'}>{e.name}</span>
        </button>
      {/each}
    </div>
    <div class="mactions">
      <button type="button" class="mbtn" onclick={onCancel}>Cancel</button>
      <button type="button" class="mbtn primary" onclick={commit}>OK</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(1, 4, 9, 0.6);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
  }
  .modal {
    width: min(560px, 90vw);
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(1, 4, 9, 0.9);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .mtitle {
    padding: 8px 12px 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8b949e;
  }
  .minput {
    margin: 4px 10px;
    padding: 5px 10px;
    background: #010409;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
  }
  .minput:focus { outline: none; border-color: #58a6ff; }
  .merror {
    padding: 2px 14px;
    color: #ff7b72;
    font-size: 12px;
  }
  .mlist {
    max-height: 300px;
    overflow-y: auto;
    padding: 4px 6px;
  }
  .mrow {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: #c9d1d9;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    text-align: left;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .mrow:hover { background: rgba(56, 139, 253, 0.15); }
  .micon { width: 16px; height: 16px; flex: 0 0 16px; }
  .mup {
    width: 16px;
    flex: 0 0 16px;
    text-align: center;
    color: #8b949e;
  }
  .mname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mname.dir { font-weight: 600; }
  .mactions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid #30363d;
  }
  .mbtn {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 4px 14px;
    font-size: 12px;
    cursor: pointer;
  }
  .mbtn:hover { border-color: #58a6ff; }
  .mbtn.primary {
    background: #238636;
    border-color: #2ea043;
    color: #fff;
  }
</style>
