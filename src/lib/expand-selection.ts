import { EditorSelection, type EditorState, type SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { selectParentSyntax } from '@codemirror/commands';

// Shrink is only meaningful as the inverse of expand, so each view keeps the
// ladder it climbed. Keyed weakly: a closed tab's view is garbage either way.
const history = new WeakMap<EditorView, { from: number; to: number }[]>();

function sameRange(a: { from: number; to: number }, b: { from: number; to: number }) {
  return a.from === b.from && a.to === b.to;
}

// Push a rung onto a view's ladder. Exported so a pane with its own expand
// command (the markdown pane, whose heading-section logic is not reusable
// here) can still feed the shared shrink command.
export function recordExpansion(view: EditorView, before: { from: number; to: number }) {
  const stack = history.get(view) ?? [];
  stack.push({ from: before.from, to: before.to });
  history.set(view, stack);
}

// The block that starts on this line and runs while indentation stays deeper.
// The fallback for StreamLanguage grammars (shell, ini, dotenv, the whole
// legacy-modes tail), whose parse trees are flat token streams — there are no
// enclosing nodes for selectParentSyntax to climb, so it reports no growth.
function indentBlock(state: EditorState, range: SelectionRange) {
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);
  const indentOf = (text: string) => text.match(/^\s*/)![0].length;

  // Walk up to the nearest line that is shallower than the selection: that is
  // the block header (`if ...`, `def ...`, a section comment), and the block
  // is it plus everything indented under it.
  let base = startLine;
  let baseIndent = indentOf(startLine.text);
  if (!startLine.text.trim()) return null;
  for (let i = startLine.number - 1; i >= 1; i--) {
    const l = state.doc.line(i);
    if (!l.text.trim()) continue;
    const ind = indentOf(l.text);
    if (ind < baseIndent) {
      base = l;
      baseIndent = ind;
      break;
    }
  }

  let last = Math.max(base.number, endLine.number);
  for (let i = last + 1; i <= state.doc.lines; i++) {
    const l = state.doc.line(i);
    if (!l.text.trim()) continue;
    if (indentOf(l.text) > baseIndent) last = i;
    else break;
  }
  const block = { from: base.from, to: state.doc.line(last).to };
  // Only useful if it actually contains more than what is already selected.
  if (block.from >= range.from && block.to <= range.to) return null;
  return block;
}

// The whole line, as an intermediate rung between a word and a syntax node.
function lineRange(state: EditorState, range: SelectionRange) {
  const from = state.doc.lineAt(range.from).from;
  const to = state.doc.lineAt(range.to).to;
  if (from >= range.from && to <= range.to) return null;
  return { from, to };
}

// Grow the selection by one structural step. The ladder, in order: word →
// line → enclosing syntax node (repeatedly, as the caller presses again) →
// indentation block → whole document. Each rung is only taken when the one
// before it produced no growth, so grammars with real trees never touch the
// heuristics and grammars without one still climb.
export function expandSelection(view: EditorView): boolean {
  const before = view.state.selection.main;
  const doc = view.state.doc;

  const push = (next: { from: number; to: number }) => {
    recordExpansion(view, before);
    view.dispatch({ selection: EditorSelection.single(next.from, next.to), scrollIntoView: true });
    return true;
  };

  // Empty selection: take the word under the cursor first — without this the
  // first press jumps straight to a whole statement and feels imprecise.
  if (before.empty) {
    const word = view.state.wordAt(before.head);
    if (word && !word.empty) return push({ from: word.from, to: word.to });
    const line = lineRange(view.state, before);
    if (line) return push(line);
  }

  // Ask the grammar. Dispatches internally, so read the result and undo the
  // move if it turns out not to have grown — the fallbacks below need the
  // original selection to reason from.
  selectParentSyntax(view);
  const afterSyntax = view.state.selection.main;
  const grewBySyntax =
    !sameRange(afterSyntax, before) && afterSyntax.from <= before.from && afterSyntax.to >= before.to;
  if (grewBySyntax) {
    recordExpansion(view, before);
    return true;
  }
  if (!sameRange(afterSyntax, before)) {
    // Moved sideways rather than outwards — put it back before falling through.
    view.dispatch({ selection: EditorSelection.single(before.from, before.to) });
  }

  const line = lineRange(view.state, before);
  if (line) return push(line);

  const block = indentBlock(view.state, before);
  if (block) return push(block);

  if (before.from > 0 || before.to < doc.length) return push({ from: 0, to: doc.length });
  return false;
}

// Step back down the ladder this view climbed. No history means nothing to
// shrink to — returning false lets the key fall through to anything else bound.
export function shrinkSelection(view: EditorView): boolean {
  const stack = history.get(view);
  if (!stack || !stack.length) return false;
  const prev = stack.pop()!;
  const len = view.state.doc.length;
  view.dispatch({
    selection: EditorSelection.single(Math.min(prev.from, len), Math.min(prev.to, len)),
    scrollIntoView: true,
  });
  return true;
}

// Edits invalidate the ladder — the ranges it holds no longer describe the
// document. Called from the editor's update listener.
export function resetSelectionHistory(view: EditorView) {
  history.delete(view);
}
