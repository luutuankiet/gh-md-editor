// Requests the editor makes on its own behalf (definition, references), as
// opposed to the hover / completion / diagnostics the lsp-client extensions
// drive. Results come back as root-relative paths with 1-based lines, the
// shape the rest of the IDE already speaks.

import type { EditorView } from '@codemirror/view';
import { pathForUri, type Conn } from './client';

export interface LspLoc {
  path: string;
  line: number; // 1-based
  col: number; // 0-based UTF-16 column
  endLine: number;
  endCol: number;
}

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
type Location = { uri: string; range: Range };
type LocationLink = { targetUri: string; targetSelectionRange?: Range; targetRange: Range };

function position(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
}

function normalize(raw: unknown): LspLoc[] {
  if (!raw) return [];
  const arr = (Array.isArray(raw) ? raw : [raw]) as (Location | LocationLink)[];
  const out: LspLoc[] = [];
  for (const l of arr) {
    const uri = 'targetUri' in l ? l.targetUri : l.uri;
    const range = 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange) : l.range;
    const path = pathForUri(uri);
    // A definition outside the served root (a global typings folder, the
    // Python stdlib) has nowhere to open in this IDE.
    if (path == null || !range) continue;
    out.push({
      path,
      line: range.start.line + 1,
      col: range.start.character,
      endLine: range.end.line + 1,
      endCol: range.end.character,
    });
  }
  return out;
}

// A slow or wedged server must not hold up Cmd+Click or Peek: past this the
// caller falls back to the ripgrep / in-file lookup.
const ASK_TIMEOUT_MS = 4000;

async function ask(conn: Conn, uri: string, view: EditorView, pos: number, method: string, extra: object = {}) {
  // Never wait on `initializing` here: after a disconnect the client swaps in
  // a fresh promise that only resolves on the next connect, which may never
  // come. Not connected now means no answer now.
  if (!conn.client.connected) throw new Error('language server not connected');
  conn.client.sync();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} timed out`)), ASK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      conn.client.request(method, { textDocument: { uri }, position: position(view, pos), ...extra }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function lspDefinition(conn: Conn, uri: string, view: EditorView, pos: number): Promise<LspLoc[]> {
  return normalize(await ask(conn, uri, view, pos, 'textDocument/definition'));
}

export async function lspReferences(conn: Conn, uri: string, view: EditorView, pos: number): Promise<LspLoc[]> {
  return normalize(await ask(conn, uri, view, pos, 'textDocument/references', { context: { includeDeclaration: true } }));
}
