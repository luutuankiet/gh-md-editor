<script lang="ts">
  // Read-only preview for images and PDFs. The bytes come from /api/raw, which
  // serves them with their real content type, so the browser does the
  // rendering: <img> for pictures, its built-in viewer in an <iframe> for PDF.
  import { onMount } from 'svelte';
  import { mediaKindOf } from '../../lib/media-kind';

  let { path, name, onOpenAsText }: { path: string; name: string; onOpenAsText?: () => void } = $props();

  const kind = $derived(mediaKindOf(name));
  const base = $derived(`/api/raw?path=${encodeURIComponent(path)}`);

  // mtime of the bytes on screen. A change on disk swaps the src, which is
  // what makes a re-render of the file show up without touching the tab.
  let version = $state(0);
  let size = $state(0);
  let error = $state('');
  let natural = $state<{ w: number; h: number } | null>(null);

  // A rebuild in the integrated terminal never takes focus from the window,
  // so the shell's focus-driven freshness check would not see it. A HEAD is
  // a stat on the server and no body, cheap enough to ask every two seconds
  // while this tab is the one on screen (an inactive tab is unmounted).
  async function probe() {
    try {
      const r = await fetch(base, { method: 'HEAD' });
      if (!r.ok) { error = r.status === 404 ? 'file no longer exists' : `HTTP ${r.status}`; return; }
      error = '';
      const m = Number(r.headers.get('x-mtime-ms') ?? 0);
      size = Number(r.headers.get('content-length') ?? 0);
      if (m && m !== version) version = m;
    } catch { /* server restarting: the next tick tries again */ }
  }

  onMount(() => {
    void probe();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void probe(); }, 2000);
    const onFocus = () => void probe();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  });

  const src = $derived(version ? `${base}&v=${version}` : '');

  // Fit-to-pane by default; a click shows actual pixels centred on the point
  // clicked, drag pans, and a click without a drag goes back to fit.
  let actual = $state(false);
  let box: HTMLDivElement | undefined = $state();
  let img: HTMLImageElement | undefined = $state();
  let drag: { x: number; y: number; sl: number; st: number; moved: boolean } | null = null;

  // Zoom only means something when fit has scaled the image down. A slide
  // smaller than the pane is already at 100%, so a click there does nothing.
  let shrunk = $state(false);
  function measure() {
    if (img && !actual) shrunk = img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1;
  }
  $effect(() => {
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  });

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !box) return;
    drag = { x: e.clientX, y: e.clientY, sl: box.scrollLeft, st: box.scrollTop, moved: false };
    try { box.setPointerCapture(e.pointerId); } catch { /* pointer already gone: panning still works inside the box */ }
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag || !box) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (actual && drag.moved) {
      box.scrollLeft = drag.sl - dx;
      box.scrollTop = drag.st - dy;
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!drag || !box || !img) { drag = null; return; }
    const moved = drag.moved;
    drag = null;
    if (moved) return;
    if (actual) { actual = false; requestAnimationFrame(measure); return; }
    if (!shrunk) return;
    const r = img.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    actual = true;
    requestAnimationFrame(() => {
      if (!box || !img) return;
      box.scrollLeft = fx * img.offsetWidth - box.clientWidth / 2;
      box.scrollTop = fy * img.offsetHeight - box.clientHeight / 2;
    });
  }

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div class="media">
  {#if error}
    <div class="note">Cannot preview {name}: {error}</div>
  {:else if !src}
    <div class="note">Loading {name}…</div>
  {:else if kind === 'pdf'}
    <iframe class="pdf" title={name} {src}></iframe>
  {:else}
    <div
      class="stage"
      class:actual
      class:shrunk
      bind:this={box}
      role="presentation"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
    >
      <img
        bind:this={img}
        {src}
        alt={name}
        draggable="false"
        onload={() => {
          if (!img) return;
          natural = { w: img.naturalWidth, h: img.naturalHeight };
          // A re-render keeps the zoom, unless the new image fits the pane.
          if (actual && box && img.naturalWidth <= box.clientWidth && img.naturalHeight <= box.clientHeight) actual = false;
          requestAnimationFrame(measure);
        }}
        onerror={() => { error = 'the browser could not decode this image'; }}
      />
    </div>
    <div class="bar">
      {#if natural}<span>{natural.w} × {natural.h}</span>{/if}
      {#if size}<span>{fmtSize(size)}</span>{/if}
      <span class="hint">{actual ? 'drag to pan · click to fit' : shrunk ? 'click to zoom to 100%' : 'actual size'}</span>
      {#if onOpenAsText}<button type="button" onclick={onOpenAsText}>Open as text</button>{/if}
    </div>
  {/if}
</div>

<style>
  .media {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .note {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #949494;
    font-size: 13px;
  }
  .pdf {
    flex: 1;
    width: 100%;
    border: 0;
    background: #525659;
  }
  .stage {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    user-select: none;
  }
  .stage.shrunk {
    cursor: zoom-in;
  }
  .stage.actual {
    overflow: auto;
    display: block;
    cursor: grab;
  }
  .stage.actual:active {
    cursor: grabbing;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    /* A checkerboard behind the image, so transparency reads as transparency. */
    background:
      repeating-conic-gradient(#2e2e2e 0% 25%, #3a3a3a 0% 50%) 0 0 / 16px 16px;
  }
  .stage.actual img {
    max-width: none;
    max-height: none;
    margin: auto;
    display: block;
  }
  .bar {
    display: flex;
    gap: 14px;
    align-items: center;
    padding: 4px 12px;
    font-size: 12px;
    color: #949494;
    border-top: 1px solid #333;
  }
  .hint {
    margin-left: auto;
  }
  .bar button {
    background: none;
    border: 1px solid #444;
    color: #ccc;
    font-size: 12px;
    padding: 1px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
</style>
