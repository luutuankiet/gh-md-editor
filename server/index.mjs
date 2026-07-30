#!/usr/bin/env node
// gh-md-editor server mode — file server + terminal host.
// Serves the built client bundle, a small REST API for lazy directory
// browsing and mtime-guarded file editing, a streamed ripgrep search and a
// ws+node-pty terminal. Git arrives in a later phase.
//
// Security posture (explicit decision): PERMISSIVE BY DEFAULT — any --host
// works with no auth, for convenience. A loud startup warning fires on
// non-loopback binds (the terminal endpoint is a full shell). Auth is
// opt-in: --auth <token> gates the whole server including the terminal.

import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
// node-pty is an OPTIONAL dependency, loaded lazily on purpose. It is a native
// addon: when npm finds no prebuild for the running Node version it falls back
// to node-gyp, which needs make/g++/python3 on the box. As a hard dependency
// that failure aborted the entire install, and because npm hides install-script
// output by default the symptom was brutal — `npx @luutuankiet/gh-md-editor`
// printed NOTHING and exited 1 (measured on Node 24 + a host without make).
// Every other feature works without a pty, so degrade instead of dying.
let pty = null;
let ptyError = '';
try {
  pty = (await import('node-pty')).default;
} catch (e) {
  ptyError = String(e?.message ?? e).split('\n')[0];
}
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist', 'web');
const MAX_FILE = 5 * 1024 * 1024; // 5MB read guard
const MAX_BODY = 10 * 1024 * 1024;

// --- CLI -------------------------------------------------------------------
const argv = process.argv.slice(2);
let host = '127.0.0.1';
let port = 8790;
let auth = null;
let rootArg = '.';
let tunnel = null;      // 'cloudflared' | 'funnel'
let tunnelBin = null;   // explicit binary path override
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--host') host = argv[++i];
  else if (a === '--port') port = Number(argv[++i]);
  else if (a === '--auth') auth = argv[++i];
  else if (a === '--tunnel') {
    // Optional value: bare `--tunnel` means cloudflared — the zero-setup path
    // (no account, real TLS, WebSocket-clean, phone-openable).
    tunnel = argv[i + 1] && !argv[i + 1].startsWith('--') && ['cloudflared', 'funnel'].includes(argv[i + 1])
      ? argv[++i]
      : 'cloudflared';
  }
  else if (a === '--tunnel-bin') tunnelBin = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log('usage: node server/index.mjs [dir] [--host 127.0.0.1] [--port 8790] [--auth <token>] [--tunnel [cloudflared|funnel]] [--tunnel-bin <path>]');
    process.exit(0);
  } else if (!a.startsWith('--')) rootArg = a;
}
// A tunnel URL is reachable by the whole internet and /api/pty is a shell —
// force auth on. The token is minted server-side (not user-supplied) so a
// bare `--tunnel` can never ship an unauthenticated public shell.
if (tunnel && !auth) auth = crypto.randomBytes(16).toString('base64url');
const ROOT = path.resolve(process.cwd(), rootArg);

// --- helpers ---------------------------------------------------------------

// Resolve a client-supplied relative path against ROOT, rejecting escapes.
// Returns null for any path that would land outside the served root.
function resolveSafe(rel) {
  const abs = path.resolve(ROOT, rel ?? '.');
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

// Opt-in auth (--auth <token>): accepted as ?token= query, x-auth-token
// header, or the gmd_token cookie the server sets after a query-token hit —
// so the browser client needs zero token plumbing beyond the initial URL.
function authorized(req, url) {
  if (!auth) return true;
  if (url.searchParams.get('token') === auth) return true;
  if (req.headers['x-auth-token'] === auth) return true;
  const cookies = (req.headers.cookie ?? '').split(/;\s*/);
  return cookies.includes(`gmd_token=${auth}`);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// --- API handlers ----------------------------------------------------------

async function apiRoot(res) {
  sendJson(res, 200, { root: ROOT, sep: path.sep });
}

// One directory per call — the lazy-tree contract. The client fetches a
// directory only when the user expands it; no upfront workspace scan.
async function apiTree(res, params) {
  const abs = resolveSafe(params.get('path') ?? '.');
  if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return sendJson(res, e.code === 'ENOENT' ? 404 : 500, { error: String(e.message ?? e) });
  }
  const out = entries.map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file',
  }));
  out.sort((a, b) =>
    (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
    a.name.localeCompare(b.name)
  );
  sendJson(res, 200, { entries: out });
}

async function apiFileGet(res, params) {
  const abs = resolveSafe(params.get('path'));
  if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    return sendJson(res, e.code === 'ENOENT' ? 404 : 500, { error: String(e.message ?? e) });
  }
  if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' });
  if (st.size > MAX_FILE) return sendJson(res, 413, { error: `file too large (${st.size} bytes, cap ${MAX_FILE})`, size: st.size });
  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) return sendJson(res, 200, { binary: true, size: st.size, mtimeMs: st.mtimeMs });
  sendJson(res, 200, { content: buf.toString('utf8'), mtimeMs: st.mtimeMs, size: st.size });
}

