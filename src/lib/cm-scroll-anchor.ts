// Remembering where a CodeMirror editor was scrolled to, across a component
// that gets destroyed and rebuilt.
//
// `EditorView.scrollSnapshot()` exists for exactly this job and is the right
// tool within one session, but it cannot be persisted: it returns an opaque
// StateEffect wrapping a private ScrollTarget, and its own contract wants "a
// document identical to the one it was created for". A line number plus the
// pixel remainder inside that line survives a reload, and survives the wrap and
// font-size changes that make a raw scrollTop point at different text than it
// did when it was written.

import { EditorView } from '@codemirror/view';

export interface ScrollAnchor {
  line: number;
  off: number;
}

export function readScrollAnchor(view: EditorView): ScrollAnchor | null {
  const scroller = view.scrollDOM;
  if (!scroller.isConnected) return null;
  // How far the document has moved up past the top of the visible area,
  // expressed in the same coordinate space as a line block's `top`.
  const y = scroller.getBoundingClientRect().top - view.documentTop;
  if (y <= 0) return { line: 1, off: 0 };
  const block = view.lineBlockAtHeight(y);
  return {
    line: view.state.doc.lineAt(block.from).number,
    off: Math.round(y - block.top),
  };
}

// Restoring a plain pixel offset on a container that is still growing.
//
// The merge view folds every unchanged region as it installs and measures the
// result across several frames; a rendered markdown article grows again when
// highlighting and diagrams land. Assigning scrollTop once, early, silently
// clamps to whatever the height happened to be at that moment — which reads as
// "the scroll position was not saved" even when it was saved perfectly.
//
// So retry until the container can actually hold the offset, then stop. Bounded,
// so a document that is genuinely shorter than it used to be gives up instead of
// leaving a timer armed. Returns a cancel function for the caller's teardown.
export function restoreScrollTop(
  resolve: () => HTMLElement | null,
  px: number,
  tries = 25,
): () => void {
  if (px <= 0) return () => {};
  let left = tries;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const stop = () => {
    done = true;
    clearTimeout(timer);
  };
  const attempt = () => {
    if (done) return;
    if (left-- <= 0) {
      stop();
      return;
    }
    const el = resolve();
    if (el && el.scrollHeight - el.clientHeight >= px) {
      el.scrollTop = px;
      stop();
      return;
    }
    timer = setTimeout(attempt, 60);
  };
  timer = setTimeout(attempt, 0);
  return stop;
}

export function applyScrollAnchor(view: EditorView, anchor: ScrollAnchor) {
  const doc = view.state.doc;
  const line = Math.min(Math.max(1, Math.round(anchor.line)), doc.lines);
  if (line === 1 && anchor.off <= 0) return;
  const pos = doc.line(line).from;
  // Let CodeMirror do the scrolling rather than computing an offset here: only
  // the visible range is measured, so a target far down a long file needs its
  // measure-and-remeasure loop, not one arithmetic guess against estimated
  // heights. The sub-line remainder is added once that has landed.
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
  if (anchor.off <= 0) return;
  view.requestMeasure({
    read: () => null,
    write: () => { view.scrollDOM.scrollTop += anchor.off; },
  });
}
