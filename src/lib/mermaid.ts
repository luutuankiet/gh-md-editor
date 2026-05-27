/**
 * Lazy-render Mermaid blocks inside `host`, then enhance each rendered SVG
 * with a bounded-height viewport + pan/zoom (svg-pan-zoom v3.6.2) + custom
 * toolbar overlay. Matches the canvas UX of https://mermaid.live so long
 * diagrams no longer dominate vertical scroll.
 *
 * Mermaid is dynamically imported so it only ships when a doc contains a
 * `mermaid` fenced block. svg-pan-zoom is imported alongside. Each rendered
 * SVG inherits the original `pre`'s `data-source-line` attribute so the
 * reveal-counterpart command still works.
 *
 * Wheel-zoom is gated on Ctrl/Cmd modifier so plain scrolling lets the
 * preview pane scroll past the diagram (Google-Maps-style UX). The custom
 * toolbar provides zoom-in / zoom-out / reset / open-in-new-tab.
 *
 * Morphdom cache contract: when source is unchanged across keystrokes,
 * Preview.svelte's `onBeforeElUpdated` returns false for .mermaid-block —
 * the wrapper survives intact and its attached svg-pan-zoom instance with
 * it. When source changes, the old wrapper is discarded; the matching
 * `onBeforeNodeDiscarded` callback in Preview.svelte invokes the cached
 * `_panzoom.destroy()` to release global event listeners before GC.
 */
import type { Instance as PanZoomInstance } from 'svg-pan-zoom';

let mermaidIdSeq = 0;
let mermaidInitialized = false;
// v0.2.0 (VS Code): track the theme mermaid was last initialized with so we
// can detect per-pane theme switches and force re-render (mermaid bakes
// theme colors into the emitted SVG, so a stale render survives a re-init).
let currentMermaidTheme: 'light' | 'dark' = 'light';

declare global {
  interface HTMLElement {
    _panzoom?: PanZoomInstance;
  }
}

export async function processMermaid(host: HTMLElement, effectiveTheme?: 'light' | 'dark'): Promise<void> {
  if (!host) return;

  // v0.2.0: theme is now a caller argument (Preview.svelte threads its
  // effectiveTheme through). Fallback to OS pref for the web app path. When
  // the theme switched since last call, destroy svg-pan-zoom instances and
  // restore the original <pre><code> source so the render loop below picks
  // the blocks up fresh under the new mermaid theme.
  const theme: 'light' | 'dark' = effectiveTheme
    ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const themeChanged = mermaidInitialized && theme !== currentMermaidTheme;

  if (themeChanged) {
    for (const wrap of Array.from(host.querySelectorAll<HTMLElement>('div.mermaid-block'))) {
      if (wrap._panzoom) {
        try { wrap._panzoom.destroy(); } catch { /* swallow */ }
        wrap._panzoom = undefined;
      }
      const src = wrap.dataset.mermaidSrc || '';
      const sl = wrap.getAttribute('data-source-line');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = src;
      pre.appendChild(code);
      if (sl) pre.setAttribute('data-source-line', sl);
      wrap.replaceWith(pre);
    }
    mermaidInitialized = false; // force re-init below with the new theme
  }

  const blocks = host.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return;

  const [{ default: mermaid }, { default: svgPanZoom }] = await Promise.all([
    import('mermaid'),
    import('svg-pan-zoom'),
  ]);

  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'default',
      // useMaxWidth:false retained from v0.7.1 — emits SVG at natural width
      // (no width:100%+viewBox shrink) so mermaid's foreignObject heights
      // remain correct for multi-line labels (avoids the v0.7.1 cramped-label
      // regression). We override the SVG's width/height attrs to 100%
      // post-render so the diagram fills the bounded .mermaid-block wrapper;
      // svg-pan-zoom reads viewBox to fit+pan+zoom.
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
    currentMermaidTheme = theme;
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

      // v0.7.3: strip mermaid's natural-pixel sizing so the SVG fills our
      // bounded wrapper. svg-pan-zoom reads viewBox (mermaid always emits
      // it) to perform fit+center+pan+zoom; the width/height=100% attrs
      // give svg-pan-zoom a concrete container size to measure against.
      const svgEl = wrap.querySelector('svg');
      if (svgEl) {
        svgEl.setAttribute('width', '100%');
        svgEl.setAttribute('height', '100%');
        svgEl.style.maxWidth = '100%';
        svgEl.style.display = 'block';
      }

      // Toolbar overlay appended before pan/zoom init so it's already in
      // the DOM tree when svg-pan-zoom measures container dimensions.
      const toolbar = buildToolbar(code);
      wrap.appendChild(toolbar);

      pre.replaceWith(wrap);

      // svg-pan-zoom needs the SVG to be in the live DOM tree with a
      // measurable container size before init. pre.replaceWith placed wrap
      // into the document; CSS height (60vh / 480px max) gives the wrapper
      // a concrete size synchronously.
      if (svgEl) {
        try {
          const instance = svgPanZoom(svgEl, {
            controlIconsEnabled: false,    // custom toolbar instead
            fit: true,
            center: true,
            minZoom: 0.2,
            maxZoom: 12,
            zoomScaleSensitivity: 0.4,
            mouseWheelZoomEnabled: false,  // gated via custom listener below
            dblClickZoomEnabled: false,
          });
          wrap._panzoom = instance;

          // v0.7.4: plain-wheel zoom (mermaid.live UX). Mouse over diagram
          // captures wheel → zoom at cursor; wheel-up = zoom in, wheel-down
          // = zoom out, matching the toolbar's −/+ order and every canvas
          // tool convention (Google Maps, Figma, draw.io). Trade-off vs the
          // v0.7.3 Ctrl/Cmd-gated version: to scroll the preview pane past
          // a diagram, move the cursor outside the diagram first (or use
          // the scrollbar / keyboard). Wired manually because svg-pan-zoom's
          // mouseWheelZoomEnabled is all-or-nothing and we want our own
          // zoom factor + at-cursor focal point.
          svgEl.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = svgEl.getBoundingClientRect();
            const point = {
              x: e.clientX - rect.left,
              y: e.clientY - rect.top,
            };
            instance.zoomAtPointBy(e.deltaY < 0 ? 1.1 : 0.9, point);
          }, { passive: false });

          // Toolbar button hooks — late binding so `instance` is in scope.
          toolbar.querySelector<HTMLButtonElement>('[data-action="zoom-in"]')
            ?.addEventListener('click', () => instance.zoomBy(1.25));
          toolbar.querySelector<HTMLButtonElement>('[data-action="zoom-out"]')
            ?.addEventListener('click', () => instance.zoomBy(0.8));
          toolbar.querySelector<HTMLButtonElement>('[data-action="reset"]')
            ?.addEventListener('click', () => {
              instance.resetZoom();
              instance.resetPan();
              instance.fit();
              instance.center();
            });
        } catch (e) {
          // Pan/zoom enhancement is non-critical — log + continue with the
          // static SVG so the diagram still renders even if svg-pan-zoom
          // chokes on edge-case SVG shapes.
          // eslint-disable-next-line no-console
          console.warn('[mermaid] svg-pan-zoom init failed:', e);
        }
      }
    } catch (e) {
      const err = document.createElement('pre');
      err.className = 'mermaid-error';
      err.textContent = `Mermaid error: ${(e as Error).message}`;
      if (sourceLine) err.setAttribute('data-source-line', sourceLine);
      pre.replaceWith(err);
    }
  }
}

