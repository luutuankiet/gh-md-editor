import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';

// Mouse-driven multi-cursor, shared by every editor surface so the gesture
// means the same thing in the markdown editor, the code editor and the diff
// panes. Alt/Opt+click drops a cursor under the pointer; Alt/Opt+click on an
// existing cursor removes it again.
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

export const multiCursorMouse: Extension = [
  EditorState.allowMultipleSelections.of(true),
  EditorView.clickAddsSelectionRange.of(
    (event) => event.button === 0 && (event.altKey || (MAC ? event.metaKey : event.ctrlKey)),
  ),
];