// Copy-as-context: walk a file or directory and wrap every text file in
// <file src="relpath">…</file> blocks inside one <context> envelope —
// ported (raw variant only) from the mouse-word-highlight VS Code
// extension's copyFilesAsContext. src paths are relative to `base` (the
// workspace anchor) so pasted context matches what the explorer shows.
// Binary files (NUL in first 8KB), oversized files and vendored dirs are
// skipped and counted; the whole payload is capped at MAX_BODY.
const CONTEXT_SKIP_DIRS = new Set(['.git', 'node_modules']);
async function apiContext(res, params) {
  // Multi-select sends several path params; each may be a file or a dir.
  const rels = params.getAll('path');
  if (rels.length === 0) return sendJson(res, 400, { error: 'path required' });
  const targets = [];
  for (const rel of rels) {
    const abs = resolveSafe(rel);
    if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
    targets.push(abs);
  }
  const baseAbs = resolveSafe(params.get('base') ?? '.') ?? ROOT;
  // absolute=1 → src attributes carry the host filesystem path. The payload
  // is pasted into agent prompts that resolve files server-side, where a
  // workspace-relative path is ambiguous.
  const absolute = params.get('absolute') === '1';
  const files = [];
  const seen = new Set();
  let skipped = 0;
  const collect = async (p, top) => {
    let st;
    try { st = await fs.stat(p); } catch { skipped++; return; }
    if (st.isDirectory()) {
      if (p !== top && CONTEXT_SKIP_DIRS.has(path.basename(p))) { skipped++; return; }
      let entries;
      try { entries = await fs.readdir(p); } catch { skipped++; return; }
      entries.sort((a, b) => a.localeCompare(b));
      for (const name of entries) await collect(path.join(p, name), top);
    } else if (st.isFile()) {
      if (st.size > MAX_FILE) { skipped++; return; }
      if (seen.has(p)) return; // overlapping selections (dir + file inside it)
      seen.add(p);
      files.push(p);
    }
  };
  for (const abs of targets) await collect(abs, abs);
  const blocks = [];
  let total = 0;
  for (const p of files) {
    let buf;
    try { buf = await fs.readFile(p); } catch { skipped++; continue; }
    if (looksBinary(buf)) { skipped++; continue; }
    const src = absolute ? p : path.relative(baseAbs, p).split(path.sep).join('/');
    const block = `<file src="${src}">\n${buf.toString('utf8')}\n</file>`;
    total += block.length;
    if (total > MAX_BODY) return sendJson(res, 413, { error: `context exceeds ${MAX_BODY} bytes — select a smaller folder` });
    blocks.push(block);
  }
  if (blocks.length === 0) return sendJson(res, 200, { payload: '', files: 0, skipped });
  sendJson(res, 200, { payload: `<context>\n${blocks.join('\n')}\n</context>\n`, files: blocks.length, skipped });
}

