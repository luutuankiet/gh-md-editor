import type { EditorView } from '@codemirror/view';
import { EditorView as EV } from '@codemirror/view';

/**
 * Walk up from `target` toward `host`, opening any closed <details> ancestors
 * so the target becomes visible before we try to scroll/flash it.
 * Without this, revealing a line whose preview counterpart lives inside a
 * collapsed <details> would scroll-then-flash an element with zero height.
 */
function expandDetailsAncestors(target: HTMLElement, host: HTMLElement): void {
  let p: HTMLElement | null = target;
  while (p && p !== host) {
    if (p.tagName === 'DETAILS' && !(p as HTMLDetailsElement).open) {
      (p as HTMLDetailsElement).open = true;
    }
    p = p.parentElement;
  }
}

/**
 * Scroll the preview pane so the block tied to editor line `line` is centred,
 * and pulse a flash highlight on it for 1.5s. Expands ancestor <details> first
 * so the target is actually visible before scroll.
 */
export function revealPreview(host: HTMLElement, line: number): void {
  if (!host || !Number.isFinite(line)) return;
  const nodes = Array.from(host.querySelectorAll<HTMLElement>('[data-source-line]'));
  if (nodes.length === 0) return;
  let target: HTMLElement | null = null;
  for (const n of nodes) {
    const l = Number(n.dataset.sourceLine);
    if (!Number.isFinite(l)) continue;
    if (l <= line) target = n;
    else break;
  }
  if (!target) target = nodes[0];

  // Expand any collapsed <details> wrapping the target so it's actually visible.
  expandDetailsAncestors(target, host);

  // Wait one frame for the <details> to layout before scrolling — otherwise
  // scrollIntoView reads pre-expansion geometry and lands on the wrong y.
  const t = target;
  requestAnimationFrame(() => {
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Restart the animation if a previous flash is still in flight.
    t.classList.remove('gmd-flash-highlight');
    void t.offsetWidth; // force reflow
    t.classList.add('gmd-flash-highlight');
    window.setTimeout(() => {
      t.classList.remove('gmd-flash-highlight');
    }, 1600);
  });
}

/**
 * Walk up from `fromNode` to find an ancestor with [data-source-line],
 * scroll the editor to that line, and place the caret at line start.
 */
export function revealEditor(view: EditorView | null, fromNode: HTMLElement): void {
  if (!view || !fromNode) return;
  let n: HTMLElement | null = fromNode;
  while (n && !n.dataset.sourceLine) n = n.parentElement;
  if (!n) return;
  const line = Number(n.dataset.sourceLine);
  if (!Number.isFinite(line) || line < 1) return;
  const doc = view.state.doc;
  if (line > doc.lines) return;
  const lineObj = doc.line(line);
  view.dispatch({
    selection: { anchor: lineObj.from },
    effects: EV.scrollIntoView(lineObj.from, { y: 'center' }),
  });
  view.focus();
}
