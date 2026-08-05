<script lang="ts" module>
  export interface PaneAction {
    label: string;
    title: string;
    run: () => void;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { EditorView, Decoration, WidgetType, lineNumbers } from '@codemirror/view';
  import { EditorState, Compartment, RangeSet } from '@codemirror/state';
  import type { Extension } from '@codemirror/state';
  import { grammarFor } from '../../lib/lang-detect';
  import { monokaiCodeBundle } from '../../lib/monokai-dimmed';

  let {
    text,
    filename,
    span = null,
    wrap = false,
    actions = [],
    reveal = 0,
    onview = undefined,
    onscroll = undefined,
  }: {
    text: string;
    filename: string;
    // Offsets into `text` of the conflicting region, or null when this side
    // has no counterpart for the selected conflict.
    span?: [number, number] | null;
    wrap?: boolean;
    // Rendered as a codelens strip directly above the highlighted region.
    // Kept referentially stable by the caller so the decoration is rebuilt
    // when the conflict changes rather than on every keystroke.
    actions?: PaneAction[];
    // Bumped by the caller to re-scroll to `span`; a bare span comparison
    // would not fire again after the user scrolled away by hand.
    reveal?: number;
    onview?: (v: EditorView | null) => void;
    onscroll?: (v: EditorView) => void;
  } = $props();

  let host: HTMLDivElement;
  let view = $state<EditorView | null>(null);

  const langCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const decoCompartment = new Compartment();

  // A block widget rather than a Svelte element so it participates in
  // CodeMirror's own layout: the strip pushes the conflicting lines down
  // instead of floating over them, which is what keeps the three panes
  // readable side by side.
  class ActionsWidget extends WidgetType {
    // Fields declared rather than taken as parameter properties: the Svelte
    // compiler parses this block itself and rejects that TypeScript shorthand.
    items: PaneAction[];
    key: string;
    constructor(items: PaneAction[], key: string) {
      super();
      this.items = items;
      this.key = key;
    }
    // Without this the widget is torn down and rebuilt on every reconfigure,
    // which loses a click already in flight.
    eq(other: ActionsWidget) { return other.key === this.key; }
    toDOM() {
      const strip = document.createElement('div');
      strip.className = 'cm-mergeActions';
      for (const a of this.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        b.title = a.title;
        b.disabled = a.disabled === true;
        // The pane is not editable, but a mousedown still moves focus and
        // scrolls the view before the click lands.
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => { e.preventDefault(); a.run(); });
        strip.appendChild(b);
      }
      return strip;
    }
    ignoreEvent() { return false; }
  }

  function buildDeco(v: EditorView, sp: [number, number] | null, acts: PaneAction[], key: string): Extension {
    if (!sp) return [];
    const doc = v.state.doc;
    const from = Math.min(Math.max(0, sp[0]), doc.length);
    const to = Math.min(Math.max(from, sp[1]), doc.length);
    const startLine = doc.lineAt(from);
    const ranges = [];
    if (acts.length) {
      ranges.push(Decoration.widget({ widget: new ActionsWidget(acts, key), block: true, side: -1 }).range(startLine.from));
    }
    // Line decorations rather than one mark across the whole region: a mark
    // paints only as wide as its text, so short lines would leave the block
    // looking ragged instead of like a band.
    const lastLine = doc.lineAt(to > from ? to - 1 : from);
    for (let n = startLine.number; n <= lastLine.number; n++) {
      ranges.push(Decoration.line({ class: 'cm-conflictLine' }).range(doc.line(n).from));
    }
    if (to > from) ranges.push(Decoration.mark({ class: 'cm-conflictHit' }).range(from, to));
    return EditorView.decorations.of(RangeSet.of(ranges, true));
  }

  // Zero reactive reads: every dependency is untracked, so this runs once and
  // never restacks a second EditorView on top of the first.
  $effect(() => {
    const v = new EditorView({
      state: EditorState.create({
        doc: untrack(() => text),
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          monokaiCodeBundle,
          langCompartment.of([]),
          wrapCompartment.of(untrack(() => wrap) ? EditorView.lineWrapping : []),
          decoCompartment.of([]),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: '12px', lineHeight: '1.5' },
            '.cm-conflictLine': { backgroundColor: 'rgba(229, 133, 32, 0.13)' },
            '.cm-conflictHit': { backgroundColor: 'rgba(229, 133, 32, 0.22)', outline: '1px solid rgba(229, 133, 32, 0.55)' },
            '.cm-mergeActions': {
              display: 'flex',
              gap: '10px',
              padding: '1px 8px',
              fontSize: '11px',
              lineHeight: '1.6',
              background: 'rgba(229, 133, 32, 0.08)',
              borderTop: '1px solid rgba(229, 133, 32, 0.3)',
            },
            '.cm-mergeActions button': {
              font: 'inherit',
              color: '#e58520',
              background: 'transparent',
              border: 'none',
              padding: '0',
              cursor: 'pointer',
            },
            '.cm-mergeActions button:hover:not(:disabled)': { textDecoration: 'underline' },
            '.cm-mergeActions button:disabled': { color: '#6e7681', cursor: 'default' },
          }),
        ],
      }),
      parent: host,
    });
    view = v;
    untrack(() => onview?.(v));
    const scroller = v.scrollDOM;
    const relay = () => untrack(() => onscroll?.(v));
    scroller.addEventListener('scroll', relay, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', relay);
      untrack(() => onview?.(null));
      v.destroy();
      view = null;
    };
  });

  $effect(() => {
    const t = text;
    const v = view;
    if (!v) return;
    if (untrack(() => v.state.doc.toString()) === t) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
  });

  $effect(() => {
    const name = filename;
    const v = view;
    if (!v) return;
    let live = true;
    void grammarFor(name).then((ext) => {
      if (live && view) view.dispatch({ effects: langCompartment.reconfigure(ext) });
    });
    return () => { live = false; };
  });

  $effect(() => {
    const w = wrap;
    const v = view;
    if (!v) return;
    v.dispatch({ effects: wrapCompartment.reconfigure(w ? EditorView.lineWrapping : []) });
  });

  $effect(() => {
    const sp = span;
    const acts = actions;
    const v = view;
    if (!v) return;
    const key = `${sp ? `${sp[0]}:${sp[1]}` : 'none'}|${acts.map((a) => `${a.label}${a.disabled ? '-' : '+'}`).join(',')}`;
    v.dispatch({ effects: decoCompartment.reconfigure(buildDeco(v, sp, acts, key)) });
  });

  $effect(() => {
    void reveal;
    const sp = span;
    const v = view;
    if (!v || !sp) return;
    const pos = Math.min(Math.max(0, sp[0]), v.state.doc.length);
    // Deferred: a view created in this same tick has not measured yet, and an
    // unmeasured scrollIntoView lands on the wrong row.
    queueMicrotask(() => {
      if (view === v) v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    });
  });
</script>

<div class="cmhost" bind:this={host}></div>

<style>
  .cmhost {
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
</style>
