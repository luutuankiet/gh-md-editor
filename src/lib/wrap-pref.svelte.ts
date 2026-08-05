// One word-wrap preference, shared by every text surface in the app: the
// markdown cockpit, the code editor, both diff panes, the four merge panes and
// the search results.
//
// These used to be four independent localStorage keys with three different
// value encodings, so turning wrap on in the diff left the code editor
// unwrapped and the choice a user had just made looked like it was ignored.
//
// A module-level rune rather than a Svelte store: every consumer already runs
// in runes mode, so `wrapPref.on` reads directly in markup and effects with no
// subscribe/unsubscribe bookkeeping.

const KEY = 'ghmd.wrap';

// Superseded keys with the encodings they used, in adoption order. Read once at
// startup so an existing preference survives the merge rather than silently
// resetting, then deleted so this cannot run a second time.
const LEGACY: [string, (v: string) => boolean][] = [
  ['gmd:wrap', (v) => v !== 'off'],
  ['ghmd.codeWrap', (v) => v === 'on'],
  ['ghmd.mergeWrap', (v) => v === 'on'],
  ['ghmd.diffWrap', (v) => v === '1'],
];

function load(): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== null) return stored === 'on';
    let seeded: boolean | null = null;
    for (const [key, decode] of LEGACY) {
      const old = localStorage.getItem(key);
      if (old !== null && seeded === null) seeded = decode(old);
      localStorage.removeItem(key);
    }
    if (seeded !== null) {
      localStorage.setItem(KEY, seeded ? 'on' : 'off');
      return seeded;
    }
  } catch {
    // Private mode, or no DOM at all: fall through to the default.
  }
  // On by default. This started as a markdown editor and prose running off the
  // right edge is the worse failure; the code surfaces that want columns are
  // one click from getting them back.
  return true;
}

let on = $state(load());

function set(next: boolean) {
  if (next === on) return;
  on = next;
  try { localStorage.setItem(KEY, next ? 'on' : 'off'); } catch { /* private mode */ }
}

// A second tab on the same workspace is the same person with the same
// preference. `storage` fires only in the tabs that did not do the writing,
// which is exactly the set that needs telling.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY && e.newValue !== null) on = e.newValue === 'on';
  });
}

export const wrapPref = {
  get on() { return on; },
  set,
  toggle() { set(!on); },
};