// Conditional write: the client sends the mtime it loaded the file at.
// If the disk copy is newer (someone else wrote it), respond 409 with the
// disk content so the client can show the VS Code-style conflict prompt.
async function apiFilePut(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const { path: rel, content, baseMtimeMs, createDirs } = body ?? {};
  if (typeof rel !== 'string' || typeof content !== 'string') {
    return sendJson(res, 400, { error: 'path and content required' });
  }
  const abs = resolveSafe(rel);
  if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
  try {
    const st = await fs.stat(abs).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (st && typeof baseMtimeMs === 'number' && st.mtimeMs > baseMtimeMs + 0.5) {
      const buf = await fs.readFile(abs);
      return sendJson(res, 409, {
        conflict: true,
        mtimeMs: st.mtimeMs,
        content: looksBinary(buf) ? null : buf.toString('utf8'),
      });
    }
    // Save As can type a path whose folders don't exist yet — opt-in mkdir -p
    // so the modal needs no separate mkdir round-trip.
    if (createDirs) await fs.mkdir(path.dirname(abs), { recursive: true });
    // Atomic-ish write: temp file + rename, same dir so rename stays atomic.
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.gmd-tmp-${process.pid}`);
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, abs);
    const st2 = await fs.stat(abs);
    sendJson(res, 200, { mtimeMs: st2.mtimeMs, size: st2.size });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message ?? e) });
  }
}

// --- quick open (fuzzy file list) ------------------------------------------
//   GET /api/quickopen?q=<query>&path=<base>
//   → {files:[{path}], truncated}
// One `rg --files` per base, cached briefly so a keystroke burst does not
// rescan the tree. Fuzzy subsequence rank server-side, top 50 back.
const QUICKOPEN_CAP = 50;
const FILELIST_TTL = 10_000;
const FILELIST_CAP = 50_000;
const fileListCache = new Map(); // baseAbs → {at, files, truncated}

function listFiles(baseAbs) {
  const hit = fileListCache.get(baseAbs);
  if (hit && Date.now() - hit.at < FILELIST_TTL) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const child = spawn('rg', ['--files'], { cwd: baseAbs });
    let buf = '';
    let truncated = false;
    const done = () => {
      const files = buf.split('\n').filter(Boolean);
      if (files.length > FILELIST_CAP) { files.length = FILELIST_CAP; truncated = true; }
      const entry = { at: Date.now(), files, truncated };
      fileListCache.set(baseAbs, entry);
      resolve(entry);
    };
    child.stdout.on('data', (d) => {
      if (buf.length < 8 * 1024 * 1024) buf += d;
      else truncated = true;
    });
    child.on('error', done);
    child.on('close', done);
  });
}

// Subsequence fuzzy match. Word-boundary and streak hits rank up, a basename
// substring is a strong signal, shorter paths break ties.
function fuzzyRank(q, p) {
  const lq = q.toLowerCase();
  const lp = p.toLowerCase();
  let qi = 0, score = 0, streak = 0, last = -2;
  for (let i = 0; i < lp.length && qi < lq.length; i++) {
    if (lp[i] !== lq[qi]) continue;
    streak = i === last + 1 ? streak + 1 : 1;
    const boundary = i === 0 || '/.-_'.includes(lp[i - 1]);
    score += 1 + streak * 2 + (boundary ? 8 : 0);
    last = i;
    qi++;
  }
  if (qi < lq.length) return -1;
  if (lp.slice(lp.lastIndexOf('/') + 1).includes(lq)) score += 30;
  return score - p.length * 0.01;
}

async function apiQuickOpen(res, params) {
  const baseAbs = resolveSafe(params.get('path') || '.');
  if (!baseAbs) return sendJson(res, 400, { error: 'path escapes root' });
  const q = (params.get('q') ?? '').trim();
  const { files, truncated } = await listFiles(baseAbs);
  let out;
  if (!q) {
    out = files.slice(0, QUICKOPEN_CAP);
  } else {
    const ranked = [];
    for (const p of files) {
      const s = fuzzyRank(q, p);
      if (s >= 0) ranked.push([s, p]);
    }
    ranked.sort((a, b) => b[0] - a[0]);
    out = ranked.slice(0, QUICKOPEN_CAP).map((r) => r[1]);
  }
  sendJson(res, 200, { files: out.map((p) => ({ path: p })), truncated });
}

// --- ports + forwarding ----------------------------------------------------
// GET /api/ports → {ports:[n]} — LISTEN sockets parsed from /proc/net/tcp{,6}
// (Linux; other platforms return an empty list and the UI falls back to
// manual entry). The server's own port is excluded.
async function apiPorts(res) {
  const ports = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt;
    try { txt = await fs.readFile(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue; // 0A = LISTEN
      const p = parseInt(cols[1].split(':').pop(), 16);
      if (p && p !== port) ports.add(p);
    }
  }
  sendJson(res, 200, { ports: [...ports].sort((a, b) => a - b) });
}

// /proxy/<port>/rest → 127.0.0.1:<port>/rest — HTTP and WebSocket both, so a
// dev server started in the integrated terminal is reachable through this
// server from anywhere the editor is. Same trust model as everything else:
// permissive by default, gated by --auth when enabled. Every upstream
// connection is tied to its client request/socket and destroyed with it —
// no strays.
function parseProxyPath(pathname) {
  const m = /^\/proxy\/(\d{1,5})(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const p = Number(m[1]);
  if (!p || p > 65535) return null;
  return { port: p, rest: m[2] ?? null };
}

function proxyHttp(req, res, target, url) {
  const headers = { ...req.headers };
  delete headers.host;
  const up = http.request(
    { host: '127.0.0.1', port: target.port, path: target.rest + url.search, method: req.method, headers },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    },
  );
  up.on('error', (e) => {
    if (!res.headersSent) sendJson(res, 502, { error: `127.0.0.1:${target.port} — ${e.code ?? e.message}` });
    else res.destroy();
  });
  req.pipe(up);
  res.on('close', () => up.destroy());
}

function proxyUpgrade(req, socket, head, target, url) {
  const up = net.connect(target.port, '127.0.0.1', () => {
    let raw = `${req.method} ${target.rest}${url.search} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  up.on('close', () => socket.destroy());
  socket.on('close', () => up.destroy());
}

// --- static client ---------------------------------------------------------

async function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.resolve(DIST, '.' + rel);
  if (!abs.startsWith(DIST)) {
    res.writeHead(400);
    return res.end('bad path');
  }
  try {
    const buf = await fs.readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    // SPA fallback → index.html; if the dist doesn't exist at all, hint dev flow.
    try {
      const buf = await fs.readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(buf);
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('client bundle not built — run `npm run build:server`, or use the vite dev server (`npm run dev:server`) which proxies /api here');
    }
  }
}

// --- server ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Tunnel hygiene: the auth token can ride in the URL — never leak it via Referer.
  res.setHeader('referrer-policy', 'no-referrer');
  if (!authorized(req, url)) {
    return sendJson(res, 401, { error: 'auth token required (--auth is enabled); open /?token=<token>' });
  }
  if (auth && url.searchParams.get('token') === auth) {
    // Persist the token so subsequent fetches/websockets authenticate via cookie.
    res.setHeader('set-cookie', `gmd_token=${auth}; HttpOnly; SameSite=Strict; Path=/`);
  }
  try {
    if (url.pathname === '/api/root' && req.method === 'GET') return await apiRoot(res);
    if (url.pathname === '/api/tree' && req.method === 'GET') return await apiTree(res, url.searchParams);
    if (url.pathname === '/api/file' && req.method === 'GET') return await apiFileGet(res, url.searchParams);
    if (url.pathname === '/api/file' && req.method === 'PUT') return await apiFilePut(req, res);
    if (url.pathname === '/api/search' && req.method === 'GET') return apiSearch(req, res, url.searchParams);
    if (url.pathname === '/api/context' && req.method === 'GET') return await apiContext(res, url.searchParams);
    if (url.pathname === '/api/git/repos' && req.method === 'GET') return await apiGitRepos(res);
    if (url.pathname === '/api/git/status' && req.method === 'GET') return await apiGitStatus(res, url.searchParams);
    if (url.pathname === '/api/git/diff' && req.method === 'GET') return await apiGitDiff(res, url.searchParams);
    if (url.pathname === '/api/git/action' && req.method === 'POST') return await apiGitAction(req, res);
    if (url.pathname === '/api/terminals' && req.method === 'GET') {
      return sendJson(res, 200, { terminals: [...sessions.values()].map(sessionInfo) });
    }
    if (url.pathname === '/api/terminals' && req.method === 'POST') {
      // "Open new terminal here": optional workspace-relative cwd.
      const cwdRel = url.searchParams.get('cwd');
      const cwdAbs = cwdRel ? resolveSafe(cwdRel) : null;
      if (cwdRel && !cwdAbs) return sendJson(res, 400, { error: 'cwd escapes root' });
      try {
        return sendJson(res, 200, sessionInfo(createSession(cwdAbs ?? undefined)));
      } catch (e) {
        return sendJson(res, 500, { error: `failed to spawn shell: ${String(e?.message ?? e)}` });
      }
    }
    if (url.pathname === '/api/terminals' && req.method === 'DELETE') {
      const ok = killSession(url.searchParams.get('id') ?? '');
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no such terminal' });
    }
    if (url.pathname === '/api/quickopen' && req.method === 'GET') return await apiQuickOpen(res, url.searchParams);
    if (url.pathname === '/api/ports' && req.method === 'GET') return await apiPorts(res);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });
    const px = parseProxyPath(url.pathname);
    if (px) {
      if (px.rest === null) {
        // Redirect /proxy/3000 → /proxy/3000/ so the app's relative URLs resolve.
        res.writeHead(302, { location: `/proxy/${px.port}/${url.search}` });
        return res.end();
      }
      return proxyHttp(req, res, px, url);
    }
    return await serveStatic(res, url.pathname);
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
});

