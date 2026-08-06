// Drag handles for the diff and merge layouts.
//
// Both places resize flex children, so a handle writes flex values rather than
// pixel sizes: the split then survives a window resize, a sidebar toggle and a
// font change with nobody recomputing it. Two models, because the two layouts
// express size differently — a row of equal panes shares `flex-grow`, while a
// fixed band above a filling one is driven by `flex-basis`.

export interface SplitOpts {
  axis: 'x' | 'y';
  /** `grow` splits a pair of flexible siblings; `basis` sizes the first one. */
  mode?: 'grow' | 'basis';
  /** localStorage key. Omitted means the split is not remembered. */
  key?: string;
  /** Fraction taken by the first element when nothing is stored. */
  initial?: number;
  /** Smallest fraction either side may be squeezed to. */
  min?: number;
}

function stored(key: string | undefined, fallback: number): number {
  if (!key) return fallback;
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
  } catch {
    // Private mode, or a browser refusing storage. A forgotten split beats a
    // dead layout.
    return fallback;
  }
}

function remember(key: string | undefined, ratio: number) {
  if (!key) return;
  try { localStorage.setItem(key, String(ratio)); } catch { /* see above */ }
}

// Turn an existing element into the divider between two siblings.
export function attachSplit(
  el: HTMLElement,
  before: HTMLElement,
  after: HTMLElement,
  o: SplitOpts,
): () => void {
  const mode = o.mode ?? 'grow';
  const min = o.min ?? 0.08;
  const horizontal = o.axis === 'x';
  const base = o.initial ?? 0.5;

  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
  if (!el.title) el.title = 'Drag to resize — double-click to reset';

  // Whatever grow the pair already shares stays constant, so moving one
  // boundary of a three-pane row cannot quietly steal space from the pane on
  // the far side of the other boundary. Read at apply time, not at attach
  // time: the neighbouring handle rewrites the grow of the pane these two
  // share, and a sum captured while every pane was still at 1 would then be
  // stale — measured as the far pane jumping ~35px on a drag that never
  // touched it.
  const growSum = () => (mode === 'grow'
    ? (parseFloat(before.style.flexGrow) || 1) + (parseFloat(after.style.flexGrow) || 1)
    : 2);

  const clamp = (r: number) => Math.min(1 - min, Math.max(min, r));

  function apply(raw: number, persist: boolean) {
    const ratio = clamp(raw);
    if (mode === 'grow') {
      const sum = growSum();
      before.style.flexGrow = String(sum * ratio);
      before.style.flexBasis = '0';
      after.style.flexGrow = String(sum * (1 - ratio));
      after.style.flexBasis = '0';
    } else {
      before.style.flex = `0 0 ${(ratio * 100).toFixed(2)}%`;
      after.style.flex = '1 1 0';
    }
    if (persist) remember(o.key, ratio);
  }

  apply(stored(o.key, base), false);

  let dragging = false;

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    // Capture is what keeps the drag alive when the pointer crosses into an
    // editor that would otherwise swallow the move events. A browser that
    // refuses it still drags — just not once the pointer leaves the handle.
    try { el.setPointerCapture(e.pointerId); } catch { /* capture unavailable */ }
    el.classList.add('active');
    // The editors on either side do their own pointer handling; suppressing
    // selection for the duration is what stops a drag from painting text.
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function onMove(e: PointerEvent) {
    if (!dragging) return;
    const a = before.getBoundingClientRect();
    const b = after.getBoundingClientRect();
    // Span the whole pair rather than summing the two boxes: anything sitting
    // between them — the merge view's revert gutter, this handle — is part of
    // the distance the pointer travels.
    const start = horizontal ? a.left : a.top;
    const total = (horizontal ? b.right : b.bottom) - start;
    if (total <= 0) return;
    apply(((horizontal ? e.clientX : e.clientY) - start) / total, true);
  }

  function onUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    el.classList.remove('active');
    document.body.style.userSelect = '';
  }

  function onDouble() {
    apply(base, true);
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('dblclick', onDouble);

  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('dblclick', onDouble);
    document.body.style.userSelect = '';
  };
}

// For layouts built by someone else's code — the merge view assembles its own
// DOM, so the handle has to be made and inserted by hand.
export function makeSplitHandle(
  before: HTMLElement,
  after: HTMLElement,
  o: SplitOpts,
): { el: HTMLDivElement; destroy(): void } {
  const el = document.createElement('div');
  el.className = `gmd-split-handle ${o.axis === 'x' ? 'x' : 'y'}`;
  const off = attachSplit(el, before, after, o);
  return {
    el,
    destroy() {
      off();
      el.remove();
    },
  };
}

// Svelte action for handles that live in markup: the elements it resizes are
// its own siblings, which is exactly how a divider reads in a template.
export function splitter(node: HTMLElement, o: SplitOpts) {
  let off: (() => void) | null = null;
  const wire = () => {
    const before = node.previousElementSibling as HTMLElement | null;
    const after = node.nextElementSibling as HTMLElement | null;
    if (!before || !after) return false;
    off = attachSplit(node, before, after, o);
    return true;
  };
  // An action can run before the sibling that follows it has been inserted.
  // One frame later the block is complete, and a handle that found nothing to
  // resize simply stays inert.
  if (!wire()) requestAnimationFrame(() => { if (!off) wire(); });
  return { destroy: () => off?.() };
}
