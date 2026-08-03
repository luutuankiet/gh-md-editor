import type { EditorView } from '@codemirror/view';
import { selectSelectionMatches } from '@codemirror/search';
import { EditorSelection } from '@codemirror/state';

// Select every occurrence of the current selection — VS Code's Select All
// Occurrences, the all-at-once counterpart to Mod-d's one-at-a-time walk.
//
// CodeMirror's own selectSelectionMatches is a no-op on an empty cursor, so an
// empty selection is first widened to the word under it. That is the same
// first step Mod-d takes before it starts collecting matches, which keeps the
// two commands agreeing about what "the current word" means.
export function selectAllOccurrences(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (range.empty) {
    const word = view.state.wordAt(range.head);
    // Cursor sitting on whitespace or punctuation: nothing to match on.
    if (!word) return false;
    view.dispatch({ selection: EditorSelection.single(word.from, word.to) });
  }
  return selectSelectionMatches(view);
}
