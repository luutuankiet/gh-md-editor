import type { EditorView } from '@codemirror/view';
import { EditorView as EV } from '@codemirror/view';

/**
 * Scroll the preview pane so the block tied to editor line `line` is centred,
 * and pulse a flash highlight on it for 1.5s.
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
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Restart the animation if a previous flash is still in flight
  target.classList.remove('gmd-flash-highlight');
  void target.offsetWidth; // force reflow
  target.classList.add('gmd-flash-highlight');
  window.setTimeout(() => {
    target!.classList.remove('gmd-flash-highlight');
  }, 1600);
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
