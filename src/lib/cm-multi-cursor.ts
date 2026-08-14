import { EditorView } from '@codemirror/view';
import { EditorState, EditorSelection, countColumn, findColumn } from '@codemirror/state';
import type { Extension, SelectionRange } from '@codemirror/state';

// Mouse-driven multi-cursor, shared by every editor surface so the gesture
// means the same thing in the markdown editor, the code editor and the diff
// panes. Alt/Opt+click drops a cursor under the pointer; Alt/Opt+click on an
// existing cursor removes it again. Shift+Alt/Opt+click spans a column of
// cursors from the caret to the pointer (see below).
//
// CodeMirror picks the add-a-range modifier through the clickAddsSelectionRange
// facet and reads ONLY the highest-precedence provider, so supplying one
// REPLACES the built-in rather than extending it. That built-in is Cmd on
// macOS and Ctrl everywhere else, hence the explicit OR below: without it this
// would silently take away a chord that works today. Alt is the addition, and
// it is what VS Code binds.
//
// Alt was free to take: rectangularSelection() is not installed anywhere in
// this app, so nothing else claims the modifier at the mouse layer.
//
// Routing through the facet instead of a hand-rolled mousedown handler is also
// what buys the removal half — CodeMirror's own mouse selection drops a cursor
// when the modifier-click lands on one, which a bespoke handler that appends a
// range cannot do.

const MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

// --- Shift+Alt+click column cursors ------------------------------------------
// One caret per line between the caret's line and the clicked line, taking its
// column from the caret on one side and the pointer on the other — the
// multi-caret analogue of shift+click's extend-to-here.
//
// CodeMirror ships rectangularSelection(), and it is NOT what this needs: that
// one anchors the box at the mousedown point and grows it by DRAGGING, so a
// click with no drag collapses to a single cursor under the pointer. The fixed
// corner here is the live caret instead, and the gesture completes on mousedown
// with no drag tracking at all.
//
// The column maths below is ported from that extension because none of it is
// exported. It is worth porting rather than approximating: it counts TABS as
// visual columns, and it recovers a column for clicks PAST the end of a line by
// measuring pixels against the default character width — without which box
// selection over ragged code lands on the wrong characters.

// Above this offset, computing an exact visual column stops being worth the
// scan and offset is used as a stand-in. Same threshold CodeMirror uses.
const MAX_OFF = 2000;

interface ColPos {
  line: number;
  col: number;
  off: number;
}

// A click beyond the last character of a line has no character to measure, so
// the column is estimated from the distance to the viewport's left edge.
function absoluteColumn(view: EditorView, x: number): number {
  const ref = view.coordsAtPos(view.viewport.from);
  return ref ? Math.round(Math.abs((ref.left - x) / view.defaultCharacterWidth)) : -1;
}

function posAtOffset(view: EditorView, pos: number): ColPos {
  const line = view.state.doc.lineAt(pos);
  const off = pos - line.from;
  return {
    line: line.number,
    col: off > MAX_OFF ? -1 : countColumn(line.text, view.state.tabSize, off),
    off,
  };
}

function posAtEvent(view: EditorView, event: MouseEvent): ColPos | null {
  const offset = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (offset == null) return null;
  const line = view.state.doc.lineAt(offset);
  const off = offset - line.from;
  const col = off > MAX_OFF ? -1
    : off === line.length ? absoluteColumn(view, event.clientX)
      : countColumn(line.text, view.state.tabSize, off);
  return { line: line.number, col, off };
}

function columnRanges(state: EditorState, a: ColPos, b: ColPos): SelectionRange[] {
  const startLine = Math.min(a.line, b.line);
  const endLine = Math.max(a.line, b.line);
  const ranges: SelectionRange[] = [];

  if (a.col < 0 || b.col < 0) {
    // No usable visual column on one side (a click far past the end of a very
    // long line). Fall back to raw offsets, clamped to each line so a short
    // line yields a caret at its end instead of a position outside it.
    const startOff = Math.min(a.off, b.off);
    const endOff = Math.max(a.off, b.off);
    for (let i = startLine; i <= endLine; i++) {
      const line = state.doc.line(i);
      ranges.push(EditorSelection.range(
        Math.min(line.from + startOff, line.to),
        Math.min(line.from + endOff, line.to),
      ));
    }
    return ranges;
  }

  const startCol = Math.min(a.col, b.col);
  const endCol = Math.max(a.col, b.col);
  for (let i = startLine; i <= endLine; i++) {
    const line = state.doc.line(i);
    // strict: a line too short to reach the column gets no position at all,
    // and takes a caret at its end rather than being dropped from the column.
    const start = findColumn(line.text, startCol, state.tabSize, true);
    if (start < 0) {
      ranges.push(EditorSelection.cursor(line.to));
    } else {
      const end = findColumn(line.text, endCol, state.tabSize);
      ranges.push(EditorSelection.range(line.from + start, line.from + end));
    }
  }
  return ranges;
}

// Registered as a plain mousedown handler rather than a mouseSelectionStyle
// provider on purpose: a provider is how CodeMirror models a DRAG, and this
// gesture is complete the moment the button goes down.
const columnCursorMouse = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    if (event.button !== 0 || !event.altKey || !event.shiftKey) return false;
    const to = posAtEvent(view, event);
    if (!to) return false;
    const from = posAtOffset(view, view.state.selection.main.head);
    const ranges = columnRanges(view.state, from, to);
    if (!ranges.length) return false;
    // Claim the event, or CodeMirror's own mouse selection runs afterwards and
    // replaces the column with a single extended range.
    event.preventDefault();
    // The caret the user just placed leads, so typing and arrow keys behave as
    // if the click had been an ordinary one.
    const main = to.line >= from.line ? ranges.length - 1 : 0;
    view.dispatch({
      selection: EditorSelection.create(ranges, main),
      userEvent: 'select.pointer',
      scrollIntoView: false,
    });
    // preventDefault suppresses the focus the browser would have given us.
    view.focus();
    return true;
  },
});

export const multiCursorMouse: Extension = [
  EditorState.allowMultipleSelections.of(true),
  EditorView.clickAddsSelectionRange.of(
    (event) => event.button === 0 && (event.altKey || (MAC ? event.metaKey : event.ctrlKey)),
  ),
  columnCursorMouse,
];
