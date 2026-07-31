// One row in the quick-open modal, whatever the mode. Keeping the action on
// the item means the modal never has to know whether it is showing files,
// commands, folders or symbols — it renders and calls back.
export interface QoItem {
  key: string;
  label: string;
  // Secondary text, right-aligned: a path, a keybinding hint, a line number.
  detail?: string;
  // Icon URL (files) or a text glyph (commands, folders) — whichever is set.
  icon?: string;
  glyph?: string;
  run: () => void;
}

// Subsequence match, VS Code style: every character of the term must appear in
// order, not necessarily adjacently, so `apsv` finds `App-server.svelte`.
// Returns the matched indices (for highlighting) or null when it does not match.
export function fuzzyMatch(text: string, term: string): number[] | null {
  if (!term) return [];
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  const hits: number[] = [];
  let at = 0;
  for (const ch of needle) {
    const idx = haystack.indexOf(ch, at);
    if (idx < 0) return null;
    hits.push(idx);
    at = idx + 1;
  }
  return hits;
}

export interface Segment {
  text: string;
  hit: boolean;
}

// Collapse a label plus its matched indices into alternating runs, so the
// template can render matched characters in a highlight colour without
// emitting one element per character.
export function highlightSegments(label: string, term: string): Segment[] {
  const hits = fuzzyMatch(label, term);
  if (!hits || !hits.length) return [{ text: label, hit: false }];
  const marked = new Set(hits);
  const out: Segment[] = [];
  for (let i = 0; i < label.length; i++) {
    const hit = marked.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += label[i];
    else out.push({ text: label[i], hit });
  }
  return out;
}
