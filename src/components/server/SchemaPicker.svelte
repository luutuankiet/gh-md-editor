<script lang="ts">
  import { currentWorkspace } from '../../lib/lsp-control.svelte';

  // Root-relative path of the active code editor; '' when none.
  let { path }: { path: string } = $props();

  type Entry = { name: string; description?: string; url: string; fileMatch?: string[]; versions?: Record<string, string> };
  type Pick = { url: string; name: string };
  type Item =
    | { kind: 'auto' }
    | { kind: 'custom' }
    | { kind: 'use'; ref: string }
    | { kind: 'recent'; p: Pick }
    | { kind: 'entry'; e: Entry }
    | { kind: 'version'; label: string; url: string; name: string };

  // dbt's profiles.yml is not in the SchemaStore catalog. The server maps this
  // url to a local wrapper, because the upstream file rejects every profile.
  const DBT_PROFILES: Entry = {
    name: 'dbt profiles.yml',
    description: 'dbt connection profiles (dbt-jsonschema)',
    url: 'https://raw.githubusercontent.com/dbt-labs/dbt-jsonschema/main/schemas/latest_fusion/profiles-latest-fusion.json',
    fileMatch: ['profiles.yml', 'profiles.yaml'],
  };
  // dbt-jsonschema keeps one folder per dbt version; the catalog has no versions map for it.
  const DBT_URL = /^(.*\/dbt-jsonschema\/main\/schemas\/)([^/]+)\/([a-z_]+)-[a-z0-9.-]+\.json$/;
  const DBT_VERSIONS = ['1.5', '1.6', '1.7', 'latest', 'latest_fusion'];
  const CATALOG_KEY = 'gmd:schema-catalog';
  const CATALOG_MAX_AGE = 7 * 24 * 3600 * 1000;
  // Schemas typed into the picker (URLs and paths), newest first, per browser.
  const RECENT_KEY = 'gmd:schema-recent';
  const RECENT_MAX = 8;
  // What the input reads as a URL or a path rather than a catalog search.
  const LOOKS_LIKE_REF = /^(https?:\/\/|file:|\/|~\/|\.{1,2}\/|[a-z]:[\\/])|\.(json|ya?ml)$/i;

  let isYaml = $derived(/\.ya?ml$/i.test(path));
  let isSchemaFile = $derived(/\.(ya?ml|jsonc?)$/i.test(path));
  let catalog = $state<Entry[]>([]);
  let picks = $state<Record<string, Pick | string>>({});
  let open = $state(false);
  let step = $state<{ entry: Entry; items: Item[] } | null>(null);
  let query = $state('');
  let active = $state(0);
  let error = $state('');
  let busy = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  // The picker's second mode: the input takes a schema URL or path.
  let entering = $state(false);
  let recent = $state<Pick[]>([]);

  function loadRecent() {
    try {
      const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      recent = Array.isArray(r) ? r.filter((p) => typeof p?.url === 'string' && typeof p?.name === 'string') : [];
    } catch {
      recent = [];
    }
  }

  function remember(p: Pick) {
    recent = [p, ...recent.filter((r) => r.url !== p.url)].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* quota */ }
  }
  const probed = new Map<string, boolean>();

  async function loadCatalog() {
    try {
      const c = JSON.parse(localStorage.getItem(CATALOG_KEY) ?? 'null');
      if (c && Array.isArray(c.schemas)) {
        catalog = c.schemas;
        if (Date.now() - c.at < CATALOG_MAX_AGE) return;
      }
    } catch { /* refetch */ }
    try {
      const r = await fetch('/api/lsp/schema-catalog');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const schemas: Entry[] = (j.schemas ?? []).filter((e: Entry) => typeof e?.url === 'string' && typeof e?.name === 'string');
      catalog = schemas;
      try { localStorage.setItem(CATALOG_KEY, JSON.stringify({ at: Date.now(), schemas })); } catch { /* quota */ }
    } catch (e) {
      if (!catalog.length) error = `Schema catalog unavailable: ${(e as Error).message}`;
    }
  }

  async function loadPicks() {
    try {
      const r = await fetch(`/api/lsp/settings?workspace=${encodeURIComponent(currentWorkspace())}`, { cache: 'no-store' });
      if (r.ok) picks = (await r.json()).shared?.schemas ?? {};
    } catch { /* keep the last picks */ }
  }

  $effect(() => {
    if (isSchemaFile && path) { void loadPicks(); if (!catalog.length) void loadCatalog(); }
  });

  // Settings can change from elsewhere (another picker, a settings edit).
  $effect(() => {
    const on = () => { if (isSchemaFile) void loadPicks(); };
    window.addEventListener('gmd:lsp-changed', on);
    return () => window.removeEventListener('gmd:lsp-changed', on);
  });

  function globRe(g: string): RegExp {
    const body = g.replace(/^\.?\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
      .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
    return new RegExp(`(^|/)${body}$`, 'i');
  }

  function autoMatch(p: string): Entry | null {
    const all = isYaml ? [DBT_PROFILES, ...catalog] : catalog;
    for (const e of all) {
      for (const g of e.fileMatch ?? []) {
        if (typeof g !== 'string' || g.startsWith('!')) continue;
        if (isYaml !== /\.ya?ml$/i.test(g) && !/\*$/.test(g)) continue;
        if (globRe(g).test(p)) return e;
      }
    }
    return null;
  }

  let pick = $derived.by((): Pick | null => {
    const v = picks[path];
    if (!v) return null;
    return typeof v === 'string' ? { url: v, name: v.split('/').pop() ?? v } : v;
  });
  let auto = $derived(isSchemaFile && catalog.length ? autoMatch(path) : null);

  let items = $derived.by((): Item[] => {
    if (step) return step.items;
    if (entering) return query.trim() ? [{ kind: 'use', ref: query.trim() }] : [];
    const q = query.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const mine = recent
      .filter((p) => words.every((w) => `${p.name} ${p.url}`.toLowerCase().includes(w)))
      .map((p): Item => ({ kind: 'recent', p }));
    // A pick that is neither in the catalog nor recent (another browser made it).
    const orphan = pick && !recent.some((r) => r.url === pick!.url) && !catalog.some((e) => e.url === pick!.url) && pick.url !== DBT_PROFILES.url && !q
      ? [{ kind: 'recent', p: pick } as Item]
      : [];
    const pool = isYaml ? [DBT_PROFILES, ...catalog] : catalog;
    const hits = pool
      .filter((e) => {
        const hay = `${e.name} ${e.description ?? ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      // Name matches rank above description-only matches.
      .map((e) => ({ e, rank: words.every((w) => e.name.toLowerCase().includes(w)) ? 0 : 1 }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 200)
      .map(({ e }): Item => ({ kind: 'entry', e }));
    if (q) return [...(LOOKS_LIKE_REF.test(query.trim()) ? [{ kind: 'use', ref: query.trim() } as Item] : []), ...mine, ...hits];
    return [{ kind: 'auto' }, { kind: 'custom' }, ...orphan, ...mine, ...hits];
  });

  function show() {
    open = true;
    step = null;
    entering = false;
    loadRecent();
    query = '';
    error = '';
    active = 0;
    void loadPicks();
    void loadCatalog();
    queueMicrotask(() => input?.focus());
  }

  async function exists(url: string): Promise<boolean> {
    if (!probed.has(url)) {
      try {
        const r = await fetch(url, { method: 'HEAD' });
        probed.set(url, r.ok);
      } catch {
        return true; // offline: list it rather than hide it
      }
    }
    return probed.get(url)!;
  }

  async function openVersions(e: Entry) {
    let list: Item[] = [];
    const m = DBT_URL.exec(e.url);
    if (e.versions && Object.keys(e.versions).length) {
      list = Object.entries(e.versions).map(([v, url]) => ({ kind: 'version', label: v, url, name: `${e.name} (${v})` }));
    } else if (m) {
      busy = true;
      const urls = DBT_VERSIONS.map((v) => `${m[1]}${v}/${m[3]}-${v === 'latest_fusion' ? 'latest-fusion' : v}.json`);
      const ok = await Promise.all(urls.map(exists));
      busy = false;
      list = DBT_VERSIONS.flatMap((v, i): Item[] => (ok[i] ? [{ kind: 'version', label: v, url: urls[i], name: `${e.name} (${v})` }] : []));
    }
    if (list.length <= 1) return save(list[0]?.kind === 'version' ? { url: list[0].url, name: list[0].name } : { url: e.url, name: e.name });
    step = { entry: e, items: list };
    query = '';
    active = Math.max(0, list.findIndex((it) => it.kind === 'version' && it.url === (pick?.url ?? auto?.url)));
    // After the probe the input re-enables on the next render; focus it then.
    setTimeout(() => input?.focus());
  }

  async function save(p: Pick | null) {
    busy = true;
    error = '';
    try {
      const r = await fetch('/api/lsp/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: currentWorkspace(), shared: { schemas: { [path]: p } } }),
      });
      if (!r.ok) {
        error = (await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`;
        return;
      }
      await loadPicks();
      open = false;
      window.dispatchEvent(new CustomEvent('gmd:lsp-changed'));
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  // The server checks the URL or file and turns a path into a file:// URL.
  async function useRef(ref: string) {
    busy = true;
    error = '';
    let p: Pick;
    try {
      const r = await fetch(`/api/lsp/schema-resolve?workspace=${encodeURIComponent(currentWorkspace())}&ref=${encodeURIComponent(ref)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { error = j.error ?? `HTTP ${r.status}`; return; }
      p = { url: j.url, name: j.name };
    } catch (e) {
      error = (e as Error).message;
      return;
    } finally {
      busy = false;
      setTimeout(() => input?.focus());
    }
    remember(p);
    await save(p);
  }

  function choose(it: Item) {
    if (it.kind === 'auto') void save(null);
    else if (it.kind === 'custom') { entering = true; query = ''; active = 0; error = ''; input?.focus(); }
    else if (it.kind === 'use') void useRef(it.ref);
    else if (it.kind === 'recent') { remember(it.p); void save(it.p); }
    else if (it.kind === 'entry') void openVersions(it.e);
    else void save({ url: it.url, name: it.name });
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (step || entering) { step = null; entering = false; query = ''; active = 0; error = ''; } else open = false;
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[active]; if (it) choose(it); }
  }

  $effect(() => {
    void query;
    if (!step) active = Math.min(active, Math.max(0, items.length - 1));
  });

  let statusText = $derived(pick ? pick.name : auto ? auto.name : 'No Schema');
  let statusTitle = $derived(
    pick
      ? `Schema chosen for this file: ${pick.url}`
      : auto
        ? `Matched automatically from SchemaStore: ${auto.url}`
        : 'No JSON schema matches this file; click to choose one',
  );
</script>

{#if isSchemaFile}
  <button type="button" class="seg schema" title={statusTitle} onclick={show}>
    <span class="brace" aria-hidden="true">{'{}'}</span>
    <span>{statusText}</span>
  </button>
{/if}

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onmousedown={() => (open = false)}></div>
  <div class="pick" role="dialog" aria-label="Select JSON schema">
    <input
      bind:this={input}
      bind:value={query}
      onkeydown={onKey}
      placeholder={step
        ? `Select a version of ${step.entry.name}`
        : entering
          ? 'Schema URL, absolute path, or path relative to the workspace'
          : `Select Schema (current: ${statusText})`}
      spellcheck="false"
      autocomplete="off"
      readonly={!!step}
      disabled={busy}
    />
    {#if error}<div class="banner err">{error}</div>{/if}
    {#if entering && !query.trim()}
      <div class="banner hint">https://example.com/schema.json, /abs/path/schema.json, ~/schemas/x.json or schemas/x.json. Enter to use, Esc to go back.</div>
    {/if}
    <div class="list" role="listbox">
      {#each items as it, i (it.kind === 'entry' ? `e:${it.e.url}:${it.e.name}` : it.kind === 'version' ? `v:${it.url}` : it.kind === 'recent' ? `r:${it.p.url}` : it.kind)}
        <button
          type="button"
          role="option"
          aria-selected={i === active}
          class="row"
          class:active={i === active}
          onmousemove={() => (active = i)}
          onclick={() => choose(it)}
        >
          {#if it.kind === 'auto'}
            <span class="mark">{pick ? '' : '✓'}</span>
            <span class="label">Auto (SchemaStore)</span>
            <span class="detail">{auto ? auto.name : 'no match for this file'}</span>
          {:else if it.kind === 'custom'}
            <span class="mark"></span>
            <span class="label">Enter schema URL or path...</span>
            <span class="detail">http(s) URL, absolute path, or relative to the workspace</span>
          {:else if it.kind === 'use'}
            <span class="mark"></span>
            <span class="label">Use</span>
            <span class="detail">{it.ref}</span>
          {:else if it.kind === 'recent'}
            <span class="mark">{pick?.url === it.p.url ? '✓' : ''}</span>
            <span class="label">{it.p.name}</span>
            <span class="detail">{it.p.url.replace(/^file:\/\//, '')}</span>
          {:else if it.kind === 'entry'}
            <span class="mark">{(pick?.url ?? auto?.url) === it.e.url ? '✓' : ''}</span>
            <span class="label">{it.e.name}</span>
            <span class="detail">{it.e.description ?? ''}</span>
          {:else}
            <span class="mark">{(pick?.url ?? auto?.url) === it.url ? '✓' : ''}</span>
            <span class="label">{it.label}</span>
            <span class="detail">{it.url.split('/').pop()}</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
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
    cursor: pointer;
  }
  .seg:hover { background: #3a3a3a; }
  .brace { color: #8a8a8a; font-size: 11px; }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .pick {
    position: fixed;
    top: 40px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 41;
    width: min(640px, 92vw);
    background: #252526;
    border: 1px solid #505050;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pick input {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    border: 1px solid #0e639c;
    background: #3c3c3c;
    color: #e0e0e0;
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .banner {
    padding: 5px 8px;
    font-size: 12px;
  }
  .banner.hint { color: #9a9a9a; }
  .banner.err { color: #e5534b; border-left: 2px solid #e5534b; background: rgba(229, 83, 75, 0.08); }
  .list {
    max-height: 50vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 8px;
    border: 0;
    background: transparent;
    color: #c5c8c6;
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .row.active { background: #04395e; color: #fff; }
  .mark { width: 12px; flex: 0 0 auto; color: #4ec27a; }
  .label { flex: 0 0 auto; }
  .detail {
    flex: 1 1 auto;
    min-width: 0;
    color: #8a8a8a;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
