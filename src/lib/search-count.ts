import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';

// The match counter that rides along inside CodeMirror's own find panel, so
// every find box in the app reports the same way with one registration each.
//
// It is deliberately a view plugin that writes into the panel's DOM rather than
// a Svelte overlay positioned next to it. The panel is built and destroyed by
// the search extension on its own schedule, it lives in three different
// surfaces (the markdown editor, the code tab, and both columns of a split
// diff), and in the diff case there are two independent panels alive at once.
// Anything anchored from outside would have to track all of that; a plugin is
// handed the right view by construction.

// A hard stop on enumeration. A one-character query against a large file can
// match tens of thousands of times and the walk happens on the main thread for
// every keystroke. Past the cap the badge says so with a trailing plus instead
// of quietly reporting a wrong total.
const CAP = 20000;

export interface Tally {
  total: number;
  index: number;
  capped: boolean;
}

export function tallyMatches(state: EditorState): Tally | null {
  const q = getSearchQuery(state);
  if (!q || !q.search || !q.valid) return null;
  const sel = state.selection.main;
  const cur = q.getCursor(state.doc);
  let total = 0;
  let index = 0;
  let next = cur.next();
  while (!next.done) {
    const r = next.value;
    total++;
    // The active match is the one the selection is sitting exactly on, which is
    // what stepping with Enter leaves behind. A query that has just been typed,
    // or a click into the text, has no active match -- and there the badge
    // reports a bare count, the same as VS Code does before the first step.
    if (index === 0 && r.from === sel.from && r.to === sel.to) index = total;
    if (total >= CAP) break;
    next = cur.next();
  }
  return { total, index, capped: total >= CAP };
}

export function tallyLabel(t: Tally | null): string {
  if (!t) return '';
  if (t.total === 0) return 'No results';
  const total = t.capped ? CAP + '+' : String(t.total);
  return t.index > 0 ? t.index + ' of ' + total : total + ' results';
}

class MatchCount implements PluginValue {
  private badge: HTMLElement | null = null;
  private queued = false;

  constructor(private readonly view: EditorView) {
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (
      u.docChanged ||
      u.selectionSet ||
      u.transactions.some((tr) => tr.effects.length > 0) ||
      searchPanelOpen(u.state) !== searchPanelOpen(u.startState)
    ) {
      this.sync();
    }
  }

  private schedule() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.sync();
    });
  }

  private sync() {
    const field = this.view.dom.querySelector('.cm-search input[name=search]');
    if (!field) {
      this.badge?.remove();
      this.badge = null;
      // Either the panel is closed, or this is the very update that opens it and
      // the search extension has not assembled its DOM yet. Nothing orders the
      // two plugins, so when the state says a panel should exist and the DOM
      // disagrees, look again next frame rather than waiting for a later edit.
      if (searchPanelOpen(this.view.state)) this.schedule();
      return;
    }
    if (!this.badge || !this.badge.isConnected) {
      this.badge = document.createElement('span');
      this.badge.className = 'cm-gmd-matchcount';
      // Straight after the query field, which is where the eye already is and
      // where VS Code puts it. The panel's children are created once in the
      // panel constructor and never rebuilt, so this survives every update.
      field.insertAdjacentElement('afterend', this.badge);
    }
    const text = tallyLabel(tallyMatches(this.view.state));
    if (this.badge.textContent !== text) this.badge.textContent = text;
  }

  destroy() {
    this.badge?.remove();
    this.badge = null;
  }
}

// currentColor and opacity only -- no palette of its own. The three host panes
// theme their find panels separately (and the diff hard-codes dark), so a badge
// carrying its own colours would be a fourth thing to keep in step and would
// read wrong on at least one of them.
const badgeTheme = EditorView.theme({
  '.cm-gmd-matchcount': {
    display: 'inline-block',
    minWidth: '58px',
    padding: '0 6px',
    fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
    fontSize: '11px',
    lineHeight: '1.6',
    color: 'currentColor',
    opacity: '0.7',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  },
});

export const matchCountBadge = [ViewPlugin.fromClass(MatchCount), badgeTheme];
