// Pure helpers for the server-mode tab strip. No DOM, no Svelte: both take
// plain values so a test runner could cover them without a browser.

/**
 * Folder label for each tab of ONE editor group, keyed by tab path.
 *
 * A file name that is unique within the group gets no label at all. Tabs that
 * share a name get the shortest trailing slice of their folder path that no
 * other same-named tab shares at the same depth — `docs` vs `src`, or
 * `a/lib` vs `b/lib`. Synthetic tabs (any path containing ':') are skipped and
 * always get ''. Comparison is per group, as VS Code does it.
 */
export function tabDirLabels(paths: string[], folder: string): Map<string, string> {
  const out = new Map<string, string>();
  const byName = new Map<string, string[][]>();
  const dirsOf = new Map<string, string[]>();
  for (const p of paths) {
    out.set(p, '');
    if (!p || p.includes(':')) continue;
    const rel = folder && p.startsWith(`${folder}/`) ? p.slice(folder.length + 1) : p;
    const segs = rel.split('/').filter(Boolean);
    const name = segs.pop() ?? rel;
    dirsOf.set(p, segs);
    const bucket = byName.get(name);
    if (bucket) bucket.push(segs);
    else byName.set(name, [segs]);
  }
  const tail = (segs: string[], k: number) => segs.slice(Math.max(0, segs.length - k)).join('/');
  for (const p of paths) {
    const segs = dirsOf.get(p);
    if (!segs) continue;
    const name = p.slice(p.lastIndexOf('/') + 1);
    const peers = (byName.get(name) ?? []).filter((s) => s !== segs);
    if (peers.length === 0 || segs.length === 0) continue;
    let k = 1;
    while (k < segs.length && peers.some((o) => tail(o, k) === tail(segs, k))) k++;
    out.set(p, tail(segs, k));
  }
  return out;
}

export interface SlotRect { left: number; right: number; top: number; bottom: number }

/**
 * Insertion index for a dragged tab, given the pointer and every tab's rect in
 * strip order. Row-aware, because once the strip wraps an x-only comparison
 * picks a slot on the wrong row: find the row whose vertical band holds the
 * pointer, then the first tab in that row whose midpoint is right of it; past
 * the last tab of a row means just after that tab. Above the first row counts
 * as the first row; below the last row means the end of the strip.
 */
export function dropSlot(x: number, y: number, rects: SlotRect[]): number {
  if (rects.length === 0) return 0;
  // Rows in order: consecutive tabs sharing a top edge (2px slack for borders).
  const rows: { start: number; end: number; top: number; bottom: number }[] = [];
  rects.forEach((r, i) => {
    const row = rows[rows.length - 1];
    if (row && Math.abs(r.top - row.top) <= 2) {
      row.end = i;
      row.bottom = Math.max(row.bottom, r.bottom);
    } else rows.push({ start: i, end: i, top: r.top, bottom: r.bottom });
  });
  if (y >= rows[rows.length - 1].bottom) return rects.length;
  const row = rows.find((r) => y < r.bottom) ?? rows[rows.length - 1];
  for (let i = row.start; i <= row.end; i++) {
    const r = rects[i];
    if (x < r.left + (r.right - r.left) / 2) return i;
  }
  return row.end + 1;
}
