import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';

// Hides the value half of every `KEY=value` line behind a pill, so a .env file
// can be opened on a shared screen without leaking the secrets in it. Purely
// visual: the document is untouched, so copying, searching and saving all still
// see the real text. Anything else would be a lie the editor could not keep.

// Whether the whole file is cloaked. Dispatched by the editor when the filename
// says .env, and by the palette toggle.
export const setCloak = StateEffect.define<boolean>();
// One line back into the clear, from clicking its pill.
export const revealCloakLine = StateEffect.define<number>();

type CloakState = { on: boolean; revealed: ReadonlySet<number> };

export const cloakState = StateField.define<CloakState>({
  create: () => ({ on: false, revealed: new Set<number>() }),
  update(value, tr) {
    let next = value;
    let touched = false;
    for (const e of tr.effects) {
      // Re-cloaking forgets every reveal: leaving them remembered would mean a
      // file that looks protected while three lines are still readable.
      if (e.is(setCloak)) { next = { on: e.value, revealed: new Set<number>() }; touched = true; }
      else if (e.is(revealCloakLine)) {
        const revealed = new Set(next.revealed);
        if (revealed.has(e.value)) revealed.delete(e.value);
        else revealed.add(e.value);
        next = { on: next.on, revealed };
        touched = true;
      }
    }

    // A reveal lasts exactly as long as the cursor stays on the line it
    // uncovered. Without this the file quietly accumulates readable lines: one
    // click each, none of them ever covered again until the whole file is
    // toggled. Skipped on the transaction that did the revealing, whose
    // selection is the one being moved onto the line.
    if (!touched && next.revealed.size && (tr.selection || tr.docChanged)) {
      const live = new Set<number>();
      for (const r of tr.state.selection.ranges) {
        const n = tr.state.doc.lineAt(r.head).number;
        if (next.revealed.has(n)) live.add(n);
      }
      if (live.size !== next.revealed.size) next = { on: next.on, revealed: live };
    }
    return next;
  },
});

export function isCloaked(state: { field: (f: typeof cloakState, req: false) => CloakState | undefined }): boolean {
  return state.field(cloakState, false)?.on ?? false;
}

class CloakWidget extends WidgetType {
  constructor(readonly len: number) {
    super();
  }
  eq(other: CloakWidget) {
    return other.len === this.len;
  }
  toDOM(view: EditorView) {
    const span = document.createElement('span');
    span.className = 'cm-env-cloak';
    // Length is suggested, not mirrored: a pill exactly as wide as the secret
    // leaks its length, and one fixed width makes a file of short flags look
    // like a file of long keys.
    span.textContent = '•'.repeat(Math.min(10, Math.max(3, Math.round(this.len / 3))));
    span.title = 'Value hidden — click to reveal';
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(span);
      // The reveal is anchored to the cursor, so the click has to place one —
      // otherwise the value would uncover under a cursor parked on some other
      // line and vanish again on the very next keystroke.
      view.dispatch({
        effects: revealCloakLine.of(view.state.doc.lineAt(pos).number),
        selection: { anchor: pos },
      });
      view.focus();
    });
    return span;
  }
  // The widget handles its own click; CodeMirror must not also try to place a
  // cursor inside a range that is not really there.
  ignoreEvent() {
    return true;
  }
}

function build(view: EditorView): DecorationSet {
  const st = view.state.field(cloakState, false);
  if (!st?.on) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      if (st.revealed.has(line.number)) continue;

      const text = line.text;
      const lead = text.trimStart();
      if (!lead || lead.startsWith('#')) continue;
      const eq = text.indexOf('=');
      if (eq === -1) continue;

      // Keys stay visible — knowing which variables a file defines is the
      // reason to open it at all. Only the right-hand side is covered.
      let start = eq + 1;
      while (start < text.length && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;
      let end = text.length;
      while (end > start && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
      if (end <= start) continue;

      builder.add(line.from + start, line.from + end, Decoration.replace({ widget: new CloakWidget(end - start) }));
    }
  }
  return builder.finish();
}

const theme = EditorView.baseTheme({
  '.cm-env-cloak': {
    padding: '0 5px',
    borderRadius: '3px',
    background: '#3a3a3a',
    color: '#949494',
    letterSpacing: '1px',
    cursor: 'pointer',
  },
  '.cm-env-cloak:hover': { background: '#505050', color: '#c5c8c6' },
  '&light .cm-env-cloak': { background: '#dcdcdc', color: '#6e7681' },
});

export const dotenvCloak = [
  cloakState,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        // The field allocates a new value only when the cloak really changed, so
        // identity is the whole test — it catches the toggle, a click, and a
        // reveal expiring because the cursor walked off its line.
        const moved = u.startState.field(cloakState, false) !== u.state.field(cloakState, false);
        if (u.docChanged || u.viewportChanged || moved) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
  theme,
];
