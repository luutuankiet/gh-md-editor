<script lang="ts">
  import 'github-markdown-css/github-markdown.css';
  import morphdom from 'morphdom';
  import { processMermaid } from '../lib/mermaid';

  let {
    html,
    host = $bindable<HTMLElement | null>(null),
    onRevealRequest,
  }: {
    html: string;
    host?: HTMLElement | null;
    onRevealRequest?: (node: HTMLElement) => void;
  } = $props();

  let localHost: HTMLElement;
  let scrollWrap: HTMLElement;

  // ---------------------------------------------------------------------------
  // Flicker fix (the #1 user-reported bug):
  //
  // Previously each keystroke called `localHost.innerHTML = html`, which the
  // browser implements as wholesale child replacement — the entire preview
  // subtree is torn down and re-built, even when 99% of it is identical. The
  // user sees a visible flash on every keystroke; <details open> state resets
  // because the source markdown defaults to closed; scrollTop snaps because
  // the scrollable container's children are gone; mermaid SVGs disappear and
  // re-render; starry-night highlighting is lost and re-applied.
  //
  // morphdom does a virtual-DOM-style diff against the new HTML string and
  // applies *only* the minimal mutations. Unchanged subtrees are not touched
  // at all — they keep their state (details/open, scroll, focus). For tags
  // that genuinely changed (e.g. mermaid <pre> in the new HTML vs <div
  // .mermaid-block> in the live DOM) we pre-substitute before morphing so
  // morphdom sees matching shapes.
  // ---------------------------------------------------------------------------

  function preSubstituteMermaid(newRoot: HTMLElement, oldHost: HTMLElement): void {
    // Old DOM holds `<div .mermaid-block data-source-line=N data-mermaid-src=...>`
    // (post-render). The new HTML from markdown-it has `<pre data-source-line=N>
    // <code .language-mermaid>source</code></pre>`. Different tag = morphdom
    // would replace, losing the rendered SVG. Splice the old div into the new
    // tree at the same source-line so morphdom keeps it.
    const rendered = new Map<string, HTMLElement>();
    for (const m of oldHost.querySelectorAll<HTMLElement>('div.mermaid-block[data-source-line]')) {
      const sl = m.dataset.sourceLine;
      if (sl) rendered.set(sl, m);
    }
    if (rendered.size === 0) return;
    for (const pre of Array.from(newRoot.querySelectorAll<HTMLElement>('pre[data-source-line]'))) {
      const code = pre.querySelector<HTMLElement>('code.language-mermaid');
      if (!code) continue;
      const sl = pre.getAttribute('data-source-line');
      if (!sl) continue;
      const old = rendered.get(sl);
      if (!old) continue;
      const newSrc = (code.textContent || '').trim();
      const oldSrc = old.dataset.mermaidSrc || '';
      if (oldSrc && oldSrc === newSrc) {
        pre.replaceWith(old.cloneNode(true));
      }
      // If source changed, leave the new <pre> in place — mermaid will render it.
    }
  }

  let isFirstRender = true;
  $effect(() => {
    if (!localHost || html == null) return;

    if (isFirstRender || localHost.childElementCount === 0) {
      localHost.innerHTML = html;
      isFirstRender = false;
      void processMermaid(localHost);
      void highlightLazy(localHost);
      return;
    }

    const newRoot = document.createElement('div');
    newRoot.innerHTML = html;

    preSubstituteMermaid(newRoot, localHost);

    morphdom(localHost, newRoot, {
      childrenOnly: true,
      onBeforeElUpdated: (fromEl, toEl) => {
        // Preserve <details open> across morphs — markdown source defaults to
        // closed, so without this every keystroke would slam open <details>
        // back to closed mid-edit.
        if (fromEl.tagName === 'DETAILS') {
          if ((fromEl as HTMLDetailsElement).open) toEl.setAttribute('open', '');
          else toEl.removeAttribute('open');
        }
        // Skip mermaid blocks entirely — pre-substituted above; the inner SVG
        // structure differs from anything markdown-it emits, so let it be.
        if (fromEl.classList?.contains('mermaid-block')) {
          return false;
        }
        // Skip highlighted code blocks whose source text is unchanged — keeps
        // the starry-night spans intact instead of re-highlighting per keystroke.
        if (
          (fromEl as HTMLElement).dataset?.snHighlighted === 'true' &&
          fromEl.tagName === 'CODE'
        ) {
          const newSrc = toEl.textContent || '';
          if ((fromEl as HTMLElement).dataset?.snSource === newSrc) {
            return false;
          }
        }
        return true;
      },
    });

    // Both are idempotent (skip data-rendered / data-sn-highlighted blocks),
    // so they only fire on blocks that morphdom newly inserted.
    void processMermaid(localHost);
    void highlightLazy(localHost);
  });

  async function highlightLazy(target: HTMLElement) {
    // Only pay the cost (≈1 MB starry-night + CSS) if there's a non-mermaid
    // fenced block in the doc.
    const blocks = target.querySelectorAll('pre > code[class*="language-"]');
    let needs = false;
    for (const b of blocks) {
      if (!b.className.includes('language-mermaid')) { needs = true; break; }
    }
    if (!needs) return;
    const mod = await import('../lib/highlight');
    await mod.applyStarryNight(target);
  }

  $effect(() => {
    if (scrollWrap) host = scrollWrap;
  });

  function findSourceLineAncestor(node: HTMLElement | null): HTMLElement | null {
    let n: HTMLElement | null = node;
    while (n && n !== localHost && !n.dataset.sourceLine) n = n.parentElement;
    return n && n !== localHost ? n : null;
  }

  // Right-click is the single reveal-counterpart action on both panes now.
  // (Double-click handler dropped per v0.4.0 — redundant with right-click.)
  function handleContextMenu(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target || !onRevealRequest) return;
    const anchor = findSourceLineAncestor(target);
    if (!anchor) return;
    e.preventDefault();
    onRevealRequest(anchor);
  }
</script>

<div class="preview-wrap" bind:this={scrollWrap}>
  <article
    class="markdown-body"
    bind:this={localHost}
    oncontextmenu={handleContextMenu}
  ></article>
</div>

<style>
  .preview-wrap {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg, #ffffff);
  }
  .markdown-body {
    box-sizing: border-box;
    padding: 24px 32px;
    max-width: 100%;
  }
  :global(.markdown-body) {
    font-size: 14px;
  }
  @media (prefers-color-scheme: dark) {
    .preview-wrap {
      background: #0d1117;
    }
  }
</style>