// --- search (ripgrep, streamed) --------------------------------------------
// One rg process per request, its --json output translated into a compact
// NDJSON stream and flushed as it arrives. Streaming is the whole point: on a
// large tree the client paints its first hits in tens of milliseconds instead
// of waiting for the last file to be scanned.
//
//   GET /api/search?q=&path=&regex=1&word=1&case=1&glob=a,b
//   → {t:'f',path}                      a file with hits begins
//     {t:'m',line,text,cols:[[s,e]]}    one matching line (char offsets)
//     {t:'done',matches,files,truncated}
//     {t:'err',error}
const SEARCH_CAP = 2000;

// rg reports paths and lines as {text}, or {bytes: base64} for anything that
// is not valid UTF-8.
function rgText(o) {
  if (!o) return '';
  if (typeof o.text === 'string') return o.text;
  if (typeof o.bytes === 'string') return Buffer.from(o.bytes, 'base64').toString('utf8');
  return '';
}

// rg submatch offsets are BYTE offsets into the line; the client indexes a JS
// string. Convert, or every highlight after a non-ASCII character is skewed.
function charCols(text, subs) {
  const buf = Buffer.from(text, 'utf8');
  return (subs ?? []).map((s) => [
    buf.subarray(0, s.start).toString('utf8').length,
    buf.subarray(0, s.end).toString('utf8').length,
  ]);
}

function apiSearch(req, res, params) {
  const query = params.get('q') ?? '';
  if (!query) return sendJson(res, 400, { error: 'empty query' });
  const dir = resolveSafe(params.get('path') ?? '.');
  if (!dir) return sendJson(res, 400, { error: 'path escapes root' });

  const args = [
    '--json',
    '--no-messages',
    '--max-filesize', '2M',
    '--max-count', '200',
    '--max-columns', '400',
    '--max-columns-preview',
    params.get('case') === '1' ? '--case-sensitive' : '--ignore-case',
  ];
  // Literal by default, like the VS Code search box: the .* toggle opts into
  // regex rather than making every stray ( or ? a syntax error.
  if (params.get('regex') !== '1') args.push('--fixed-strings');
  if (params.get('word') === '1') args.push('--word-regexp');
  for (const g of (params.get('glob') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    args.push('--glob', g);
  }
  args.push('--', query, dir);

  const rg = spawn('rg', args, { cwd: ROOT });

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    // Reverse proxies buffer by default and silently collapse a stream into
    // one response at the end.
    'x-accel-buffering': 'no',
  });

  const send = (o) => res.write(JSON.stringify(o) + '\n');
  let pendingFile = null;
  let matches = 0;
  let fileCount = 0;
  let truncated = false;
  let tail = '';

  rg.on('error', (e) => {
    send({ t: 'err', error: e.code === 'ENOENT' ? 'ripgrep (rg) not found on PATH' : String(e.message ?? e) });
    res.end();
  });

  rg.stdout.on('data', (chunk) => {
    if (truncated) return;
    tail += chunk;
    const lines = tail.split('\n');
    tail = lines.pop() ?? '';
    for (const raw of lines) {
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === 'begin') {
        // Held back until the first match actually lands, so the client never
        // renders an empty file header.
        pendingFile = path.relative(ROOT, rgText(ev.data.path));
      } else if (ev.type === 'match') {
        if (pendingFile !== null) {
          send({ t: 'f', path: pendingFile });
          pendingFile = null;
          fileCount++;
        }
        const text = rgText(ev.data.lines).replace(/\r?\n$/, '');
        send({ t: 'm', line: ev.data.line_number ?? 0, text, cols: charCols(text, ev.data.submatches) });
        if (++matches >= SEARCH_CAP) {
          truncated = true;
          try { rg.kill('SIGKILL'); } catch {}
          break;
        }
      }
    }
  });

  rg.on('close', () => {
    send({ t: 'done', matches, files: fileCount, truncated });
    res.end();
  });

  // Retyping in the search box aborts the previous fetch. Without this the
  // orphaned rg keeps scanning the disk for a result nobody will read — the
  // same stray-process failure mode the terminal sessions had.
  req.on('close', () => { try { rg.kill('SIGKILL'); } catch {} });
}