function buildToolbar(source: string): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-toolbar';
  toolbar.innerHTML = `
    <button type="button" data-action="zoom-out" title="Zoom out (or wheel down)" aria-label="Zoom out">−</button>
    <button type="button" data-action="zoom-in" title="Zoom in (or wheel up)" aria-label="Zoom in">+</button>
    <button type="button" data-action="reset" title="Fit to view" aria-label="Reset zoom">⟲</button>
    <button type="button" data-action="open" title="Open in mermaid.live" aria-label="Open in new tab">↗</button>
  `;
  // Open-in-new-tab — uses mermaid.live's encoded URL so users get the full
  // editor + canvas. Bound here (not in the late-binding block) because it
  // doesn't depend on the svg-pan-zoom instance.
  const openBtn = toolbar.querySelector<HTMLButtonElement>('[data-action="open"]');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      const url = buildMermaidLiveUrl(source);
      // v0.2.0: VS Code webview sandbox blocks window.open. When running
      // inside the webview, the vscode bridge is exposed on globalThis by
      // webview/main.ts; route the URL through it so the extension host can
      // call vscode.env.openExternal which opens the user's default browser.
      const vsApi = (globalThis as any).__vscodeApi;
      if (vsApi && typeof vsApi.postMessage === 'function') {
        vsApi.postMessage({ type: 'openExternal', url });
      } else {
        window.open(url, '_blank', 'noopener');
      }
    });
  }
  // Prevent toolbar clicks from reaching svg-pan-zoom's pan handler
  // (clicking a button shouldn't initiate a drag-pan on the SVG).
  toolbar.addEventListener('mousedown', (e) => e.stopPropagation());
  toolbar.addEventListener('dblclick', (e) => e.stopPropagation());
  return toolbar;
}

function buildMermaidLiveUrl(source: string): string {
  // mermaid.live's base64 URL format is the simplest interop — pako format
  // would need a deflate dep. base64 still loads natively in their editor.
  const state = {
    code: source,
    mermaid: { theme: 'default' },
    autoSync: true,
    updateDiagram: true,
  };
  const json = JSON.stringify(state);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  return `https://mermaid.live/edit#base64:${encoded}`;
}
