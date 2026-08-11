// Find, in a diff, can land on a line that is not there.
//
// `@codemirror/merge` folds long unchanged stretches behind a block-replace
// decoration -- the grey `N unchanged lines` strip. The text stays in the
// document, so the search cursor walks it and the match counter counts it;
// only the view drops it. The result is a find panel that reports "5 of 24",
// scrolls somewhere plausible, and highlights nothing at all.
//
// The package exposes the unfold as a state effect but keeps the two helpers
// its own click handler uses -- the chunk position map, and the collapsed-range
// field -- module-private. What follows reimplements the position map over the
// exported chunk list, which is ten lines and no fork.
import { EditorView } from '@codemirror/view';
import { uncollapseUnchanged, getChunks, mergeViewSiblings } from '@codemirror/merge';
import type { Chunk } from '@codemirror/merge';

/**
 * The start offset of the collapsed strip hiding `pos`, or null when `pos` is
 * on a line that actually renders.
 *
 * A collapsed region is one block covering many lines, so its block info runs
 * past the end of the line it starts on -- that is the whole test. Works for
 * positions outside the rendered viewport, because block-replace decorations
 * are height-relevant and therefore live in the document-wide height map.
 *
 * The offset matters, not just the boolean: the unfold effect is applied as a
 * filter keyed on exact equality with the decoration's `from`, so anything
 * else -- the match position, a line start inside the region -- is discarded
 * silently and the strip stays shut.
 */
export function isCollapsedAt(view: EditorView, pos: number): number | null {
  try {
    const block = view.lineBlockAt(pos);
    const line = view.state.doc.lineAt(block.from);
    return block.to > line.to ? block.from : null;
  } catch {
    return null;
  }
}

// Translate a position on one side of a diff to the equivalent position on the
// other, by walking the chunks and carrying the offset between them. Unchanged
// stretches have the same length on both sides by definition, so the offset
// only moves where a chunk does.
function mapPos(pos: number, chunks: readonly Chunk[], isA: boolean): number {
  let startOur = 0;
  let startOther = 0;
  for (let i = 0; ; i++) {
    const next = i < chunks.length ? chunks[i] : null;
    if (!next || (isA ? next.fromA : next.fromB) >= pos) return startOther + (pos - startOur);
    [startOur, startOther] = isA ? [next.toA, next.toB] : [next.toB, next.toA];
  }
}

/**
 * Unfold whatever is hiding `pos`, on both columns, then put the line on
 * screen. Returns false when nothing was hidden and the caller need not care.
 *
 * The sibling is not optional. Expanding one column alone leaves it N lines
 * taller than the other, and the merge view papers over the difference with a
 * spacer the height of the revealed text -- the two sides stop lining up,
 * which is the one thing a diff has to get right. The package's own strip
 * click does exactly this pairing; this is the same move, reached from a
 * search step instead of a mouse.
 *
 * Must be called outside an editor update -- a view cannot dispatch into
 * itself mid-update. The scroll is deferred again on top, because the height
 * map only knows where the revealed line ended up after the unfold has been
 * applied and measured.
 */
export function revealSearchMatch(view: EditorView, pos: number): boolean {
  const from = isCollapsedAt(view, pos);
  if (from == null) return false;

  const info = getChunks(view.state);
  const sibs = mergeViewSiblings(view);

  view.dispatch({ effects: uncollapseUnchanged.of(from) });

  if (sibs && info) {
    const other = sibs.a === view ? sibs.b : sibs.a;
    if (other && other !== view) {
      other.dispatch({ effects: uncollapseUnchanged.of(mapPos(from, info.chunks, info.side === 'a')) });
    }
  }

  // Centre rather than the default nearest edge: nearest scrolls a just-revealed
  // match to the bottom border of the viewport, which in a two-column diff full
  // of fold strips is the hardest place on screen to notice anything.
  requestAnimationFrame(() => {
    try {
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    } catch {
      /* view torn down between frames */
    }
  });

  return true;
}