// --- git (source control) ---------------------------------------------------
// A thin, synchronous shell over the git CLI. No libgit2, no daemon: every
// call is one short-lived `git` invocation, which keeps the whole feature
// dependency-free and behaves identically to what the user would type.
//
//   GET  /api/git/repos            repos under the workspace (depth-2 scan)
//   GET  /api/git/status?repo=     branch/ahead/behind + staged & unstaged files
//   GET  /api/git/diff?repo=&path=&staged=1   parsed hunks for one file
//   POST /api/git/action           {op: stage|unstage|discard|apply|commit}
const GIT_MAX = 16 * 1024 * 1024;
const GIT_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__']);

function git(args, cwd, input) {
  // --no-pager matters even for plumbing: a configured pager would otherwise
  // swallow stdout the moment someone sets core.pager globally.
  const r = spawnSync('git', ['--no-pager', ...args], { cwd, encoding: 'utf8', maxBuffer: GIT_MAX, input });
  if (r.error) {
    const msg = r.error.code === 'ENOENT' ? 'git not found on PATH' : String(r.error.message ?? r.error);
    return { code: -1, out: '', err: msg };
  }
  return { code: r.status ?? -1, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

// Reject anything that could climb out of the repo before it reaches the CLI.
// resolveSafe guards ROOT; this guards the repo-relative half.
function cleanRepoPath(p) {
  if (typeof p !== 'string' || !p) return null;
  if (p.startsWith('/') || p.split('/').includes('..')) return null;
  return p;
}

// Depth-2 scan rather than a single `rev-parse`: the workspace root is often a
// container of sibling checkouts (~/dev), not a repo itself. A directory that
// IS a repo is not descended into — anything below it is a submodule, which
// deserves its own treatment and would otherwise pollute the list.
async function findRepos(depth = 2) {
  const found = [];
  async function walk(abs, d) {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      found.push(abs);
      return;
    }
    if (d <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || GIT_SKIP.has(e.name)) continue;
      await walk(path.join(abs, e.name), d - 1);
    }
  }
  await walk(ROOT, depth);
  return found.map((a) => path.relative(ROOT, a) || '.');
}

// `## main...origin/main [ahead 1, behind 2]`, or `## HEAD (no branch)`, or
// `## No commits yet on main`.
function parseBranchLine(rec) {
  const out = { branch: '', upstream: '', ahead: 0, behind: 0 };
  let head = rec.slice(3);
  const noCommits = /^No commits yet on (.+)$/.exec(head);
  if (noCommits) return { ...out, branch: noCommits[1], empty: true };
  const bracket = /\s\[(.+)\]$/.exec(head);
  if (bracket) {
    head = head.slice(0, bracket.index);
    const ahead = /ahead (\d+)/.exec(bracket[1]);
    const behind = /behind (\d+)/.exec(bracket[1]);
    if (ahead) out.ahead = +ahead[1];
    if (behind) out.behind = +behind[1];
  }
  const dots = head.indexOf('...');
  if (dots === -1) out.branch = head;
  else {
    out.branch = head.slice(0, dots);
    out.upstream = head.slice(dots + 3);
  }
  return out;
}

// -z output is NUL-separated with no quoting, so paths containing spaces,
// quotes or newlines survive intact — the reason not to parse plain porcelain.
function parseStatus(z) {
  const parts = z.split('\0');
  const out = { branch: '', upstream: '', ahead: 0, behind: 0, empty: false, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith('## ')) {
      Object.assign(out, parseBranchLine(rec));
      continue;
    }
    const x = rec[0];
    const y = rec[1];
    const p = rec.slice(3);
    // Renames and copies emit the destination first, then the source as its
    // own record — consume it here or it reads back as a phantom file.
    const orig = x === 'R' || x === 'C' ? parts[++i] ?? null : null;
    out.files.push({ path: p, x, y, orig });
  }
  return out;
}

function parseDiff(text) {
  const hunks = [];
  let cur = null;
  let oldLn = 0;
  let newLn = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (!m) continue;
      oldLn = +m[1];
      newLn = +m[3];
      cur = {
        oldStart: +m[1],
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newLines: m[4] === undefined ? 1 : +m[4],
        section: m[5].trim(),
        lines: [],
      };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const t = raw[0];
    if (t === '+') cur.lines.push({ t: '+', n: newLn++, o: null, text: raw.slice(1) });
    else if (t === '-') cur.lines.push({ t: '-', n: null, o: oldLn++, text: raw.slice(1) });
    else if (t === ' ') cur.lines.push({ t: ' ', n: newLn++, o: oldLn++, text: raw.slice(1) });
    else if (t === '\\') cur.lines.push({ t: '\\', n: null, o: null, text: raw.slice(1) });
  }
  return hunks;
}

// Rebuild a hunk as a standalone patch containing only the selected lines.
// The asymmetric demotions are the whole trick behind line-level staging, and
// they MIRROR depending on which side the patch will be matched against:
//   forward apply (stage → index):   unselected '+' dropped, unselected '-'
//     demoted to context — the pre-image is the side WITHOUT the additions.
//   reverse apply (unstage/revert):  unselected '+' demoted to context — it
//     exists in the target file and must match — and unselected '-' dropped.
// Getting this backwards makes git reject the patch ("does not apply") the
// moment a hunk mixes selected and unselected changes.
function buildPatch(relPath, hunk, sel, reverse) {
  const body = [];
  let oldCount = 0;
  let newCount = 0;
  for (let i = 0; i < hunk.lines.length; i++) {
    const l = hunk.lines[i];
    if (l.t === '\\') {
      body.push('\\' + l.text);
      continue;
    }
    if (l.t === ' ') {
      body.push(' ' + l.text);
      oldCount++;
      newCount++;
      continue;
    }
    const on = sel.has(i);
    if (l.t === '+') {
      if (on) {
        body.push('+' + l.text);
        newCount++;
      } else if (reverse) {
        body.push(' ' + l.text);
        oldCount++;
        newCount++;
      }
    } else if (on) {
      body.push('-' + l.text);
      oldCount++;
    } else if (!reverse) {
      body.push(' ' + l.text);
      oldCount++;
      newCount++;
    }
  }
  const header = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
  return `--- a/${relPath}\n+++ b/${relPath}\n${header}\n${body.join('\n')}\n`;
}

