import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';
import { dotenvLanguage } from './lang-dotenv';

// One list, every consumer: the language picker's names, the picker's lookup,
// filename auto-detection in the editor, and the grammar the diff views load.
// Anything appended here has to be visible to all of them, or the picker and
// the detector disagree about what exists.
export const LANGS = [dotenvLanguage, ...languages];

// Extensions @codemirror/language-data ships no grammar for. Without an entry
// here `matchFilename` returns null and the document renders as unhighlighted
// plain text — which is exactly what a .svelte diff used to look like.
//
// Each maps to the closest grammar that IS present. The single-file component
// formats are HTML documents whose <script> and <style> blocks the HTML grammar
// already delegates to JavaScript and CSS, so the bulk of the file highlights
// correctly; only the template control-flow blocks stay uncoloured.
const EXT_ALIAS: Record<string, string> = {
  svelte: 'html',
  astro: 'html',
  vue: 'html',
  mdx: 'md',
  jsonc: 'json',
  json5: 'json',
};

// Resolve by real filename first so anything the library knows about wins, and
// only then retry through the alias table. The retry goes back through
// matchFilename with a synthetic name rather than matching on language name:
// extensions are the stable identifier, display names are not.
export function describeFor(name: string): LanguageDescription | null {
  const direct = LanguageDescription.matchFilename(LANGS, name);
  if (direct) return direct;
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase();
  const alias = ext ? EXT_ALIAS[ext] : undefined;
  return alias ? LanguageDescription.matchFilename(LANGS, `f.${alias}`) : null;
}

// An empty extension array is a valid CodeMirror extension, so an unknown file
// type degrades to no highlighting rather than throwing.
export async function grammarFor(name: string): Promise<Extension> {
  const desc = describeFor(name);
  return desc ? await desc.load() : [];
}

// ---------------------------------------------------------------------------
// Content detection, for a buffer whose filename maps to no language: an
// untitled buffer, or an extensionless script. Two stages, cheapest first: the
// shebang line, which is certain when present, then a small model that guesses
// from the text. Everything below is pure and synchronous; the model itself
// runs in a worker, see lang-model.ts.

// Every tunable of the detection pipeline in one place.
export const DETECT = {
  // Accept the model's top guess at or above this confidence. The model's
  // scores run low even when it is right (a clear bash script scores about
  // 0.39, a clear Go file about 0.27), which is why this is not 0.5.
  minConfidence: 0.2,
  // ...or when it leads the runner-up by at least this factor.
  minLead: 2,
  // Quiet time after the last keystroke before detection runs.
  debounceMs: 600,
  // Only the head of the buffer is sent. Time grows with length (47 KB of
  // python took about 220 ms) while the guess stops improving long before.
  maxChars: 10_240,
  // Below this many non-blank characters the model is not consulted, and not
  // even loaded. The package itself refuses shorter input. A shebang still
  // counts at any length.
  minModelChars: 20,
} as const;

// The model's short ids, mapped to `LANGS` names. Ids with no grammar in the
// catalogue (bat, csv, dm, ex, makefile, prolog) are left out on purpose: a
// guess that cannot be highlighted is no better than keeping what we have.
export const MODEL_LANG: Record<string, string> = {
  asm: 'Gas',
  c: 'C',
  cs: 'C#',
  cpp: 'C++',
  clj: 'Clojure',
  cmake: 'CMake',
  cbl: 'Cobol',
  coffee: 'CoffeeScript',
  css: 'CSS',
  dart: 'Dart',
  dockerfile: 'Dockerfile',
  erl: 'Erlang',
  f90: 'Fortran',
  go: 'Go',
  groovy: 'Groovy',
  hs: 'Haskell',
  html: 'HTML',
  ini: 'Properties files',
  java: 'Java',
  js: 'JavaScript',
  json: 'JSON',
  jl: 'Julia',
  kt: 'Kotlin',
  lisp: 'Common Lisp',
  lua: 'Lua',
  md: 'Markdown',
  matlab: 'Octave',
  mm: 'Objective-C',
  ml: 'OCaml',
  pas: 'Pascal',
  pm: 'Perl',
  php: 'PHP',
  ps1: 'PowerShell',
  py: 'Python',
  r: 'R',
  rb: 'Ruby',
  rs: 'Rust',
  scala: 'Scala',
  sh: 'Shell',
  sql: 'SQL',
  swift: 'Swift',
  tex: 'LaTeX',
  toml: 'TOML',
  ts: 'TypeScript',
  v: 'Verilog',
  vba: 'VBScript',
  xml: 'XML',
  yaml: 'YAML',
};

