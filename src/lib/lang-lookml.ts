import { LanguageDescription, LanguageSupport, StreamLanguage, foldService, syntaxTree } from '@codemirror/language';
import type { StreamParser, StringStream } from '@codemirror/language';
import { Prec } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';

// LookML: Looker's modelling language. Neither @codemirror/language-data nor
// the markdown preview's grammar set knows it, so this is a hand-written
// stream tokenizer. The shape is small: `key: value` pairs, `{ }` blocks,
// `[ ]` lists, `#` comments, double-quoted strings, and code blocks that run
// from a `sql:` / `html:` style key to a closing `;;`, possibly many lines on.
//
// Inside a sql* or expression* block the SQL legacy tokenizer runs, nested in
// this parser's state. `${...}` substitutions and the `;;` terminator still
// win there: the SQL tokenizer is handed a stream cut short at whichever
// comes first, so it cannot swallow either.

type Block = 'sql' | 'raw';

interface LookmlState {
  // The code block the cursor is inside, or null for plain LookML.
  block: Block | null;
  // The SQL tokenizer's own state while inside a sql block.
  inner: unknown;
  // Set by a code-block key, consumed by the `:` that follows it.
  pending: Block | null;
  // Inside a double-quoted string that has not closed yet.
  inString: boolean;
  // Open `{` / `[` count, for indentation.
  depth: number;
}

const CODE_KEY = /^\+?(sql|expression|html|js)(_\w*)?$/;
const KEY = /^\+?[A-Za-z0-9_.*-]+(?=\s*:(?!:))/;
const IDENT = /^[-+]?[A-Za-z_][\w.]*\*?/;
const NUMBER = /^-?\d+(\.\d+)?(?![\w.])/;

// `${` up to its `}`; an unterminated one runs to the end of the line rather
// than eating the following lines.
function substitution(stream: StringStream): string {
  if (!stream.skipTo('}')) stream.skipToEnd();
  else stream.next();
  return 'variableName.special';
}

function makeParser(sql: StreamParser<unknown>): StreamParser<LookmlState> {
  const copyInner = (s: unknown): unknown => {
    if (sql.copyState) return sql.copyState(s);
    if (!s || typeof s !== 'object') return s;
    return { ...(s as Record<string, unknown>) };
  };

  function codeBlock(stream: StringStream, state: LookmlState): string | null {
    if (stream.match(';;')) {
      state.block = null;
      state.inner = null;
      return 'punctuation';
    }
    if (stream.match('${')) return substitution(stream);

    // Bound everything else at the next `;;` or `${` on this line.
    const rest = stream.string.slice(stream.pos);
    const hits = [rest.indexOf(';;'), rest.indexOf('${')].filter((i) => i >= 0);
    const bound = hits.length ? stream.pos + Math.min(...hits) : stream.string.length;

    if (state.block === 'raw') {
      stream.pos = bound;
      return 'string';
    }

    const full = stream.string;
    const start = stream.pos;
    stream.string = full.slice(0, bound);
    let style: string | null;
    try {
      style = sql.token(stream, state.inner);
    } finally {
      stream.string = full;
    }
    if (stream.pos === start) stream.pos = bound > start ? bound : start + 1;
    return style;
  }

  function stringBody(stream: StringStream, state: LookmlState): string {
    if (stream.match(/^\\./)) return 'escape';
    if (stream.eat('"')) {
      state.inString = false;
      return 'string';
    }
    while (!stream.eol()) {
      const ch = stream.peek();
      if (ch === '"' || ch === '\\') break;
      stream.next();
    }
    return 'string';
  }

  return {
    name: 'lookml',

    startState: () => ({ block: null, inner: null, pending: null, inString: false, depth: 0 }),

    copyState: (s) => ({ ...s, inner: s.inner === null ? null : copyInner(s.inner) }),

    token(stream, state) {
      if (state.block) return codeBlock(stream, state);
      if (state.inString) return stringBody(stream, state);
      if (stream.eatSpace()) return null;

      if (stream.match('#')) {
        stream.skipToEnd();
        return 'comment';
      }
      if (stream.match('${')) return substitution(stream);
      if (stream.eat('"')) {
        state.inString = true;
        return stringBody(stream, state);
      }

      const key = stream.match(KEY) as RegExpMatchArray | null;
      if (key) {
        state.pending = CODE_KEY.test(key[0]) ? (/^\+?(sql|expression)/.test(key[0]) ? 'sql' : 'raw') : null;
        return 'propertyName';
      }
      if (stream.eat(':')) {
        if (state.pending) {
          state.block = state.pending;
          state.inner = state.pending === 'sql' && sql.startState ? sql.startState(stream.indentUnit) : null;
          state.pending = null;
        }
        return 'punctuation';
      }
      state.pending = null;

      const ch = stream.peek();
      if (ch === '{' || ch === '[') {
        stream.next();
        state.depth++;
        return ch === '{' ? 'brace' : 'squareBracket';
      }
      if (ch === '}' || ch === ']') {
        stream.next();
        state.depth = Math.max(0, state.depth - 1);
        return ch === '}' ? 'brace' : 'squareBracket';
      }
      if (ch === ',') {
        stream.next();
        return 'separator';
      }
      if (stream.match(';;')) return 'punctuation';
      if (stream.match(NUMBER)) return 'number';

      const word = stream.match(IDENT) as RegExpMatchArray | null;
      if (word) {
        const w = word[0];
        if (w === 'yes' || w === 'no') return 'bool';
        if (w === 'asc' || w === 'desc') return 'keyword';
        return 'variableName';
      }
      if (stream.eat('*')) return 'variableName';

      stream.next();
      return null;
    },

    indent(state, textAfter, cx) {
      if (state.block || state.inString) return null;
      const closing = /^\s*[}\]]/.test(textAfter) ? 1 : 0;
      return Math.max(0, state.depth - closing) * cx.unit;
    },

    languageData: {
      commentTokens: { line: '#' },
      closeBrackets: { brackets: ['(', '[', '{', '"'] },
      indentOnInput: /^\s*[}\]]$/,
    },
  };
}

