// Syntax highlighting for the diff views, on the same engine the preview pane
// uses (starry-night = GitHub's own TextMate grammars), so a diff and a
// rendered code block colour identically.
//
// Why not CodeMirror: a diff side is not a document. Its lines are
// non-contiguous slices of two different file versions, so a CM6 parse tree
// would be wrong at every hunk boundary. starry-night highlights a string and
// hands back a hast tree, which is exactly the shape this needs.
import '@wooorm/starry-night/style/both';
import { common, createStarryNight } from '@wooorm/starry-night';

export interface Tok {
  cls: string | null;
  text: string;
}

type StarryNight = Awaited<ReturnType<typeof createStarryNight>>;

let snPromise: Promise<StarryNight> | null = null;
function sn(): Promise<StarryNight> {
  if (!snPromise) snPromise = createStarryNight(common);
  return snPromise;
}

// `common` is ~35 grammars, not all of them. These extensions are not in it but
// are close enough to one that is that highlighting beats plain text.
const ALIAS: Record<string, string> = {
  '.svelte': '.html',
  '.vue': '.html',
  '.mjs': '.js',
  '.cjs': '.js',
  '.mts': '.ts',
  '.cts': '.ts',
  '.jsonc': '.json',
  '.mdx': '.md',
};

export async function scopeForFilename(p: string): Promise<string | null> {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // Dotfiles (.gitignore) have no extension to key on; treat as plain.
  if (dot <= 0) return null;
  const ext = base.slice(dot).toLowerCase();
  try {
    const s = await sn();
    return s.flagToScope(ALIAS[ext] ?? ext) ?? null;
  } catch {
    return null;
  }
}

// Highlight a multi-line string and return one token list per line. Tokens
// carry the full ancestor class stack, which is what starry-night's stylesheet
// keys on (.pl-k, .pl-s, …).
export async function highlightToLines(text: string, scope: string): Promise<Tok[][]> {
  const lines: Tok[][] = [[]];
  try {
    const s = await sn();
    walk(s.highlight(text, scope), [], lines);
  } catch {
    // Grammar failure must never blank the diff — callers fall back to plain
    // text when a line has no tokens.
    return [];
  }
  return lines;
}

function walk(node: unknown, stack: string[], lines: Tok[][]): void {
  const children = (node as { children?: unknown[] }).children ?? [];
  for (const child of children) {
    const c = child as { type?: string; value?: string; properties?: { className?: unknown } };
    if (c.type === 'text') {
      // A newline inside a token (block comment, template literal) closes the
      // current line and opens the next while keeping the class stack.
      const parts = String(c.value ?? '').split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lines.push([]);
        if (parts[i]) lines[lines.length - 1].push({ cls: stack.join(' ') || null, text: parts[i] });
      }
    } else if (c.type === 'element') {
      const raw = c.properties?.className ?? [];
      const cls = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      walk(child, [...stack, ...cls], lines);
    }
  }
}
