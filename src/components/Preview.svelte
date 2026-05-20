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
    // would replace, losing the rendered SVG. We swap in a STUB div (same class,
    // empty) so morphdom's onBeforeElUpdated sees matching tags and returns false
    // — the live SVG is preserved. We deliberately don't `cloneNode(true)` the
    // rendered SVG: that allocates hundreds of nodes per keystroke and inflates
    // the morphdom walk even when the diff is a no-op, which manifests as
    // visible flicker when the user types fast.
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
        const stub = document.createElement('div');
        stub.className = 'mermaid-block';
        stub.setAttribute('data-source-line', sl);
        stub.dataset.mermaidSrc = oldSrc;
        pre.replaceWith(stub);
      }
      // If source changed, leave the new <pre> in place — mermaid will render it.
    }
  }

  let isFirstRender = true;
  let lastHtml: string | null = null;
  $effect(() => {
    if (!localHost || html == null) return;

    // Same html as last morph (e.g. effect re-fired without html actually
    // changing) → bail. Saves a full morphdom walk + post-process scan and
    // prevents the browser from spuriously repainting the article.
    if (html === lastHtml) return;
    lastHtml = html;

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

    // Track whether morphdom actually inserted any unprocessed mermaid or
    // code blocks. If not, skip the post-processors entirely — their
    // querySelectorAll scans aren't free on large docs, and the dynamic
    // import in highlightLazy queues a microtask paint per keystroke.
    let mermaidPending = false;
    let highlightPending = false;

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
      onNodeAdded: (node) => {
        if (node.nodeType !== 1) return node;
        const el = node as HTMLElement;
        if (el.querySelector?.('pre > code.language-mermaid') || el.matches?.('code.language-mermaid')) {
          mermaidPending = true;
        }
        if (el.querySelector?.('pre > code[class*="language-"]') || el.matches?.('code[class*="language-"]')) {
          highlightPending = true;
        }
        return node;
      },
    });

    if (mermaidPending) void processMermaid(localHost);
    if (highlightPending) void highlightLazy(localHost);
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
    /* Isolate paint so morphdom mutations at the bottom of the article don't
       force the browser to repaint the visible top of the scroll viewport.
       This is the structural fix for the typing-flicker bug. */
    contain: layout style paint;
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