// Brace folding. A stream language produces a flat run of tokens, not a tree
// with block nodes, so the editor's syntax folding finds nothing here. The
// brace and bracket tokens the tokenizer emits are enough: they are only ever
// produced outside strings, comments and code blocks, so a `{` inside SQL or
// HTML never counts. Raised to high precedence so it answers before the
// editor's indentation-based fallback service.
function lookmlFold(state: EditorState, from: number, to: number) {
  const tree = syntaxTree(state);
  if (tree.length < to) return null;
  const open: number[] = [];
  let start = -1;
  let depth = 0;
  let end = -1;
  tree.iterate({
    from,
    enter(node) {
      if (end >= 0) return false;
      const name = node.type.name;
      if (name !== 'brace' && name !== 'squareBracket') return;
      const text = state.doc.sliceString(node.from, node.to);
      for (let i = 0; i < text.length; i++) {
        const pos = node.from + i;
        const opener = text[i] === '{' || text[i] === '[';
        if (pos <= to) {
          if (opener) open.push(pos);
          else open.pop();
          continue;
        }
        if (start < 0) {
          if (!open.length) {
            end = -2;
            return false;
          }
          start = open[0];
          depth = open.length;
        }
        depth += opener ? 1 : -1;
        if (depth === 0) {
          end = pos;
          return false;
        }
      }
    },
  });
  if (start < 0 || end < 0) return null;
  return { from: start + 1, to: end };
}

async function loadLookml(): Promise<LanguageSupport> {
  const [{ standardSQL }, { closeBrackets }] = await Promise.all([
    import('@codemirror/legacy-modes/mode/sql'),
    import('@codemirror/autocomplete'),
  ]);
  const language = StreamLanguage.define(makeParser(standardSQL as StreamParser<unknown>));
  return new LanguageSupport(language, [Prec.high(foldService.of(lookmlFold)), closeBrackets()]);
}

// Exported for the token dump script; the editor goes through the description.
export async function lookmlParser(): Promise<StreamParser<unknown>> {
  const { standardSQL } = await import('@codemirror/legacy-modes/mode/sql');
  return makeParser(standardSQL as StreamParser<unknown>) as StreamParser<unknown>;
}

// `x.view.lkml`, `x.model.lkml` and `x.explore.lkml` all end in `.lkml`, and
// LanguageDescription.matchFilename matches on the last extension only, so
// the one entry covers every LookML file kind.
export const lookmlLanguage = LanguageDescription.of({
  name: 'LookML',
  alias: ['lookml'],
  extensions: ['lkml'],
  load: loadLookml,
});
