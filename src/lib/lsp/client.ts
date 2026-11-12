// Browser side of the opt-in language servers. The node server starts and
// stops them (GET/POST/DELETE /api/lsp) and bridges each one to a WebSocket at
// /api/lsp?id=; this module keeps one LSPClient per running server for the
// whole page and decides which of them, if any, covers a given file.
//
// Nothing here starts a server: the list is fetched once on load and again on
// every `gmd:lsp-changed` window event, which the start/stop UI dispatches.

import {
  LSPClient,
  LSPPlugin,
  Workspace,
  hoverTooltips,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
  type Transport,
  type WorkspaceFile,
} from '@codemirror/lsp-client';
import type { Extension, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { errorLens } from './error-lens';

// Not exported by the package; recovered from the method that returns it.
type WorkspaceFileUpdate = ReturnType<Workspace['syncFiles']>[number];

export interface ServerEntry {
  id: string;
  kind: 'tsgo' | 'ty' | 'basedpyright';
  language: string;
  folder: string;
  rootUri: string;
  state: 'starting' | 'running' | 'exited';
}

export interface Conn {
  entry: ServerEntry;
  client: LSPClient;
  // file:// URI of the served root, derived from the server's own rootUri so
  // the two always agree on encoding.
  rootBase: string;
  ws: WebSocket | null;
  dead: boolean;
}

// Which extensions each kind of server can answer for, with the LSP language
// id to announce. TS 7 needs the *react ids to parse JSX.
const LANG_BY_EXT: Record<string, { kinds: ServerEntry['kind'][]; id: string }> = {
  ts: { kinds: ['tsgo'], id: 'typescript' },
  mts: { kinds: ['tsgo'], id: 'typescript' },
  cts: { kinds: ['tsgo'], id: 'typescript' },
  tsx: { kinds: ['tsgo'], id: 'typescriptreact' },
  js: { kinds: ['tsgo'], id: 'javascript' },
  mjs: { kinds: ['tsgo'], id: 'javascript' },
  cjs: { kinds: ['tsgo'], id: 'javascript' },
  jsx: { kinds: ['tsgo'], id: 'javascriptreact' },
  py: { kinds: ['ty', 'basedpyright'], id: 'python' },
  pyi: { kinds: ['ty', 'basedpyright'], id: 'python' },
};

export function languageIdFor(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return LANG_BY_EXT[ext]?.id ?? null;
}

const conns = new Map<string, Conn>();
const listeners = new Set<() => void>();

export function onLspChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}

// --- paths and URIs ----------------------------------------------------------

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

// Compared decoded, because servers re-encode URIs their own way (`%3A` for a
// drive colon, or none at all for a space).
const decodeUri = (u: string) => {
  try { return decodeURIComponent(u.replace(/^file:\/\//, '')); } catch { return u.replace(/^file:\/\//, ''); }
};

function rootBaseOf(entry: ServerEntry): string {
  const root = entry.rootUri.replace(/\/+$/, '');
  if (!entry.folder) return root;
  const tail = '/' + encPath(entry.folder.replace(/^\/+|\/+$/g, ''));
  if (root.endsWith(tail)) return root.slice(0, -tail.length);
  // Encoding disagreed; fall back to cutting the same number of segments.
  const segs = entry.folder.split('/').filter(Boolean).length;
  return root.split('/').slice(0, -segs).join('/');
}

export function uriFor(conn: Conn, path: string): string {
  return `${conn.rootBase}/${encPath(path)}`;
}

/** Root-relative path for a server URI, or null when it lies outside the served root. */
export function pathForUri(uri: string): string | null {
  const conn = conns.values().next().value as Conn | undefined;
  const base = conn ? decodeUri(conn.rootBase) : null;
  if (!base) return null;
  const abs = decodeUri(uri);
  if (abs === base) return '';
  if (!abs.startsWith(base + '/')) return null;
  return abs.slice(base.length + 1);
}

// --- gitignore ---------------------------------------------------------------
// The explorer already asks git which entries are ignored (`ignored` on each
// /api/tree entry, from `git check-ignore`, which also answers for files under
// an ignored folder). The same listing answers here, one fetch per folder.

const ignoreCache = new Map<string, Promise<Set<string>>>();

export function isIgnored(path: string): Promise<boolean> {
  const cut = path.lastIndexOf('/');
  const dir = cut < 0 ? '' : path.slice(0, cut);
  const name = path.slice(cut + 1);
  let set = ignoreCache.get(dir);
  if (!set) {
    set = fetch(`/api/tree?path=${encodeURIComponent(dir)}`)
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((j: { entries?: { name: string; ignored?: boolean }[] }) =>
        new Set((j.entries ?? []).filter((e) => e.ignored).map((e) => e.name)))
      .catch(() => new Set<string>());
    ignoreCache.set(dir, set);
    // Short-lived: a .gitignore edit should not need a reload to take effect.
    setTimeout(() => ignoreCache.delete(dir), 30_000);
  }
  return set.then((s) => s.has(name));
}

// --- workspace ---------------------------------------------------------------

class GmdFile implements WorkspaceFile {
  views: EditorView[];
  constructor(public uri: string, public languageId: string, public version: number, public doc: Text, view: EditorView) {
    this.views = [view];
  }
  getView(main?: EditorView) {
    return main && this.views.includes(main) ? main : (this.views[0] ?? null);
  }
}

// The stock workspace refuses a second view on one file; split editors and the
// merge view can show the same path twice, so this one counts views and syncs
// from the first. Cross-file jumps go through the shell's open-request event.
class GmdWorkspace extends Workspace {
  files: GmdFile[] = [];
  private versions: Record<string, number> = Object.create(null);

  private next(uri: string) {
    return (this.versions[uri] = (this.versions[uri] ?? -1) + 1);
  }

  syncFiles(): readonly WorkspaceFileUpdate[] {
    const out: WorkspaceFileUpdate[] = [];
    for (const file of this.files) {
      const view = file.views[0];
      const plugin = view && LSPPlugin.get(view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (changes.empty) continue;
      out.push({ changes, file, prevDoc: file.doc });
      file.doc = view.state.doc;
      file.version = this.next(file.uri);
      plugin.clear();
    }
    return out;
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    const have = this.files.find((f) => f.uri === uri);
    if (have) { have.views.push(view); return; }
    const file = new GmdFile(uri, languageId, this.next(uri), view.state.doc, view);
    this.files.push(file);
    if (this.client.connected) this.client.didOpen(file);
  }

  closeFile(uri: string, view: EditorView) {
    const file = this.files.find((f) => f.uri === uri);
    if (!file) return;
    file.views = file.views.filter((v) => v !== view);
    if (file.views.length) return;
    this.files = this.files.filter((f) => f !== file);
    if (this.client.connected) this.client.didClose(uri);
  }

  async displayFile(uri: string): Promise<EditorView | null> {
    const path = pathForUri(uri);
    if (path != null) {
      window.dispatchEvent(new CustomEvent('gmd:open-request', { detail: { kind: 'file', path } }));
    }
    return null;
  }
}

// Hover and completion docs are server Markdown rendered to HTML. The server
// is local and trusted, but its text quotes the user's own source; strip
// anything executable all the same.
function sanitizeHTML(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const el of doc.body.querySelectorAll('script,style,iframe,object,embed,link,meta,form')) el.remove();
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) {
        el.removeAttribute(a.name);
      }
    }
  }
  return doc.body.innerHTML;
}

