<script lang="ts">
  let { pct = $bindable(50) }: { pct: number } = $props();
  let dragging = $state(false);
  let el: HTMLDivElement;

  function onPointerDown(e: PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || !el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const next = (x / rect.width) * 100;
    pct = Math.max(15, Math.min(85, next));
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    dragging = false;
  }
</script>

<div
  bind:this={el}
  class="splitter"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  tabindex="-1"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
></div>

<style>
  .splitter {
    flex: 0 0 6px;
    cursor: col-resize;
    background: #d0d7de;
    transition: background 120ms;
    touch-action: none;
    user-select: none;
  }
  .splitter:hover,
  .splitter.dragging {
    background: #218bff;
  }
  @media (prefers-color-scheme: dark) {
    .splitter {
      background: #30363d;
    }
    .splitter:hover,
    .splitter.dragging {
      background: #1f6feb;
    }
  }
</style>
