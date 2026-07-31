import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';

// Same shape as the markdown outline (src/lib/markdown.ts) so one renderer
// serves both: headings for .md tabs, declarations for code tabs.
// What a row actually is, so the panel can show the symbol icons VS Code does.
// Optional on purpose: markdown headings come from src/lib/markdown.ts without
// one and render as a heading-level chip instead.
export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'enum'
  | 'variable'
  | 'module'
  | 'rule';

export interface OutlineNode {
  level: number;
  text: string;
  line: number;
  kind?: SymbolKind;
  children: OutlineNode[];
}

// An allowlist, not a suffix heuristic. The obvious heuristic (anything ending
// in Declaration/Definition) drowns the panel: the TypeScript grammar names
// every bound identifier a `VariableDefinition`, so imports and interface
// fields each became a row. These are the node types that actually correspond
// to something a reader would call a symbol, across the grammars CodeMirror
// ships.
const KIND_BY_NODE: Record<string, SymbolKind> = {
  // JavaScript / TypeScript
  FunctionDeclaration: 'function', MethodDeclaration: 'function', MethodDefinition: 'function',
  ClassDeclaration: 'class',
  InterfaceDeclaration: 'interface', TypeAliasDeclaration: 'interface',
  EnumDeclaration: 'enum',
  NamespaceDeclaration: 'module', ModuleDeclaration: 'module',
  VariableDeclaration: 'variable', PropertyDeclaration: 'variable',
  // Python
  FunctionDefinition: 'function', ClassDefinition: 'class', DecoratedStatement: 'module',
  // Go
  FunctionDecl: 'function', MethodDecl: 'function',
  TypeDeclaration: 'interface', TypeSpec: 'interface',
  VarDeclaration: 'variable', ConstDeclaration: 'variable',
  // Rust
  FunctionItem: 'function',
  StructItem: 'class', TraitItem: 'interface', ImplItem: 'class', ModItem: 'module',
  EnumItem: 'enum',
  ConstItem: 'variable', StaticItem: 'variable', TypeItem: 'interface', MacroItem: 'function',
  // C / C++ / Java / C#
  StructSpecifier: 'class', ClassSpecifier: 'class', EnumSpecifier: 'enum',
  FieldDeclaration: 'variable', ConstructorDeclaration: 'function',
  // CSS
  RuleSet: 'rule', KeyframesStatement: 'rule',
};

const DECL = new Set(Object.keys(KIND_BY_NODE));

// Keyword -> kind for the grammar-less fallback path.
const KIND_BY_KEYWORD: Record<string, SymbolKind> = {
  function: 'function', def: 'function', fn: 'function', func: 'function',
  sub: 'function', proc: 'function',
  class: 'class', struct: 'class', impl: 'class',
  interface: 'interface', type: 'interface', trait: 'interface',
  enum: 'enum',
  module: 'module', namespace: 'module',
  const: 'variable', let: 'variable', var: 'variable',
};

// `const load = async () => {}` is a VariableDeclaration to the grammar but a
// function to a reader. Promote it, the way VS Code's outline does.
//
// The arrow must be preceded by an actual parameter list, anchored to the
// assignment. A bare /=>/ also matches a regex literal that happens to contain
// one — which is how this very constant first mislabelled itself as a function.
const ARROW = /=\s*(async\s+)?(function\b|(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/;

function refine(kind: SymbolKind | undefined, raw: string): SymbolKind | undefined {
  return kind === 'variable' && ARROW.test(raw) ? 'function' : kind;
}

// Files whose language CodeMirror has no grammar for (.svelte, .vue, shell,
// config dialects) still deserve an outline. Match the shapes that start a
// declaration in almost every C-family or scripting language and nest by
// indentation — crude, but far better than an empty panel.
const FALLBACK =
  /^(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|static\s+)*(async\s+)?(function|class|interface|type|enum|struct|impl|trait|module|namespace|def|fn|func|const|let|var|sub|proc)\b/;

const MAX_NODES = 400;
const MAX_LABEL = 90;
const MAX_FALLBACK_LINES = 5000;
// `syntaxTree` only returns what the incremental parser has covered so far,
// which on a freshly-mounted editor is roughly the viewport. Walking that gives
// an outline truncated at whatever happened to be on screen, and nothing forces
// a re-walk once the background parse catches up. Ask for the whole document
// with a budget instead; if the parser cannot finish in time, fall back to the
// partial tree rather than blocking the frame.
const PARSE_BUDGET_MS = 150;
// Past this size, paying the full-parse budget on every keystroke is what
// makes typing stutter — a multi-megabyte file cannot finish inside the budget
// anyway, so take whatever the incremental parser already has and move on.
const FULL_PARSE_MAX_BYTES = 400_000;
// How much of a JSON leaf value to show beside its key.
const JSON_PREVIEW = 48;

// Cutting at the first `{` or `=` turns `export async function load(x) {` into
// a clean label, but destructured bindings (`let { a, b } = ...`) cut down to a
// bare keyword — useless as a row. Detect that and keep the whole line instead.
const KEYWORD_ONLY =
  /^((export|default|async|public|private|protected|static)\s+)*(const|let|var|function|class|type|interface|enum|struct|def|fn|func)?$/;

function trim(s: string): string {
  const raw = s.trim().replace(/\s+/g, ' ');
  const cut = raw.replace(/\s*[{=].*$/, '').trim();
  const one = KEYWORD_ONLY.test(cut) ? raw : cut;
  return one.length > MAX_LABEL ? `${one.slice(0, MAX_LABEL - 1)}…` : one;
}

// One line of source, cut at the first body/assignment delimiter: enough to
// identify `export async function foo` without dragging in the whole signature.
function labelFor(state: EditorState, from: number, to: number): string {
  const line = state.doc.lineAt(from);
  const raw = state.doc.sliceString(from, Math.min(to, line.to));
  return trim(raw) || trim(line.text);
}

// Indentation-nested scan, used when there is no parse tree to walk.
function fallbackOutline(state: EditorState): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: { indent: number; node: OutlineNode }[] = [];
  const total = Math.min(state.doc.lines, MAX_FALLBACK_LINES);
  let count = 0;
  for (let i = 1; i <= total && count < MAX_NODES; i++) {
    const line = state.doc.line(i);
    const body = line.text.trimStart();
    if (!FALLBACK.test(body)) continue;
    const text = trim(body);
    if (!text) continue;
    const keyword = body.match(/[a-z]+/)?.[0] ?? '';
    const kind = refine(KIND_BY_KEYWORD[keyword], body);
    const indent = line.text.length - body.length;
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const node: OutlineNode = { level: stack.length + 1, text, line: i, kind, children: [] };
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node });
    count += 1;
  }
  return roots;
}