// --- connections -------------------------------------------------------------

function wsTransport(ws: WebSocket): Transport {
  const handlers = new Set<(v: string) => void>();
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    for (const h of handlers) h(e.data);
  });
  return {
    send(m) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('language server socket closed');
      ws.send(m);
    },
    subscribe(h) { handlers.add(h); },
    unsubscribe(h) { handlers.delete(h); },
  };
}

function attach(conn: Conn) {
  if (conn.dead) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/lsp?id=${encodeURIComponent(conn.entry.id)}`);
  conn.ws = ws;
  ws.addEventListener('open', () => {
    if (conn.ws !== ws) return;
    // The bridge answers a repeat initialize from its cache, so the same
    // client object survives a dropped socket and every editor plugin built
    // from it stays valid.
    conn.client.connect(wsTransport(ws));
    conn.client.initializing.then(() => emit(), () => {});
  });
  ws.addEventListener('close', () => {
    if (conn.ws !== ws) return;
    conn.ws = null;
    if (conn.client.connected) conn.client.disconnect();
    // 4000 = a newer attach (another tab) took the server over; do not fight it.
    if (!conn.dead) setTimeout(() => void refreshServers(), 3000);
  });
}

function makeConn(entry: ServerEntry): Conn {
  const client = new LSPClient({
    rootUri: entry.rootUri,
    timeout: 10_000,
    workspace: (c) => new GmdWorkspace(c),
    sanitizeHTML,
    extensions: [
      serverCompletion({ override: true }),
      hoverTooltips(),
      signatureHelp({ keymap: false }),
      serverDiagnostics(),
      errorLens,
    ],
  });
  return { entry, client, rootBase: rootBaseOf(entry), ws: null, dead: false };
}

let inflight: Promise<void> | null = null;

export function refreshServers(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    let list: ServerEntry[] = [];
    try {
      const r = await fetch('/api/lsp');
      if (r.ok) list = ((await r.json()) as { servers?: ServerEntry[] }).servers ?? [];
    } catch { /* no bridge on this server: behave as if none run */ }
    const live = list.filter((s) => s.state !== 'exited');
    let changed = false;
    for (const [id, c] of conns) {
      if (live.some((s) => s.id === id)) continue;
      c.dead = true;
      c.ws?.close();
      if (c.client.connected) c.client.disconnect();
      conns.delete(id);
      changed = true;
    }
    for (const s of live) {
      const have = conns.get(s.id);
      if (have) {
        have.entry = s;
        if (!have.ws && s.state === 'running') attach(have);
        continue;
      }
      const c = makeConn(s);
      conns.set(s.id, c);
      changed = true;
      if (s.state === 'running') attach(c);
    }
    // A server still starting is polled until it runs.
    if (live.some((s) => s.state === 'starting')) setTimeout(() => void refreshServers(), 1500);
    if (changed) emit();
  })().finally(() => { inflight = null; });
  return inflight;
}

/** The connection whose folder holds `path` and whose language matches; deepest folder wins. */
export function connFor(path: string): Conn | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const lang = LANG_BY_EXT[ext];
  if (!lang) return null;
  let best: Conn | null = null;
  for (const c of conns.values()) {
    if (!lang.kinds.includes(c.entry.kind)) continue;
    const f = c.entry.folder.replace(/^\/+|\/+$/g, '');
    if (f && path !== f && !path.startsWith(f + '/')) continue;
    if (!best || f.length > best.entry.folder.length) best = c;
  }
  return best;
}

/** The editor extension for `path`, or null when no server covers it or it is gitignored. */
export async function lspFor(path: string): Promise<{ conn: Conn; uri: string; extension: Extension } | null> {
  if (!path) return null;
  const conn = connFor(path);
  const id = languageIdFor(path);
  if (!conn || !id) return null;
  if (await isIgnored(path)) return null;
  const uri = uriFor(conn, path);
  return { conn, uri, extension: conn.client.plugin(uri, id) };
}

if (typeof window !== 'undefined') {
  window.addEventListener('gmd:lsp-changed', () => void refreshServers());
  void refreshServers();
}
