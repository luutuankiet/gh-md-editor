<script lang="ts">
  import { tick } from 'svelte';
  import { fileIconUrl, folderIconUrl } from '../../lib/file-icons';
  import { fuzzyMatch, highlightSegments } from '../../lib/quickopen';

  let { path, folder = '', onOpen }: {
    path: string;
    folder?: string;
    onOpen: (path: string, opts: { pinned: boolean }) => void;
  } = $props();

  type EntryType = 'dir' | 'file' | 'link';
  interface Entry {
    name: string;
    type: EntryType;
  }

  // Segments are shown relative to the anchored workspace, the same way the
  // tab strip shows its subtext, but every path handed to the API or to
  // onOpen is rebuilt with the anchor prefix.
  const rel = $derived(folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path);
  const parts = $derived(rel.split('/').filter(Boolean));

  // The popover: which crumb it hangs off, where it sits, what it lists.
  let at = $state<{ x: number; y: number; index: number } | null>(null);
  let dir = $state('');
  let entries = $state<Entry[]>([]);
  let error = $state('');
  let loading = $state(false);
  let term = $state('');
  let cursor = $state(0);
  let barEl = $state<HTMLDivElement | undefined>(undefined);
  let popEl = $state<HTMLDivElement | undefined>(undefined);
  let listEl = $state<HTMLDivElement | undefined>(undefined);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

  function joinPath(base: string, name: string): string {
    return base ? `${base}/${name}` : name;
  }

  function crumbParent(i: number): string {
    return joinPath(folder, parts.slice(0, i).join('/'));
  }

  const shown = $derived(term ? entries.filter((e) => fuzzyMatch(e.name, term)) : entries);

  // Same endpoint the tree lazy-loads children from: already sorted dirs-first
  // then by name, so the popover needs no ordering of its own.
  async function list(target: string) {
    dir = target;
    loading = true;
    error = '';
    cursor = 0;
    try {
      const res = await fetch(`/api/tree?path=${encodeURIComponent(target || '.')}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      entries = (data.entries ?? []) as Entry[];
    } catch (e) {
      entries = [];
      error = String((e as Error)?.message ?? e);
    } finally {
      loading = false;
    }
  }

  async function toggle(e: MouseEvent, i: number) {
    if (at?.index === i) {
      at = null;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    at = { x: r.left, y: r.bottom + 4, index: i };
    term = '';
    entries = [];
    await list(crumbParent(i));
    // Land on the crumb's own entry, so Enter re-opens what is already open
    // and the arrows step away from a familiar place.
    const self = parts[i];
    const k = shown.findIndex((en) => en.name === self);
    cursor = k < 0 ? 0 : k;
    await tick();
    inputEl?.focus();
    void revealCursor();
  }

  function activate(en: Entry) {
    const full = joinPath(dir, en.name);
    if (en.type === 'dir') {
      // Folders drill in place rather than closing — the popover becomes a
      // small browser rooted wherever the crumb pointed.
      term = '';
      void list(full);
      return;
    }
    at = null;
    onOpen(full, { pinned: false });
  }

  async function revealCursor() {
    await tick();
    listEl?.querySelector<HTMLElement>('.row.on')?.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      at = null;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(cursor + 1, shown.length - 1);
      void revealCursor();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      void revealCursor();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const en = shown[cursor];
      if (en) activate(en);
      return;
    }
    if (e.key === 'Backspace' && !term && dir !== folder && dir.includes('/')) {
      // Backspace on an empty filter walks up one folder, never past the anchor.
      e.preventDefault();
      void list(dir.slice(0, dir.lastIndexOf('/')));
    }
  }

  // Clicks inside the bar are handled by the crumbs themselves (so the same
  // crumb toggles); anything else outside the popover dismisses it.
  $effect(() => {
    if (!at) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (popEl?.contains(t) || barEl?.contains(t)) return;
      at = null;
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  });

  // Switching tabs must not leave a popover pointing at the old path.
  $effect(() => {
    void path;
    at = null;
  });
</script>

{#if parts.length}
  <div class="crumbs" bind:this={barEl}>
    {#each parts as part, i (i)}
      {#if i > 0}<span class="sep">›</span>{/if}
      <button
        type="button"
        class="crumb"
        class:on={at?.index === i}
        title={joinPath(folder, parts.slice(0, i + 1).join('/'))}
        onclick={(e) => void toggle(e, i)}
      >
        <img
          class="ci"
          alt=""
          aria-hidden="true"
          src={i === parts.length - 1 ? fileIconUrl(part) : folderIconUrl(part, false)}
        />
        <span class="ct">{part}</span>
      </button>
    {/each}
  </div>
{/if}

{#if at}
  {@const ai = at.index}
  <div class="pop" bind:this={popEl} style="left: {at.x}px; top: {at.y}px">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="filter"
      bind:this={inputEl}
      bind:value={term}
      placeholder={dir || 'workspace root'}
      spellcheck="false"
      autocomplete="off"
      onkeydown={onKeydown}
    />
    <div class="list" bind:this={listEl}>
      {#if loading}
        <div class="msg">Loading…</div>
      {:else if error}
        <div class="msg err">{error}</div>
      {:else if !shown.length}
        <div class="msg">No matches</div>
      {:else}
        {#each shown as en, i (en.name)}
          <button
            type="button"
            class="row"
            class:on={i === cursor}
            class:cur={dir === crumbParent(ai) && en.name === parts[ai]}
            onclick={() => activate(en)}
            onmousemove={() => { cursor = i; }}
          >
            <img
              class="ri"
              alt=""
              aria-hidden="true"
              src={en.type === 'dir' ? folderIconUrl(en.name, false) : fileIconUrl(en.name)}
            />
            <span class="rn">
              {#each highlightSegments(en.name, term) as seg}<span class:hit={seg.hit}>{seg.text}</span>{/each}
            </span>
            {#if en.type === 'dir'}<span class="chev">›</span>{/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .crumbs {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    overflow: hidden;
    gap: 1px;
    padding: 2px 8px;
    background: #1e1e1e;
    border-bottom: 1px solid #2d2d2d;
    font-size: 11px;
    color: #9aa0a6;
    flex: 0 0 auto;
  }
  .sep {
    color: #6d6d6d;
    padding: 0 1px;
  }
  .crumb {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .crumb:hover { color: #c5c8c6; background: rgba(255, 255, 255, 0.06); }
  .crumb.on { color: #c5c8c6; background: rgba(255, 255, 255, 0.1); }
  .ci { width: 13px; height: 13px; flex: 0 0 auto; }
  .ct { overflow: hidden; text-overflow: ellipsis; }

  .pop {
    position: fixed;
    z-index: 60;
    width: 340px;
    max-width: calc(100vw - 24px);
    display: flex;
    flex-direction: column;
    background: #232323;
    border: 1px solid #505050;
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }
  .filter {
    border: 0;
    border-bottom: 1px solid #404040;
    background: #1e1e1e;
    color: #c5c8c6;
    font: inherit;
    font-size: 12px;
    padding: 6px 8px;
    outline: none;
  }
  .filter:focus { border-bottom-color: #e58520; }
  .list {
    max-height: 320px;
    overflow-y: auto;
    padding: 4px 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 8px;
    border: 0;
    background: transparent;
    color: #c5c8c6;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .row.on { background: rgba(255, 255, 255, 0.1); }
  .row.cur { color: #e58520; }
  .ri { width: 15px; height: 15px; flex: 0 0 auto; }
  .rn { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rn .hit { color: #e58520; }
  .chev { color: #6d6d6d; }
  .msg { padding: 8px; font-size: 12px; color: #9aa0a6; }
  .msg.err { color: #e06c75; }
</style>