function rawDiff(repoAbs, rel, staged, untracked) {
  const common = ['--no-color', '--no-ext-diff', '-U3'];
  // An untracked file has nothing to diff against, so compare it to /dev/null
  // rather than synthesising a hunk by hand — this also gets binary detection
  // and the missing-trailing-newline marker for free. It exits 1 by design.
  if (untracked) return git(['diff', '--no-index', ...common, '--', '/dev/null', rel], repoAbs);
  return git(['diff', ...common, ...(staged ? ['--cached'] : []), '--', rel], repoAbs);
}

async function apiGitRepos(res) {
  const repos = [];
  for (const rel of await findRepos()) {
    const abs = path.join(ROOT, rel === '.' ? '' : rel);
    const st = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--branch'], abs);
    if (st.code !== 0 && !st.out) {
      repos.push({ repo: rel, error: st.err || 'git status failed' });
      continue;
    }
    const s = parseStatus(st.out);
    repos.push({ repo: rel, branch: s.branch, ahead: s.ahead, behind: s.behind, changes: s.files.length });
  }
  return sendJson(res, 200, { repos });
}

async function apiGitStatus(res, params) {
  const repoRel = params.get('repo') ?? '.';
  const abs = resolveSafe(repoRel);
  if (!abs) return sendJson(res, 400, { error: 'repo escapes root' });
  const st = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--branch'], abs);
  if (st.code !== 0 && !st.out) return sendJson(res, 400, { error: st.err || 'not a git repository' });
  const s = parseStatus(st.out);

  // One worktree change and one index change for the same file are two
  // separate rows in the UI, exactly as VS Code shows them — so a file with
  // XY = 'MM' appears under both Staged and Changes.
  const staged = [];
  const changes = [];
  for (const f of s.files) {
    if (f.x === '?' ) {
      changes.push({ path: f.path, status: 'U', untracked: true });
      continue;
    }
    if (f.x !== ' ' && f.x !== '?') staged.push({ path: f.path, status: f.x, orig: f.orig });
    if (f.y !== ' ') changes.push({ path: f.path, status: f.y, untracked: false });
  }
  return sendJson(res, 200, {
    repo: repoRel,
    branch: s.branch,
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    empty: !!s.empty,
    staged,
    changes,
  });
}

async function apiGitDiff(res, params) {
  const repoRel = params.get('repo') ?? '.';
  const abs = resolveSafe(repoRel);
  if (!abs) return sendJson(res, 400, { error: 'repo escapes root' });
  const rel = cleanRepoPath(params.get('path'));
  if (!rel) return sendJson(res, 400, { error: 'bad path' });
  const staged = params.get('staged') === '1';
  const untracked = params.get('untracked') === '1';

  const d = rawDiff(abs, rel, staged, untracked);
  if (d.code === -1) return sendJson(res, 500, { error: d.err });
  if (/^Binary files /m.test(d.out) || /^GIT binary patch/m.test(d.out)) {
    return sendJson(res, 200, { path: rel, staged, binary: true, hunks: [] });
  }
  if (d.out.length > 2 * 1024 * 1024) {
    return sendJson(res, 200, { path: rel, staged, tooBig: true, hunks: [] });
  }
  return sendJson(res, 200, { path: rel, staged, untracked, hunks: parseDiff(d.out) });
}

