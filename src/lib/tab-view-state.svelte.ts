// Per-tab view state for the IDE shell: word wrap, diff view mode and scroll
// position, remembered per tab and persisted per workspace.
//
// The shell renders a group's active tab inside a `{#key}` block, so switching
// tabs destroys the component and rebuilds it from the buffer text. Everything
// the editor itself owns dies with it — the scroll offset, the current value of
// the wrap compartment, the fold state. Keeping the parts worth remembering out
// here, keyed by the tab's path, is what lets them survive both a tab switch
// and a reload.
//
// Wrap and diff view mode are stored as OVERRIDES. A tab nobody has toggled
// reads the app-wide default instead (`wrap-pref.svelte.ts`, `ghmd.diffView`),
// so a fresh workspace still behaves as one shared setting right up to the
// point where the user disagrees with it on a specific tab.
//
// Deliberately a separate localStorage key from the session snapshot: that
// snapshot re-serializes every open tab including up to half a megabyte of
// unsaved draft per tab, and scroll fires far more often than keystrokes.

import { wrapPref } from './wrap-pref.svelte';

export type DiffViewMode = 'split' | 'inline' | 'hunks';

export interface TabViewState {
  // Absent means "follow the app-wide default", which is not the same as false.
  wrap?: boolean;
  diffView?: DiffViewMode;
  // A syntax language picked by hand, which outranks whatever the filename
  // implies. Load-bearing for a buffer that has no filename yet: the pick is
  // the only thing recording what the text is, so losing it on a tab switch
  // dropped the whole document back to plain text.
  lang?: string;
  // A document line plus the pixel remainder inside it, for CodeMirror
  // surfaces. A raw pixel offset stops pointing at the same text the moment
  // wrap or font size changes, and wrap is now per-tab and can differ from what
  // it was when the offset was written.
  anchor?: { line: number; off: number };
  // Plain-DOM scrollers with no document behind them — the markdown preview,
  // the hunk columns, the commit rows — have nothing to anchor to, so they keep
  // pixels. `aux` is the second scroller in the tabs that have two.
  px?: number;
  aux?: number;
}

interface Stored {
  v: 1;
  order: string[];
  tabs: Record<string, TabViewState>;
}

// Set once by the IDE shell. The GitHub Pages and VS Code builds never call
// init, so every lookup there misses and falls through to the app-wide default,
// which is exactly the behaviour they had before any of this existed.
let scope: string | null = null;
let tabs = $state<Record<string, TabViewState>>({});
// Least-recently-touched first. A workspace accumulates one entry per file ever
// opened, and the origin's whole localStorage budget is a few megabytes.
let order: string[] = [];
const CAP = 300;

function storageKey() {
  return `ghmd.tabview:${scope ?? ''}`;
}

function adopt(raw: string) {
  const parsed = JSON.parse(raw) as Stored;
  if (parsed?.v !== 1 || !parsed.tabs) return;
  tabs = parsed.tabs;
  order = (parsed.order ?? Object.keys(parsed.tabs)).filter((k) => k in parsed.tabs);
}

export function initTabViewState(folder: string) {
  if (scope === folder) return;
  scope = folder;
  tabs = {};
  order = [];
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw) adopt(raw);
  } catch {
    // Private mode, or a torn write from an older version: start clean rather
    // than take the whole shell down over a cache.
    tabs = {};
    order = [];
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  if (scope === null) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const payload: Stored = { v: 1, order, tabs };
    try { localStorage.setItem(storageKey(), JSON.stringify(payload)); } catch { /* quota — drop */ }
  }, 300);
}

// Called on every write so the eviction order reflects use, not creation.
function touch(key: string) {
  const at = order.indexOf(key);
  if (at !== -1) order.splice(at, 1);
  order.push(key);
  while (order.length > CAP) {
    const evicted = order.shift();
    if (evicted !== undefined && evicted !== key) delete tabs[evicted];
  }
}

export function patchTabView(key: string, patch: Partial<TabViewState>) {
  if (!key || scope === null) return;
  tabs[key] = { ...(tabs[key] ?? {}), ...patch };
  touch(key);
  persist();
}

export function tabViewOf(key: string): TabViewState | undefined {
  return key ? tabs[key] : undefined;
}

// Reactive: reads `tabs`, so a toggle anywhere settles every pane in that tab.
export function wrapFor(key: string): boolean {
  const own = key ? tabs[key]?.wrap : undefined;
  return own ?? wrapPref.on;
}

export function setWrapFor(key: string, on: boolean) {
  // No tab to attach the override to — the surfaces outside the IDE shell, and
  // the sidebar panels — so this is the app-wide default being set directly.
  if (!key || scope === null) { wrapPref.set(on); return; }
  patchTabView(key, { wrap: on });
}

export function toggleWrapFor(key: string) {
  setWrapFor(key, !wrapFor(key));
}

export function diffViewFor(key: string, fallback: DiffViewMode): DiffViewMode {
  const own = key ? tabs[key]?.diffView : undefined;
  return own ?? fallback;
}

// Save As turns a synthetic `untitled:` key into a real path. Carrying the
// state across keeps the tab from visibly resetting the moment it gains a name.
export function renameTabView(from: string, to: string) {
  const state = from ? tabs[from] : undefined;
  if (!state || from === to) return;
  tabs[to] = state;
  delete tabs[from];
  const at = order.indexOf(from);
  if (at !== -1) order[at] = to;
  persist();
}

// A second browser tab on the same workspace is the same person, same as the
// app-wide default already assumes. `storage` fires only in the tabs that did
// not do the writing, which is the set that needs telling.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (scope === null || e.key !== storageKey() || e.newValue === null) return;
    try { adopt(e.newValue); } catch { /* torn write — keep what we have */ }
  });
}
