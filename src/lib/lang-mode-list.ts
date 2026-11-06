import { LANGS } from './lang-detect';

// The rows of the Change Language Mode list, in the order they show: Auto
// Detect, plain text, then every grammar by name. Shared by the top-right
// button in a code editor and the palette command, which open the same list.

// The editor's name for "no grammar". Stored as a pick like any language name,
// so choosing it pins plain text rather than handing the tab back to detection.
export const PLAIN_TEXT = 'plain text';

export interface LangMode {
  // What the picker hands back: a language name, PLAIN_TEXT, or null for Auto
  // Detect.
  value: string | null;
  label: string;
  // Lowercased name plus aliases, what the filter matches against.
  terms: string[];
}

// VS Code prints `Name (id)`. The library has no id field, so use the alias that
// spells the name (`javascript` for JavaScript), else the first alias.
function idOf(name: string, alias: readonly string[]): string {
  const lower = name.toLowerCase();
  return alias.find((a) => a.toLowerCase() === lower) ?? alias[0] ?? lower;
}

const MODES: LangMode[] = [
  { value: null, label: 'Auto Detect', terms: ['auto detect'] },
  { value: PLAIN_TEXT, label: PLAIN_TEXT, terms: [PLAIN_TEXT] },
  ...[...LANGS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => ({
      value: l.name,
      label: `${l.name} (${idOf(l.name, l.alias)})`,
      terms: [l.name.toLowerCase(), ...l.alias.map((a) => a.toLowerCase())],
    })),
];

// Case-insensitive substring match on the name or any alias, so `sh` finds
// Shell through its `sh` alias and `pyth` finds Python.
export function filterLangModes(term: string): LangMode[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return MODES;
  return MODES.filter((m) => m.terms.some((t) => t.includes(needle)));
}