// JSON has no declarations to find, so its outline is its key structure —
// which is exactly what scanning an unfamiliar schema wants. The grammar
// already ships with @codemirror/lang-json; no language server involved.
function jsonOutline(state: EditorState, tree: Tree): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: { to: number; node: OutlineNode }[] = [];
  let count = 0;
  tree.iterate({
    enter: (n) => {
      if (count >= MAX_NODES) return false;
      if (n.name !== 'Property') return;
      const key = n.node.firstChild;
      const value = n.node.lastChild;
      if (!key) return;
      const name = state.doc.sliceString(key.from, key.to).replace(/^"|"$/g, '');
      if (!name) return;
      const vt = value?.name ?? '';
      // Objects and arrays are containers; anything else is a leaf, and
      // showing the value inline is what makes the panel read as a schema.
      const kind: SymbolKind = vt === 'Object' ? 'module' : vt === 'Array' ? 'enum' : 'variable';
      let text = name;
      if (value && kind === 'variable') {
        const raw = state.doc
          .sliceString(value.from, Math.min(value.to, value.from + JSON_PREVIEW))
          .replace(/\s+/g, ' ');
        text = `${name}: ${raw}${value.to - value.from > JSON_PREVIEW ? '…' : ''}`;
      }
      if (text.length > MAX_LABEL) text = `${text.slice(0, MAX_LABEL - 1)}…`;
      while (stack.length && n.from >= stack[stack.length - 1].to) stack.pop();
      const node: OutlineNode = {
        level: stack.length + 1,
        text,
        line: state.doc.lineAt(n.from).number,
        kind,
        children: [],
      };
      (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
      stack.push({ to: n.to, node });
      count += 1;
      return;
    },
  });
  return roots;
}

// Walk the parse tree in document order, keeping a stack of still-open
// declarations: a node entered before the top of the stack ends is nested
// inside it. Cheap (no re-parse) because CodeMirror already holds the tree.
export function outlineFromState(state: EditorState): OutlineNode[] {
  const tree =
    state.doc.length <= FULL_PARSE_MAX_BYTES
      ? (ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state))
      : syntaxTree(state);
  if (!tree || tree.length === 0) return fallbackOutline(state);
  if (tree.type.name === 'JsonText') return jsonOutline(state, tree);
  const roots: OutlineNode[] = [];
  const stack: { to: number; node: OutlineNode }[] = [];
  let count = 0;
  tree.iterate({
    enter: (n) => {
      if (count >= MAX_NODES) return false;
      if (!DECL.has(n.name)) return;
      const text = labelFor(state, n.from, n.to);
      if (!text) return;
      const kind = refine(KIND_BY_NODE[n.name], state.doc.lineAt(n.from).text);
      while (stack.length && n.from >= stack[stack.length - 1].to) stack.pop();
      const node: OutlineNode = {
        level: stack.length + 1,
        text,
        line: state.doc.lineAt(n.from).number,
        kind,
        children: [],
      };
      (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
      stack.push({ to: n.to, node });
      count += 1;
      return;
    },
  });
  return roots.length ? roots : fallbackOutline(state);
}
