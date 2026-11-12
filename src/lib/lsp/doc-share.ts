// One file, several editors, one text. A tab's editor and a peek showing the
// same file are separate CodeMirror views; this keeps their documents equal by
// replaying each edit in the others, and lets a peek reach the tab buffer of a
// file whose tab is open but not on screen (only the active tab of a group
// has a mounted editor). The shell registers itself as the host for that.

import { Annotation, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';

/** Marks a transaction replayed from another view of the same file. */
export const fromShare = Annotation.define<boolean>();

export interface ShareHost {
  /** The buffer of an open tab for `path`, or null when no tab has it. */
  content(path: string): string | null;
  /** Writes into an open tab's buffer; false when no tab has `path`. */
  setContent(path: string, text: string): boolean;
  /** Saves the open tab for `path`; false when no tab has it. */
  save(path: string): boolean;
}

type Role = 'main' | 'peek';
const views = new Map<string, Map<EditorView, Role>>();
let host: ShareHost | null = null;

export function setShareHost(h: ShareHost): () => void {
  host = h;
  return () => { if (host === h) host = null; };
}

function viewsOf(path: string) {
  let m = views.get(path);
  if (!m) views.set(path, (m = new Map()));
  return m;
}

/** True when a tab editor for `path` is mounted right now. */
export function hasMain(path: string): boolean {
  for (const role of views.get(path)?.values() ?? []) if (role === 'main') return true;
  return false;
}

/** The live text of `path`: a mounted editor first, then an open tab's buffer. */
export function liveText(path: string): string | null {
  const m = views.get(path);
  if (m) {
    let pick: EditorView | null = null;
    for (const [v, role] of m) if (!pick || role === 'main') pick = v;
    if (pick) return pick.state.doc.toString();
  }
  return host?.content(path) ?? null;
}

/** True when an open tab owns `path`, so its save is the tab's save. */
export function tabOwns(path: string): boolean {
  return hasMain(path) || host?.content(path) != null;
}

/** Replaces the buffer of the open tab for `path`; false when no tab has it. */
export function setTabText(path: string, text: string): boolean {
  return host?.setContent(path, text) ?? false;
}

export function saveViaTab(path: string): boolean {
  return host?.save(path) ?? false;
}

function forward(u: ViewUpdate, path: string) {
  const m = views.get(path);
  if (!m) return;
  const prevLen = u.startState.doc.length;
  let main = false;
  for (const [v, role] of m) {
    if (v === u.view) continue;
    if (role === 'main') main = true;
    // Equal lengths before the edit is the cheap sign the two documents agree;
    // when they do not, the whole text is copied instead of the change.
    const changes = v.state.doc.length === prevLen
      ? u.changes
      : { from: 0, to: v.state.doc.length, insert: u.state.doc };
    v.dispatch({ changes, annotations: fromShare.of(true) });
  }
  // A peek edit to a file whose tab is open in the background goes into that
  // tab's buffer, which is what marks the tab dirty.
  if (!main && m.get(u.view) === 'peek') host?.setContent(path, u.state.doc.toString());
}

/** Joins this view to the set of editors showing `path`. */
export function shareDoc(path: string, role: Role): Extension {
  return ViewPlugin.define((view) => {
    viewsOf(path).set(view, role);
    return {
      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        if (u.transactions.some((tr) => tr.annotation(fromShare))) return;
        // Dispatching into another view from inside this one's update is
        // allowed; the replayed transaction carries the annotation, so it
        // never bounces back.
        queueMicrotask(() => forward(u, path));
      },
      destroy() {
        const m = views.get(path);
        m?.delete(view);
        if (m && !m.size) views.delete(path);
      },
    };
  });
}
