<script lang="ts">
  // PreviewSearch.svelte — v0.5.0 (v0.6.7: auto-expand <details> on Enter-step;
  // v0.8.1: click-word implicit highlight removed — explicit search only)
  // Cmd+F search overlay for the preview pane, with:
  //   - explicit query highlight (CSS Custom Highlight API)
  //   - scrollbar match indicator ticks (RHS gutter, abs-positioned)
  //   - prev/next navigation, Esc to close
  //   - auto-expand collapsed <details> ancestors of the active match before scroll
  import { expandDetailsAncestors } from '../lib/reveal';

  let {
    host,
    scrollWrap,
    container,
  }: {
    host: HTMLElement | null;
    scrollWrap: HTMLElement | null;
    container: HTMLElement | null;
  } = $props();

  type Match = { range: Range };

  let open = $state(false);
  let query = $state('');
  let currentIndex = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  // Match arrays — plain (non-$state) since identity comparison is fine for
  // highlight registration; derived $state below is what drives the template.
  let matches: Match[] = [];

  let matchCount = $state(0);
  let tickPositions = $state<number[]>([]);
  let currentTickPosition = $state<number | null>(null);

  // --- Match computation ---

  function computeMatches(q: string): Match[] {
    if (!q || !host) return [];
    const out: Match[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        if (p.closest('.preview-search-overlay, .preview-tick-rail')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const qLower = q.toLowerCase();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      if (!text) continue;
      const textLower = text.toLowerCase();
      let idx = 0;
      while ((idx = textLower.indexOf(qLower, idx)) !== -1) {
        const range = document.createRange();
        try {
          range.setStart(node, idx);
          range.setEnd(node, idx + q.length);
          out.push({ range });
        } catch { /* skip */ }
        idx += q.length;
      }
    }
    return out;
  }

  function applyHighlights() {
    const css: any = CSS as any;
    if (!css.highlights) return;
    const HighlightCtor = (window as any).Highlight;
    if (!HighlightCtor) return;
    try {
      css.highlights.set('gmd-search-match', new HighlightCtor(...matches.map((m) => m.range)));
      const cur = matches[currentIndex];
      css.highlights.set('gmd-search-current', cur ? new HighlightCtor(cur.range) : new HighlightCtor());
    } catch (err) {
      console.warn('CSS Highlight API failed:', err);
    }
  }

  function clearHighlights() {
    const css: any = CSS as any;
    if (!css.highlights) return;
    css.highlights.delete('gmd-search-match');
    css.highlights.delete('gmd-search-current');
  }

  function computeTicks(list: Match[]): number[] {
    if (!scrollWrap || list.length === 0) return [];
    const sh = scrollWrap.scrollHeight;
    const ch = scrollWrap.clientHeight;
    if (sh === 0 || ch === 0) return [];
    const wrapRect = scrollWrap.getBoundingClientRect();
    return list.map((m) => {
      const rect = m.range.getBoundingClientRect();
      const yInContent = rect.top - wrapRect.top + scrollWrap.scrollTop;
      const ratio = Math.max(0, Math.min(1, yInContent / sh));
      return ratio * ch;
    });
  }

  function refresh() {
    if (!host) return;
    matches = computeMatches(query);
    matchCount = matches.length;
    if (matches.length === 0) currentIndex = 0;
    else if (currentIndex >= matches.length) currentIndex = matches.length - 1;
    applyHighlights();
    tickPositions = computeTicks(matches);
    const cur = matches[currentIndex];
    currentTickPosition = cur ? computeTicks([cur])[0] : null;
  }

  $effect(() => {
    // refresh whenever query / currentIndex changes
    // (also when host/scrollWrap become available)
    void query; void currentIndex;
    if (host && scrollWrap) refresh();
  });

  // Re-compute matches whenever preview DOM changes (user edits the markdown).
  $effect(() => {
    if (!host) return;
    const mo = new MutationObserver(() => {
      window.requestAnimationFrame(() => refresh());
    });
    mo.observe(host, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  });

  // Global Cmd+F / Ctrl+F binding — only when focus is NOT inside the CM6 editor
  // (which has its own search panel). This means preview Cmd+F also wins when
  // focus is in the outline pane (acceptable: outline has no own search).
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey && !e.altKey) {
        const active = document.activeElement as HTMLElement | null;
        if (active && active.closest && active.closest('.cm-editor')) return;
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      } else if (e.key === 'Escape' && open) {
        const active = document.activeElement as HTMLElement | null;
        if (active === inputEl) {
          e.preventDefault();
          close();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  function openSearch() {
    open = true;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const selText = sel.toString().trim();
      if (selText && selText.length < 200) query = selText;
    }
    setTimeout(() => {
      inputEl?.focus();
      inputEl?.select();
    }, 0);
  }

  function close() {
    open = false;
    query = '';
    matches = [];
    matchCount = 0;
    currentIndex = 0;
    tickPositions = [];
    currentTickPosition = null;
    clearHighlights();
    refresh();
  }

  function scrollToMatch(idx: number) {
    const m = matches[idx];
    if (!m || !scrollWrap || !host) return;
    // Auto-expand collapsed <details> ancestors of the active match before
    // scrolling. Range.startContainer is a Text node — use its parentElement
    // as the walker starting point. Mirrors revealPreview()'s pattern in
    // src/lib/reveal.ts (editor right-click reveal also expands ancestors).
    const startEl = m.range.startContainer.parentElement;
    if (startEl) expandDetailsAncestors(startEl, host);
    // Wait one frame for <details> layout to settle, then measure + scroll,
    // and refresh tick geometry since opening details grows scrollHeight.
    requestAnimationFrame(() => {
      if (!scrollWrap) return;
      const rect = m.range.getBoundingClientRect();
      const wrapRect = scrollWrap.getBoundingClientRect();
      const yInContent = rect.top - wrapRect.top + scrollWrap.scrollTop;
      scrollWrap.scrollTo({ top: Math.max(0, yInContent - wrapRect.height / 3), behavior: 'smooth' });
      refresh();
    });
  }

  function next() {
    if (matches.length === 0) return;
    currentIndex = (currentIndex + 1) % matches.length;
    scrollToMatch(currentIndex);
  }
  function prev() {
    if (matches.length === 0) return;
    currentIndex = (currentIndex - 1 + matches.length) % matches.length;
    scrollToMatch(currentIndex);
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

{#if open}
  <div class="preview-search-overlay">
    <input
      type="search"
      bind:value={query}
      bind:this={inputEl}
      placeholder="Find in preview…"
      onkeydown={onSearchKey}
      spellcheck="false"
      autocomplete="off"
    />
    <span class="match-count">{!query ? '' : matchCount > 0 ? `${currentIndex + 1} of ${matchCount}` : 'No results'}</span>
    <button type="button" onclick={prev} title="Previous (Shift+Enter)" aria-label="Previous match">‹</button>
    <button type="button" onclick={next} title="Next (Enter)" aria-label="Next match">›</button>
    <button type="button" onclick={close} title="Close (Esc)" aria-label="Close">×</button>
  </div>
{/if}

<div class="preview-tick-rail" aria-hidden="true">
  {#each tickPositions as y, i (i + ':match')}
    <span class="tick match" style="top: {y}px"></span>
  {/each}
  {#if currentTickPosition !== null}
    <span class="tick current" style="top: {currentTickPosition}px"></span>
  {/if}
</div>

<style>
  .preview-search-overlay {
    position: absolute;
    top: 8px;
    right: 22px;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: rgba(255, 255, 255, 0.96);
    border: 1px solid #d0d7de;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    font-size: 12px;
    color: #1f2328;
  }
  .preview-search-overlay input {
    padding: 2px 6px;
    font-size: 12px;
    min-width: 200px;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    background: #ffffff;
    color: #1f2328;
    outline: none;
  }
  .preview-search-overlay input:focus {
    border-color: #0969da;
    box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.2);
  }
  .preview-search-overlay .match-count {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    color: #57606a;
    padding: 0 4px;
    white-space: nowrap;
    min-width: 58px;
    text-align: center;
  }
  .preview-search-overlay button {
    padding: 2px 6px;
    font-size: 13px;
    line-height: 1;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
    color: inherit;
  }
  .preview-search-overlay button:hover {
    background: rgba(9, 105, 218, 0.10);
    border-color: #d0d7de;
  }

  /* v0.5.1: 12 -> 18 to match editor pane. Tick widths scaled to match. */
  .preview-tick-rail {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 18px;
    pointer-events: none;
    z-index: 5;
  }
  .preview-tick-rail .tick {
    position: absolute;
    right: 2px;
    width: 14px;
    height: 2px;
    border-radius: 1px;
  }
  .preview-tick-rail .tick.match {
    background: rgba(255, 195, 0, 0.85);
  }
  .preview-tick-rail .tick.current {
    background: #ff6b00;
    height: 3px;
    width: 16px;
    right: 1px;
  }

  /* CSS Custom Highlight API styling — needs to be global because the article
     content is morphdom-managed and lives outside this component's scope. */
  :global(::highlight(gmd-search-match)) {
    background-color: rgba(255, 195, 0, 0.4);
    color: inherit;
  }
  :global(::highlight(gmd-search-current)) {
    background-color: rgba(255, 107, 0, 0.55);
    color: inherit;
  }

  @media (prefers-color-scheme: dark) {
    .preview-search-overlay {
      background: rgba(22, 27, 34, 0.96);
      border-color: #30363d;
      color: #c9d1d9;
    }
    .preview-search-overlay input {
      background: #0d1117;
      border-color: #30363d;
      color: #c9d1d9;
    }
    .preview-search-overlay .match-count { color: #8b949e; }
    .preview-search-overlay button:hover {
      background: rgba(56, 139, 253, 0.16);
      border-color: #30363d;
    }
    :global(::highlight(gmd-search-match)) {
      background-color: rgba(212, 153, 0, 0.45);
    }
    :global(::highlight(gmd-search-current)) {
      background-color: rgba(212, 92, 0, 0.55);
    }
  }
</style>