// Interpreter basename, version suffix already stripped, to a `LANGS` name.
const SHEBANG_LANG: Record<string, string> = {
  bash: 'Shell',
  sh: 'Shell',
  zsh: 'Shell',
  ksh: 'Shell',
  mksh: 'Shell',
  dash: 'Shell',
  ash: 'Shell',
  python: 'Python',
  pypy: 'Python',
  node: 'JavaScript',
  nodejs: 'JavaScript',
  deno: 'JavaScript',
  bun: 'JavaScript',
  ruby: 'Ruby',
  perl: 'Perl',
  php: 'PHP',
  lua: 'Lua',
  luajit: 'Lua',
  pwsh: 'PowerShell',
  powershell: 'PowerShell',
};

// `#!/usr/bin/env X`, `#!/usr/bin/env -S X --flag` or `#!/path/to/X`, with
// interpreter version suffixes stripped (python3.12, ruby2.7, lua5.4). Reads
// line 1 only. Null when there is no shebang or the interpreter is unknown.
export function shebangLang(text: string): string | null {
  if (!text.startsWith('#!')) return null;
  const nl = text.indexOf('\n');
  const line = (nl === -1 ? text : text.slice(0, nl)).slice(2).trim();
  const words = line.split(/\s+/).filter(Boolean);
  let prog = words[0] ?? '';
  if (prog.split('/').pop() === 'env') {
    // Skip env's own flags (-S, -i) and any NAME=value before the program.
    prog = words.slice(1).find((w) => !w.startsWith('-') && !w.includes('=')) ?? '';
  }
  const base = prog.split('/').pop()?.toLowerCase() ?? '';
  const bare = base.replace(/[-_.]?\d[\d.]*$/, '');
  return SHEBANG_LANG[bare] ?? null;
}

export interface ModelGuess {
  languageId: string;
  confidence: number;
}

// The acceptance rule. Given the model's guesses, best first, return the
// `LANGS` name to switch to, or null to keep the current language. Guesses
// whose id has no grammar are dropped before ranking, so they can neither win
// nor count as the runner-up.
export function acceptGuess(guesses: readonly ModelGuess[]): string | null {
  const ranked = guesses.filter((g) => g.languageId in MODEL_LANG);
  const [top, next] = ranked;
  if (!top) return null;
  // JavaScript and TypeScript look alike to the model and score close together
  // and low (js 0.09, ts 0.08 on a plain JS sample), so neither would pass the
  // rule below. TypeScript's grammar highlights JavaScript correctly and the
  // reverse is not true, so a near-tie goes to TypeScript.
  const pair = next ? [top.languageId, next.languageId].sort().join() : '';
  if (pair === 'js,ts' && top.confidence < next.confidence * DETECT.minLead) {
    return MODEL_LANG.ts;
  }
  const leads = !next || top.confidence >= next.confidence * DETECT.minLead;
  return top.confidence >= DETECT.minConfidence || leads ? MODEL_LANG[top.languageId] : null;
}

// What detection should do with this text, short of the model: a shebang
// answer, a request to run the model, or nothing (too short to guess from).
export function detectPlan(text: string): { lang: string } | 'model' | null {
  const head = text.slice(0, DETECT.maxChars);
  const sb = shebangLang(head);
  if (sb) return { lang: sb };
  return head.replace(/\s+/g, '').length >= DETECT.minModelChars ? 'model' : null;
}
