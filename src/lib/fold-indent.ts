import { foldNodeProp, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

// Trimmed copy of CodeMirror's internal syntaxFolding: does the loaded grammar
// already know how to fold the block ending on this line? foldService handlers
// run BEFORE syntax folding, so the indentation fallback below must stand down
// wherever a real grammar fold exists — otherwise it masks the better range.
function syntaxFold(state: EditorState, from: number, to: number) {
  const tree = syntaxTree(state);
  if (tree.length < to) return null;
  let found: { from: number; to: number } | null = null;
  for (let cur: SyntaxNode | null = tree.resolveInner(to, 1); cur; cur = cur.parent) {
    if (cur.to <= to || cur.from > to) continue;
    if (found && cur.from < from) break;
    const prop = cur.type.prop(foldNodeProp);
    if (!prop) continue;
    const value = prop(cur, state);
    if (value && value.from <= to && value.from >= from && value.to > to) found = value;
  }
  return found;
}

// Indentation-based folding for the long tail: grammars in
// @codemirror/language-data that ship no fold metadata, plus plain text. Blank
// lines stay inside the block so a function with paragraph breaks folds whole.
export function indentFoldService(state: EditorState, from: number, to: number) {
  if (syntaxFold(state, from, to)) return null;
  const line = state.doc.lineAt(from);
  if (!line.text.trim()) return null;
  const indent = line.text.match(/^\s*/)![0].length;
  let last = line.number;
  for (let i = line.number + 1; i <= state.doc.lines; i++) {
    const l = state.doc.line(i);
    if (!l.text.trim()) continue;
    const ind = l.text.match(/^\s*/)![0].length;
    if (ind > indent) last = i;
    else break;
  }
  if (last <= line.number) return null;
  return { from: line.to, to: state.doc.line(last).to };
}