async function apiGitAction(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const abs = resolveSafe(body.repo ?? '.');
  if (!abs) return sendJson(res, 400, { error: 'repo escapes root' });
  const paths = (body.paths ?? []).map(cleanRepoPath).filter(Boolean);
  const fail = (r) => sendJson(res, 400, { error: r.err || `git exited ${r.code}` });

  switch (body.op) {
    case 'stage': {
      if (!paths.length) return sendJson(res, 400, { error: 'no paths' });
      const r = git(['add', '-A', '--', ...paths], abs);
      return r.code === 0 ? sendJson(res, 200, { ok: true }) : fail(r);
    }
    case 'unstage': {
      if (!paths.length) return sendJson(res, 400, { error: 'no paths' });
      // `reset HEAD` is the universal form, but it needs a HEAD to exist — in a
      // repo with no commits yet the only way to unstage is rm --cached.
      const hasHead = git(['rev-parse', '--verify', '-q', 'HEAD'], abs).code === 0;
      const r = hasHead
        ? git(['reset', '-q', 'HEAD', '--', ...paths], abs)
        : git(['rm', '--cached', '-q', '-r', '--', ...paths], abs);
      return r.code === 0 ? sendJson(res, 200, { ok: true }) : fail(r);
    }
    case 'discard': {
      if (!paths.length) return sendJson(res, 400, { error: 'no paths' });
      for (const p of paths) {
        // A file git has never seen cannot be checked out; discarding it means
        // deleting it, which is what VS Code does too.
        const tracked = git(['ls-files', '--error-unmatch', '--', p], abs).code === 0;
        if (tracked) {
          const r = git(['checkout', '-q', '--', p], abs);
          if (r.code !== 0) return fail(r);
        } else {
          await fs.rm(path.join(abs, p), { recursive: true, force: true });
        }
      }
      return sendJson(res, 200, { ok: true });
    }
    case 'apply': {
      // Line-level stage / unstage / revert. The client sends the hunk index
      // and which of its lines are selected; the diff is recomputed here so the
      // patch is always built against the tree as it is right now.
      const rel = cleanRepoPath(body.path);
      if (!rel) return sendJson(res, 400, { error: 'bad path' });
      const mode = body.mode ?? 'stage';
      const fromIndex = mode === 'unstage';
      const d = rawDiff(abs, rel, fromIndex, !!body.untracked);
      if (d.code === -1) return sendJson(res, 500, { error: d.err });
      const hunks = parseDiff(d.out);
      const hunk = hunks[body.hunk ?? -1];
      if (!hunk) return sendJson(res, 409, { error: 'hunk no longer exists — refresh' });
      const sel = new Set(
        Array.isArray(body.lines) && body.lines.length
          ? body.lines
          : hunk.lines.map((l, i) => (l.t === '+' || l.t === '-' ? i : -1)).filter((i) => i >= 0),
      );
      // A selection containing no +/- line produces a context-only hunk, which
      // git rejects as a corrupt patch. Say so plainly instead.
      if (!hunk.lines.some((l, i) => (l.t === '+' || l.t === '-') && sel.has(i))) {
        return sendJson(res, 400, { error: 'selection contains no changed lines' });
      }
      const patch = buildPatch(rel, hunk, sel, mode !== 'stage');
      const args = ['apply', '--unidiff-zero', '--whitespace=nowarn'];
      if (mode === 'stage') args.push('--cached');
      if (mode === 'unstage') args.push('--cached', '--reverse');
      if (mode === 'revert') args.push('--reverse');
      args.push('-');
      const r = git(args, abs, patch);
      return r.code === 0 ? sendJson(res, 200, { ok: true }) : fail(r);
    }
    case 'commit': {
      const msg = String(body.message ?? '').trim();
      if (!msg && !body.amend) return sendJson(res, 400, { error: 'empty commit message' });
      const args = ['commit'];
      if (body.amend) args.push('--amend');
      args.push('-m', msg || 'amend');
      const r = git(args, abs);
      if (r.code !== 0) return sendJson(res, 400, { error: (r.err || r.out || 'commit failed').split('\n')[0] });
      return sendJson(res, 200, { ok: true, detail: r.out.split('\n')[0] });
    }
    default:
      return sendJson(res, 400, { error: `unknown op: ${String(body.op)}` });
  }
}

// --- terminals (ws + node-pty, multi-session) -------------------------------
// Sessions are server-owned and outlive their websockets: hiding a terminal,
// switching tabs or reloading the browser reattaches by id and replays the
// scrollback. Same model as the VS Code integrated terminal.
//
// Control plane (HTTP):
//   GET    /api/terminals       → {terminals:[{id,title,pid,cwdLabel}]}
//   POST   /api/terminals       → {id,...}   spawn a new shell
//   DELETE /api/terminals?id=x  → {ok:true}  kill the process
// Data plane (WS): /api/pty?id=<id>, JSON envelopes both ways:
//   client → server: {t:'d', d:string} stdin, {t:'r', cols, rows} resize
//   server → client: {t:'d', d:string} output, {t:'x', code} shell exited
const wss = new WebSocketServer({ noServer: true });

// Per-session replay buffer. Enough to repaint a full screen plus history
// after a reattach, small enough that N idle sessions stay cheap.
const SCROLLBACK = 200_000;

const sessions = new Map();
let termSeq = 0;

function createSession(cwd) {
  if (!pty) throw new Error(`terminal unavailable — node-pty is not installed (${ptyError})`);
  const shell = process.env.SHELL || '/bin/bash';
  // Login shell so the user's rc/profile chain loads — same feel as the
  // VS Code integrated terminal.
  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd ?? ROOT,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  const s = {
    id: `t${++termSeq}`,
    // "Open new terminal here" labels the tab with the folder it starts in.
    title: cwd && cwd !== ROOT ? `${path.basename(shell)} — ${path.basename(cwd)}` : path.basename(shell),
    pty: p,
    pid: p.pid,
    buf: '',
    sockets: new Set(),
  };
  p.onData((d) => {
    s.buf = (s.buf + d).slice(-SCROLLBACK);
    const frame = JSON.stringify({ t: 'd', d });
    for (const ws of s.sockets) if (ws.readyState === ws.OPEN) ws.send(frame);
  });
  p.onExit(({ exitCode }) => {
    // Shell exited (or was killed) → the session is gone, exactly like a VS
    // Code terminal tab closing itself. Attached clients drop the tab.
    sessions.delete(s.id);
    const frame = JSON.stringify({ t: 'x', code: exitCode ?? 0 });
    for (const ws of s.sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(frame);
        ws.close();
      }
    }
    s.sockets.clear();
  });
  sessions.set(s.id, s);
  return s;
}

function sessionInfo(s) {
  return { id: s.id, title: s.title, pid: s.pid };
}

// Kill the shell AND everything it started. Two passes, because one is not
// enough: node-pty's child is a session leader (pid === pgid === sid), so the
// negative-pid signal reaches the shell plus its foreground job — but under
// job control every background job gets its own process group, so those need
// the session-wide sweep to avoid becoming strays.
function killTree(s) {
  try { process.kill(-s.pid, 'SIGKILL'); } catch {}
  try { s.pty.kill('SIGKILL'); } catch {}
  try { spawnSync('pkill', ['-9', '-s', String(s.pid)], { timeout: 2000 }); } catch {}
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  killTree(s);
  sessions.delete(id);
  return true;
}

