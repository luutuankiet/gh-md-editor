// Per-pane theme state with localStorage persistence + system-pref resolution.
//
// Each of the three panes (editor / preview / outline) has an independent
// ThemeChoice: 'light' | 'dark' | 'auto'. 'auto' follows the OS
// prefers-color-scheme media query and updates live when it flips.
//
// Storage keys: gmd:theme:editor, gmd:theme:preview, gmd:theme:outline.
// Migration note: prior versions had no per-pane theme — all panes followed the
// OS via @media (prefers-color-scheme: dark). Absent storage keys default to
// 'auto', so existing users see no visual change until they click a toggle.

export type Pane = 'editor' | 'preview' | 'outline';
export type ThemeChoice = 'light' | 'dark' | 'auto';
export type EffectiveTheme = 'light' | 'dark';

const KEY = (p: Pane): string => `gmd:theme:${p}`;
const VALID: ReadonlySet<ThemeChoice> = new Set(['light', 'dark', 'auto']);

export function loadTheme(pane: Pane): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY(pane));
    if (v && VALID.has(v as ThemeChoice)) return v as ThemeChoice;
  } catch {
    /* storage may be disabled — fall through to default */
  }
  return 'auto';
}

export function saveTheme(pane: Pane, choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY(pane), choice);
  } catch {
    /* quota or disabled — silent fail, matches existing persistence.ts policy */
  }
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function resolveTheme(choice: ThemeChoice): EffectiveTheme {
  if (choice === 'light') return 'light';
  if (choice === 'dark') return 'dark';
  return systemPrefersDark() ? 'dark' : 'light';
}

// Cycle order matches what users expect from a single button: explicit choices
// first, fall back to 'auto'. light → dark → auto → light.
export function cycleTheme(c: ThemeChoice): ThemeChoice {
  if (c === 'light') return 'dark';
  if (c === 'dark') return 'auto';
  return 'light';
}

export function describeChoice(c: ThemeChoice): string {
  if (c === 'light') return 'Light';
  if (c === 'dark') return 'Dark';
  return 'Auto (system)';
}

// Subscribe to OS-level theme flips. Returns an unsubscribe fn. Used by the
// 'auto' code path so panes following the system pref update live.
export function onSystemThemeChange(cb: (dark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent): void => cb(e.matches);
  // addEventListener is the modern API; addListener is the legacy fallback for
  // Safari < 14. Both kept for browser-compat.
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler);
  else mq.addListener(handler);
  return () => {
    if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', handler);
    else mq.removeListener(handler);
  };
}
