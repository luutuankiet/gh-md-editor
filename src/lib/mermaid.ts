/**
 * Lazy-render Mermaid blocks inside `host`.
 *
 * Mermaid is dynamically imported so it only ships when a doc contains a
 * `mermaid` fenced block.  Each rendered SVG inherits the original `pre`'s
 * `data-source-line` attribute so the reveal-counterpart command still works.
 */
let mermaidIdSeq = 0;
let mermaidInitialized = false;

export async function processMermaid(host: HTMLElement): Promise<void> {
  if (!host) return;
  const blocks = host.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return;

  const { default: mermaid } = await import('mermaid');
  if (!mermaidInitialized) {
    const darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: darkMode ? 'dark' : 'default',
      // Disable useMaxWidth across every v10 diagram type so SVGs render at
      // natural width and the surrounding `.mermaid-block { overflow-x: auto }`
      // wrapper scrolls horizontally when the diagram exceeds pane width.
      // Without this, mermaid's default `useMaxWidth: true` sets the SVG to
      // width:100% with a viewBox, which uniformly shrinks text on wide
      // diagrams ("cramped" labels). Matches GitHub's render.
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      requirement: { useMaxWidth: false },
      c4: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
      timeline: { useMaxWidth: false },
      gitGraph: { useMaxWidth: false },
      sankey: { useMaxWidth: false },
      xyChart: { useMaxWidth: false },
      quadrantChart: { useMaxWidth: false },
      block: { useMaxWidth: false },
    });
    mermaidInitialized = true;
  }

  for (const block of Array.from(blocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.rendered === '1') continue;
    const code = (block.textContent || '').trim();
    const id = `mmd-${++mermaidIdSeq}`;
    const sourceLine = pre.getAttribute('data-source-line');
    try {
      const { svg } = await mermaid.render(id, code);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-block';
      wrap.innerHTML = svg;
      if (sourceLine) wrap.setAttribute('data-source-line', sourceLine);
      wrap.dataset.rendered = '1';
      // Cache source so the morphdom pre-substitution in Preview.svelte
      // can detect 'unchanged' mermaid blocks across keystrokes and reuse
      // the rendered SVG instead of re-rendering (which causes flicker).
      wrap.dataset.mermaidSrc = code;
      pre.replaceWith(wrap);
    } catch (e) {
      const err = document.createElement('pre');
      err.className = 'mermaid-error';
      err.textContent = `Mermaid error: ${(e as Error).message}`;
      if (sourceLine) err.setAttribute('data-source-line', sourceLine);
      pre.replaceWith(err);
    }
  }
}