// Never outlive the server. Signal handlers cover Ctrl-C, systemd stop and a
// closed launching terminal; the exit hook covers clean exits and uncaught
// throws. A SIGKILL of this process runs none of them — there the kernel's
// SIGHUP-on-pty-master-close is the only backstop, which is exactly why the
// group + session sweep above matters everywhere else.
let shuttingDown = false;

function killAllSessions() {
  for (const s of sessions.values()) killTree(s);
  sessions.clear();
}

process.on('exit', killAllSessions);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    killAllSessions();
    process.exit(sig === 'SIGINT' ? 130 : 0);
  });
}
process.on('uncaughtException', (e) => {
  console.error(e);
  killAllSessions();
  process.exit(1);
});

// Attach a socket to an existing session. The socket is a *view* onto the
// pty — closing it (tab switch, reload) never kills the shell; only an
// explicit DELETE or the shell exiting does.
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const s = sessions.get(url.searchParams.get('id') ?? '');
  if (!s) {
    ws.send(JSON.stringify({ t: 'x', code: 0 }));
    ws.close();
    return;
  }
  s.sockets.add(ws);
  if (s.buf) ws.send(JSON.stringify({ t: 'd', d: s.buf }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'd' && typeof msg.d === 'string') s.pty.write(msg.d);
    else if (msg.t === 'r' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      try { s.pty.resize(Math.max(2, msg.cols), Math.max(1, msg.rows)); } catch {}
    }
  });
  ws.on('close', () => {
    s.sockets.delete(ws);
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!authorized(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const px = parseProxyPath(url.pathname);
  if (px && px.rest !== null) return proxyUpgrade(req, socket, head, px, url);
  if (url.pathname !== '/api/pty') return socket.destroy();
  if (!pty) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// --- public tunnel (optional) ----------------------------------------------
// `--tunnel` shells out to a tunnel binary as a CHILD process dialing
// 127.0.0.1:<port> — the local server never blocks on it and keeps working if
// it dies. Default provider is cloudflared's quick tunnel (no account, real
// TLS, WebSocket-verified). `--tunnel funnel` uses Tailscale Funnel for a
// stable hostname; note Funnel strips ?query on WS upgrades, so land on
// /?token= first to pick up the auth cookie before the terminal connects.
let tunnelChild = null;
process.on('exit', () => { try { tunnelChild?.kill('SIGTERM'); } catch {} });

function startTunnel(provider) {
  const bin = tunnelBin ?? (provider === 'funnel' ? 'tailscale' : 'cloudflared');
  const args = provider === 'funnel'
    ? ['funnel', String(port)]
    : ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ error: String(e?.message ?? e) });
    }
    tunnelChild = child;
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    // cloudflared prints the URL on stderr, tailscale on stdout — watch both.
    const scan = (d) => {
      out += d;
      const m = provider === 'funnel'
        ? /https:\/\/[^\s|]+\.ts\.net[^\s|]*/.exec(out)
        : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(out);
      if (m) finish({ url: m[0].replace(/\/+$/, '') });
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (e) => {
      finish({ error: e.code === 'ENOENT' ? `${bin} not found on PATH` : String(e.message ?? e) });
    });
    child.on('exit', (code) => {
      if (!done) finish({ error: `${bin} exited ${code} before printing a URL${out ? `:\n${out.trim().split('\n').slice(-4).join('\n')}` : ''}` });
      else console.error(`  !! tunnel process exited (${code}) — the public URL is dead; local server still up.`);
      tunnelChild = null;
    });
    // No URL in 30s → give up but KEEP SERVING locally. Never exit non-zero
    // here — a missing tunnel binary must not reproduce the node-pty
    // silent-death failure shape.
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish({ error: 'no public URL after 30s — gave up (server keeps running locally)' });
    }, 30_000);
  });
}

server.listen(port, host, () => {
  console.log(`gh-md-editor server mode`);
  console.log(`  root: ${ROOT}`);
  console.log(`  url:  http://${host}:${port}/${auth ? `?token=${auth}` : ''}`);
  if (!pty) {
    console.warn('');
    console.warn('  !! terminal disabled: node-pty could not be loaded.');
    console.warn(`  !!   ${ptyError}`);
    console.warn('  !! Editor, git, search and port forwarding all work regardless.');
    console.warn('  !! To enable the terminal, install a toolchain and reinstall:');
    console.warn('  !!   Debian/Ubuntu: apt-get install -y build-essential python3');
    console.warn('');
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1';
  if (!loopback && !auth) {
    console.warn('');
    console.warn('  !! WARNING: listening on a non-loopback interface with NO auth.');
    console.warn('  !! The /api/pty terminal endpoint hands anyone who can reach this');
    console.warn('  !! port a full shell running as your user.');
    console.warn('  !! Opt in to auth: --auth <token>  (then open /?token=<token>)');
    console.warn('');
  }
  if (tunnel) {
    console.log(`  tunnel: starting ${tunnel}…`);
    startTunnel(tunnel).then((r) => {
      if (r.error) {
        console.warn(`  !! tunnel failed: ${r.error}`);
        console.warn('  !! local server unaffected — fix the tunnel binary and restart to retry.');
        return;
      }
      console.log('');
      console.log(`  PUBLIC: ${r.url}/?token=${auth}`);
      console.log('  !! anyone with this full URL gets a shell as your user — share with care.');
      console.log('  !! the tunnel dies when this process exits; the URL is not reusable.');
    });
  }
});
