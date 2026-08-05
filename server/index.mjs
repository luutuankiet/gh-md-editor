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
import { registerServer, patchServer, unregisterServer, run as runDaemon, VERSION } from './daemon.mjs';

// `up` / `down` / `list-servers` never touch the server itself, and node-pty
// just below is a native addon. Dispatch before paying for it. Safe this
// early because ESM evaluates every import in the file before any statement
// in it, so daemon.mjs is already loaded here.
{
  const sub = process.argv[2];
  if (sub === 'up' || sub === 'down' || sub === 'ls' || sub === 'list-servers' || sub === 'upgrade') {
    process.exit(await runDaemon(sub, process.argv.slice(3)));
  }
}
// A pty and ripgrep are the two native pieces of this server, and both used to
// be the user's problem: node-pty compiled from source (make/g++/python3, or
// the whole install aborted) and ripgrep had to already be on PATH or search
// silently found nothing. Both are now OPTIONAL dependencies whose packages
// ship per-platform PREBUILT binaries — npm downloads only the one matching
// this host, there is no compiler and no postinstall download, and a platform
// nobody built for degrades instead of aborting. That last part is
// load-bearing: as a hard dependency a failed native build killed
// `npx @luutuankiet/gh-md-editor` outright, and because npm hides
// install-script output the symptom was brutal — NOTHING printed, exit 1
// (measured on Node 24 + a host without make).
const require_ = createRequire(import.meta.url);

// Prebuilt archives lose the executable bit distressingly often. Upstream
// node-pty 1.1.0 publishes its macOS spawn-helper as 0644 inside the tarball
// itself, which turns the terminal on every Mac into "posix_spawnp failed" —
// verified by unpacking the published package. The binaries used here have
// correct modes, so this is insurance: a couple of syscalls at boot against a
// class of packaging bug that is invisible until a user hits it.
async function ensureExec(file) {
  try {
    const st = await fs.stat(file);
    if (!(st.mode & 0o111)) await fs.chmod(file, 0o755);
    return true;
  } catch {
    return false;
  }
}

// Prebuilts live in a sibling package named for the platform, resolved the
// same way the loader itself resolves them.
function nativePkgDir(name) {
  try {
    return path.dirname(require_.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

let pty = null;
let ptyError = '';
try {
  // Heal before the first spawn, not after a user has already been told their
  // terminal is broken.
  const dir = nativePkgDir(`@lydell/node-pty-${process.platform}-${process.arch}`);
  if (dir) await ensureExec(path.join(dir, 'spawn-helper'));
  pty = (await import('@lydell/node-pty')).default;
} catch (e) {
  ptyError = String(e?.message ?? e).split('\n')[0];
}

// Search and quick open are whole panels that go quietly empty without
// ripgrep, which is the worst failure shape there is: nothing looks broken,
// results just never appear. So it ships with the package. A host `rg` is the
// fallback for platforms the prebuilt does not cover.
let rgBin = '';
try {
  // import(), not require(): the package's loader is an ES module, and
  // require()ing one throws ERR_REQUIRE_ESM on Node 20.12 while working fine
  // on 22. Both are inside the >=20 range this package claims, and the throw
  // is swallowed by the catch below — so the require() form fails invisibly on
  // older-Node machines and quietly gives back the empty search panel this is
  // meant to fix.
  const mod = await import('@vscode/ripgrep');
  const rgPath = mod.rgPath ?? mod.default?.rgPath;
  if (rgPath && await ensureExec(rgPath)) rgBin = rgPath;
} catch { /* no prebuilt for this platform — fall back below */ }
if (!rgBin && onPath('rg')) rgBin = 'rg';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, closeSync, mkdirSync, openSync, statSync, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';
import https from 'node:https';
import dns from 'node:dns';
import { createRequire } from 'node:module';
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
  else if (a === '--port' || a === '-p') port = Number(argv[++i]);
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
    console.log('usage: gh-md-editor [dir] [--host 127.0.0.1] [--port|-p 8790] [--auth <token>] [--tunnel [cloudflared|funnel]] [--tunnel-bin <path>]');
    console.log('');
    console.log('  background mode — outlives the ssh session that started it:');
    console.log('    gh-md-editor up [dir] [-p PORT] […]   start detached, print the url, return');
    console.log('    gh-md-editor list-servers             every running server + its url  (alias: ls)');
    console.log('    gh-md-editor down [-p PORT] [--all]   stop one, pick from a list, or stop all');
    console.log('    gh-md-editor upgrade [-p PORT]        restart running servers onto this version');
    console.log('    gh-md-editor up --help                more on background mode');
    console.log('');
    console.log('  --tunnel        public HTTPS URL, auth forced on. Downloads cloudflared once');
    console.log('                  into ~/.cache/gh-md-editor if it is not already installed.');
    console.log('  --tunnel funnel Tailscale Funnel instead — needs tailscale installed and logged in.');
    console.log('');
    console.log('  optional host tools: ripgrep (search + quick open), git (source control),');
    console.log('  a C toolchain (integrated terminal). Everything else works without them.');
    process.exit(0);
  } else if (!a.startsWith('-')) rootArg = a;
}
// A tunnel URL is reachable by the whole internet and /api/pty is a shell —
// force auth on. The token is minted server-side (not user-supplied) so a
// bare `--tunnel` can never ship an unauthenticated public shell.
if (tunnel && !auth) auth = crypto.randomBytes(16).toString('base64url');
const ROOT = path.resolve(process.cwd(), rootArg);
// Shipped alongside this file and prepended to every integrated shell's PATH,
// which is what makes `code-gh` resolve inside the terminal and nowhere else.
const BIN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'bin');

// --- helpers ---------------------------------------------------------------

// Resolve a client-supplied path. Relative paths resolve against ROOT and
// reject escapes; absolute paths pass through (see note in the body).
function resolveSafe(rel) {
  // Absolute paths pass through on purpose: the workspace browser anchors
  // sessions anywhere on the machine, and the terminal is already a full
  // shell as the running user — the root jail guards against *accidental*
  // escapes, so it keeps applying to relative paths only.
  if (typeof rel === 'string' && path.isAbsolute(rel)) return path.resolve(rel);
  const abs = path.resolve(ROOT, rel ?? '.');
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

// The shape a path takes on its way back to the browser. Inside the served
// root it stays relative, so URLs and session keys match every workspace that
// already exists; outside it stays absolute, because the relative form would
// be '../..' — exactly the shape resolveSafe rejects the moment the client
// sends it back, which turned an outside-root open into a dead tab.
function toClientPath(abs) {
  if (abs === ROOT) return '.';
  if (abs.startsWith(ROOT + path.sep)) return path.relative(ROOT, abs);
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
  // The hostname is what lets one browser tab be told apart from another when
  // several machines are each serving a workspace of their own.
  sendJson(res, 200, { root: ROOT, sep: path.sep, host: os.hostname() });
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
  const ignored = ignoredNames(abs, out);
  for (const e of out) if (ignored.has(e.name)) e.ignored = true;
  sendJson(res, 200, { entries: out });
}

// One spawn per directory listing, never one per entry: the plumbing reads
// NUL-delimited paths from stdin and echoes back only the ignored ones, so a
// single call answers the whole level. Exit 1 (nothing matched) and 128 (not
// a work tree) are both silent no-ops — a folder outside any repo simply has
// nothing to dim.
function ignoredNames(dir, entries) {
  const set = new Set();
  if (!entries.length) return set;
  const input = entries.map((e) => e.name).join('\0') + '\0';
  const r = git(['check-ignore', '--stdin', '-z'], dir, input);
  if (r.code !== 0) return set;
  for (const name of r.out.split('\0')) if (name) set.add(name);
  return set;
}

// Directory listing for the workspace browser. Unlike /api/tree this speaks
// ABSOLUTE paths and may leave the served root — its whole job is picking
// the next anchor. Dotfolders are listed, as VS Code's remote dialog does.
async function apiBrowse(res, params) {
  const raw = params.get('path') || ROOT;
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return sendJson(res, e.code === 'ENOENT' ? 404 : 500, { error: String(e.message ?? e), path: abs });
  }
  const out = [];
  for (const e of dirents) {
    let type = e.isDirectory() ? 'dir' : 'file';
    // A symlinked directory must be descendable, so links resolve to what
    // they point at (broken ones degrade to plain files).
    if (e.isSymbolicLink()) {
      try { type = (await fs.stat(path.join(abs, e.name))).isDirectory() ? 'dir' : 'file'; } catch { type = 'file'; }
    }
    out.push({ name: e.name, type });
  }
  out.sort((a, b) =>
    (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
    a.name.localeCompare(b.name)
  );
  const parent = path.dirname(abs);
  sendJson(res, 200, { path: abs, parent: parent === abs ? null : parent, sep: path.sep, entries: out });
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

// Publishing a temp file under its real name. rename() is the atomic form and
// stays the default, but some destinations cannot be replaced by a
// directory-entry swap at all — a bind-mounted file, a target on another
// filesystem — and there the destination inode has to survive the write, so
// its bytes are overwritten in place instead.
async function commitTemp(tmp, abs) {
  try {
    return await fs.rename(tmp, abs);
  } catch (e) {
    if (!['EBUSY', 'EPERM', 'EXDEV'].includes(e?.code)) throw e;
  }
  await fs.copyFile(tmp, abs);
  await fs.rm(tmp, { force: true }).catch(() => {});
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
    try {
      await fs.writeFile(tmp, content, 'utf8');
      await commitTemp(tmp, abs);
    } catch (e) {
      // Otherwise a save that failed halfway leaves its scratch dotfile sitting
      // beside the file the user was editing, forever.
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    const st2 = await fs.stat(abs);
    sendJson(res, 200, { mtimeMs: st2.mtimeMs, size: st2.size });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message ?? e) });
  }
}

// --- upload (drop files into the explorer) ----------------------------------
//   GET  /api/exists?path=<rel>&path=<rel>  → which of these are already there
//   POST /api/upload   (x-gmd-path: <urlencoded rel>)  → body streamed to disk
// The overwrite question is answered once, before any bytes move: a drop of
// forty files must not mean forty prompts, and a 409 partway through means the
// client already pushed a whole file to learn it was not wanted.
async function apiExists(res, params) {
  const rels = params.getAll('path').filter((p) => typeof p === 'string' && p.length);
  const existing = [];
  for (const rel of rels) {
    const abs = resolveSafe(rel);
    if (!abs) continue;
    // Echoed back verbatim: a normalised form would not match the entries the
    // client is holding, and it is comparing strings.
    if (await fs.stat(abs).then(() => true, () => false)) existing.push(rel);
  }
  sendJson(res, 200, { existing });
}

let uploadSeq = 0;

// One file per request, body straight to disk. This is the one endpoint that
// can be handed a gigabyte, so nothing buffers it — which also means no
// multipart parser, and the destination rides in a header instead.
async function apiUpload(req, res) {
  let rel;
  try {
    rel = decodeURIComponent(String(req.headers['x-gmd-path'] ?? ''));
  } catch {
    return sendJson(res, 400, { error: 'malformed x-gmd-path' });
  }
  if (!rel) return sendJson(res, 400, { error: 'x-gmd-path required' });
  const abs = resolveSafe(rel);
  if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.gmd-up-${process.pid}-${uploadSeq++}`);
  try {
    const st = await fs.stat(abs).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (st?.isDirectory()) return sendJson(res, 400, { error: `a folder already lives at ${rel}` });
    // A dropped folder arrives as a flat list of nested paths, so the parents
    // are made on the way in rather than in a round-trip per level.
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Temp file then rename, same directory: a half-uploaded file never
    // appears under the name something else may already be reading.
    await pipeline(req, createWriteStream(tmp));
    await commitTemp(tmp, abs);
    fileListCache.clear();
    const st2 = await fs.stat(abs);
    sendJson(res, 200, { path: toClientPath(abs), size: st2.size, mtimeMs: st2.mtimeMs });
  } catch (e) {
    // Otherwise an aborted upload leaves a dotfile in the tree nobody asked for.
    await fs.rm(tmp, { force: true }).catch(() => {});
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
}

// --- download (raw file / zip) ----------------------------------------------
//   GET /api/download?path=<rel>&path=<rel>&base=<rel>
// One plain file streams as itself; anything else (a folder, or a multi-select)
// is packed into a zip written straight to the socket. The archive is built by
// hand because the server is deliberately dependency-free — a zip is a header,
// the bytes, and a table of contents, and node:zlib already supplies the only
// hard part.

// No ZIP64 record is written, so these are the format's own ceilings rather
// than arbitrary policy.
const ZIP_MAX_ENTRIES = 65535;
const ZIP_MAX_TOTAL = 2 * 1024 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

// zlib.crc32 landed in Node 20.15 / 22.2; the table above keeps older runtimes
// producing valid archives instead of silently corrupt ones.
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf);
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Zip timestamps are MS-DOS: an epoch of 1980 and two-second resolution.
function dosStamp(d) {
  const y = d.getFullYear();
  if (y < 1980) return { time: 0, date: 0x21 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zipLocal(name, m) {
  const n = Buffer.from(name, 'utf8');
  const h = Buffer.alloc(30 + n.length);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0x0800, 6); // names are UTF-8
  h.writeUInt16LE(m.method, 8);
  h.writeUInt16LE(m.time, 10);
  h.writeUInt16LE(m.date, 12);
  h.writeUInt32LE(m.crc, 14);
  h.writeUInt32LE(m.csize, 18);
  h.writeUInt32LE(m.usize, 22);
  h.writeUInt16LE(n.length, 26);
  h.writeUInt16LE(0, 28);
  n.copy(h, 30);
  return h;
}

function zipCentral(name, m) {
  const n = Buffer.from(name, 'utf8');
  const h = Buffer.alloc(46 + n.length);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(m.method, 10);
  h.writeUInt16LE(m.time, 12);
  h.writeUInt16LE(m.date, 14);
  h.writeUInt32LE(m.crc, 16);
  h.writeUInt32LE(m.csize, 20);
  h.writeUInt32LE(m.usize, 24);
  h.writeUInt16LE(n.length, 28);
  h.writeUInt16LE(0, 30);
  h.writeUInt16LE(0, 32);
  h.writeUInt16LE(0, 34);
  h.writeUInt16LE(0, 36);
  // High word = unix mode, low bit 0x10 = the MS-DOS directory flag, so both
  // unzip families see a folder as a folder.
  h.writeUInt32LE(m.dir ? 0x41ed0010 : 0x81a40000, 38);
  h.writeUInt32LE(m.offset, 42);
  n.copy(h, 46);
  return h;
}

// A non-ASCII name has no portable home in the plain `filename`, so send a
// stripped copy for old clients plus the RFC 5987 form everything modern reads.
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function apiDownload(res, params) {
  const rels = params.getAll('path');
  if (!rels.length) return sendJson(res, 400, { error: 'path required' });
  const targets = [];
  for (const rel of rels) {
    const abs = resolveSafe(rel);
    if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
    let st;
    try { st = await fs.lstat(abs); } catch { return sendJson(res, 404, { error: `not found: ${rel}` }); }
    targets.push({ abs, st });
  }

  // Zipping a lone file would only make the user unpack it again.
  if (targets.length === 1 && targets[0].st.isFile()) {
    const { abs, st } = targets[0];
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(st.size),
      'content-disposition': contentDisposition(path.basename(abs)),
      'cache-control': 'no-store',
    });
    await new Promise((resolve) => {
      const s = createReadStream(abs);
      s.on('error', () => { res.destroy(); resolve(); });
      s.on('end', resolve);
      s.pipe(res);
    });
    return;
  }

  // Walk before writing: a selection the format cannot express has to fail as
  // JSON, while there are still no archive bytes on the wire to contradict.
  const entries = [];
  let total = 0;
  const walk = async (abs, name) => {
    let st;
    try { st = await fs.lstat(abs); } catch { return; }
    // Symlinks are never followed: they invite walk loops and can point clean
    // out of the workspace.
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      entries.push({ abs, name: `${name}/`, st, dir: true });
      let kids;
      try { kids = await fs.readdir(abs); } catch { return; }
      kids.sort((a, b) => a.localeCompare(b));
      for (const k of kids) await walk(path.join(abs, k), `${name}/${k}`);
    } else if (st.isFile()) {
      total += st.size;
      entries.push({ abs, name, st, dir: false });
    }
  };
  for (const t of targets) await walk(t.abs, path.basename(t.abs) || 'root');

  if (!entries.length) return sendJson(res, 404, { error: 'nothing to download' });
  if (entries.length > ZIP_MAX_ENTRIES) {
    return sendJson(res, 413, { error: `${entries.length} entries exceeds the ${ZIP_MAX_ENTRIES}-entry zip limit` });
  }
  if (total > ZIP_MAX_TOTAL) {
    return sendJson(res, 413, {
      error: `selection is ${Math.round(total / 1e6)} MB, over the ${Math.round(ZIP_MAX_TOTAL / 1e6)} MB download limit`,
    });
  }

  const baseAbs = resolveSafe(params.get('base') ?? '.') ?? ROOT;
  const zipName = targets.length === 1
    ? `${path.basename(targets[0].abs) || 'workspace'}.zip`
    : `${path.basename(baseAbs) || 'workspace'}-files.zip`;
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': contentDisposition(zipName),
    'cache-control': 'no-store',
    // The archive is chunked, so the only size knowable up front is what the
    // walk measured. The client shows it as an estimate and uses it to decide
    // whether a selection is worth cancelling.
    'x-gmd-bytes': String(total),
    'x-gmd-entries': String(entries.length),
  });

  // Await each write so a slow client throttles the walk instead of the whole
  // archive piling up in the socket buffer.
  const write = (buf) => new Promise((resolve, reject) => { res.write(buf, (e) => (e ? reject(e) : resolve())); });
  const central = [];
  let offset = 0;
  try {
    for (const e of entries) {
      const stamp = dosStamp(e.st.mtime);
      let body = Buffer.alloc(0);
      let meta;
      if (e.dir) {
        meta = { method: 0, crc: 0, csize: 0, usize: 0, dir: true, offset, ...stamp };
      } else {
        const raw = await fs.readFile(e.abs);
        const packed = zlib.deflateRawSync(raw);
        // Already-compressed assets grow under deflate, so store those verbatim.
        const store = packed.length >= raw.length;
        body = store ? raw : packed;
        meta = {
          method: store ? 0 : 8,
          crc: crc32(raw),
          csize: body.length,
          usize: raw.length,
          dir: false,
          offset,
          ...stamp,
        };
      }
      const local = zipLocal(e.name, meta);
      await write(local);
      if (body.length) await write(body);
      central.push(zipCentral(e.name, meta));
      offset += local.length + body.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    await write(cd);
    await write(eocd);
    res.end();
  } catch {
    // The headers are long gone, so a truncated archive the browser refuses is
    // the only honest signal left — cut the socket rather than end it cleanly.
    res.destroy();
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
    const child = spawn(rgBin || 'rg', ['--files'], { cwd: baseAbs });
    let buf = '';
    let truncated = false;
    // A missing rg used to resolve to an empty list with no error, so quick
    // open just silently found nothing. Carry the reason to the client.
    let error = '';
    const done = () => {
      const files = buf.split('\n').filter(Boolean);
      if (files.length > FILELIST_CAP) { files.length = FILELIST_CAP; truncated = true; }
      const entry = { at: Date.now(), files, truncated, error };
      fileListCache.set(baseAbs, entry);
      resolve(entry);
    };
    child.stdout.on('data', (d) => {
      if (buf.length < 8 * 1024 * 1024) buf += d;
      else truncated = true;
    });
    child.on('error', (e) => {
      error = e.code === 'ENOENT' ? 'ripgrep (rg) not found on PATH' : String(e.message ?? e);
      done();
    });
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

// Explorer delete. Repeatable ?path= — one call handles a whole multi-select.
// Every path is re-resolved through resolveSafe (a client is never trusted to
// stay inside the workspace) and the workspace root itself is never removable.
async function apiDeleteEntry(res, params) {
  const rels = params.getAll('path').filter((p) => typeof p === 'string' && p.length);
  if (!rels.length) return sendJson(res, 400, { error: 'path required' });
  const deleted = [];
  const errors = [];
  for (const rel of rels) {
    const abs = resolveSafe(rel);
    if (!abs) { errors.push({ path: rel, error: 'path escapes root' }); continue; }
    if (abs === ROOT) { errors.push({ path: rel, error: 'refusing to delete the workspace root' }); continue; }
    try {
      await fs.rm(abs, { recursive: true });
      deleted.push(rel);
    } catch (e) {
      errors.push({ path: rel, error: String(e?.message ?? e) });
    }
  }
  // The quick-open file list is now stale for every base it was cached under.
  fileListCache.clear();
  sendJson(res, 200, { deleted, errors });
}

// Explorer create. One entry per call, because the draft row in the tree names
// a single thing at a time. Existence is checked before the write rather than
// relying on mkdir's EEXIST, which recursive:true never raises.
async function apiCreateEntry(req, res) {
  let body;
  try {
    body = JSON.parse(String(await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const rel = typeof body.path === 'string' ? body.path : '';
  const type = body.type === 'dir' ? 'dir' : 'file';
  if (!rel) return sendJson(res, 400, { error: 'path required' });
  const abs = resolveSafe(rel);
  if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
  try {
    await fs.stat(abs);
    return sendJson(res, 409, { error: 'already exists' });
  } catch {
    // ENOENT is the happy path here.
  }
  try {
    if (type === 'dir') {
      await fs.mkdir(abs, { recursive: true });
    } else {
      // A name typed as a/b/c.txt creates the intermediate folders too, the
      // same way the quick-open path field already behaves.
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const fh = await fs.open(abs, 'wx');
      await fh.close();
    }
  } catch (e) {
    return sendJson(res, e?.code === 'EEXIST' ? 409 : 500, { error: String(e?.message ?? e) });
  }
  fileListCache.clear();
  sendJson(res, 200, { path: toClientPath(abs), type });
}

// Rename and drag-move share one route: a rename is a move whose parent does
// not change. Per-item errors, so a partial multi-move still tells the client
// exactly which paths landed and which did not.
async function apiMoveEntry(req, res) {
  let body;
  try {
    body = JSON.parse(String(await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const moves = Array.isArray(body.moves) ? body.moves : [];
  if (!moves.length) return sendJson(res, 400, { error: 'moves required' });
  const moved = [];
  const errors = [];
  for (const m of moves) {
    const from = typeof m?.from === 'string' ? m.from : '';
    const to = typeof m?.to === 'string' ? m.to : '';
    if (!from || !to) { errors.push({ from, to, error: 'from and to are both required' }); continue; }
    const src = resolveSafe(from);
    const dst = resolveSafe(to);
    if (!src || !dst) { errors.push({ from, to, error: 'path escapes root' }); continue; }
    if (src === ROOT) { errors.push({ from, to, error: 'refusing to move the workspace root' }); continue; }
    if (src === dst) { errors.push({ from, to, error: 'source and destination are the same' }); continue; }
    // Dropping a folder inside its own subtree would detach everything below
    // it. rename() reports EINVAL for some of these but not all, so the guard
    // is explicit rather than inherited.
    if (dst.startsWith(src + path.sep)) { errors.push({ from, to, error: 'cannot move a folder into itself' }); continue; }
    try {
      // rename() replaces an existing destination file silently, which for a
      // drag gesture means data loss with no undo. Refuse instead.
      let clash = false;
      try { await fs.stat(dst); clash = true; } catch { /* free */ }
      if (clash) { errors.push({ from, to, error: 'destination already exists' }); continue; }
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      moved.push({ from, to: toClientPath(dst) });
    } catch (e) {
      errors.push({ from, to, error: String(e?.message ?? e) });
    }
  }
  fileListCache.clear();
  sendJson(res, 200, { moved, errors });
}

async function apiQuickOpen(res, params) {
  const baseAbs = resolveSafe(params.get('path') || '.');
  if (!baseAbs) return sendJson(res, 400, { error: 'path escapes root' });
  const q = (params.get('q') ?? '').trim();
  const { files, truncated, error } = await listFiles(baseAbs);
  if (error) return sendJson(res, 200, { files: [], truncated: false, error });
  // dirs=1 -> the command palette's folder picker. The directory set is derived
  // from the already-cached `rg --files` listing (every ancestor of every file,
  // deduped) so folder search costs no extra process spawn.
  let pool = files;
  if (params.get('dirs') === '1') {
    const dirs = new Set(['.']);
    for (const f of files) {
      let i = f.lastIndexOf('/');
      while (i > 0) {
        dirs.add(f.slice(0, i));
        i = f.lastIndexOf('/', i - 1);
      }
    }
    pool = [...dirs].sort();
  }
  let out;
  if (!q) {
    out = pool.slice(0, QUICKOPEN_CAP);
  } else {
    const ranked = [];
    for (const p of pool) {
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
// --- version / self-upgrade ------------------------------------------------

// Literal, never from the request. This endpoint sits behind the same token as
// everything else, and a client-supplied package spec would turn that token
// into arbitrary code execution.
const PKG = '@luutuankiet/gh-md-editor';

// An npx or global install lands under a node_modules directory; a git
// checkout never does. That distinction is the only thing standing between a
// click in the browser and npm's published build overwriting a working copy.
const PUBLISHED_TREE = __dirname.includes(`${path.sep}node_modules${path.sep}`);
const CACHE_HOME = process.env.GH_MD_EDITOR_HOME || path.join(os.homedir(), '.cache', 'gh-md-editor');
const UPGRADE_LOG = path.join(CACHE_HOME, 'logs', 'upgrade.log');

// Reported by GET /api/version so the badge can explain itself, and enforced
// again by POST /api/upgrade so a stale client cannot talk its way past it.
function upgradeBlocker() {
  if (!PUBLISHED_TREE) {
    return 'running from a source checkout — upgrading would replace it with the published build. Use git.';
  }
  if (tunnel) {
    return 'this server is tunnelled — a restart mints a fresh public url and auth token, so this page could never reconnect. Upgrade from a terminal.';
  }
  return null;
}

function apiVersion(res) {
  const blocker = upgradeBlocker();
  sendJson(res, 200, {
    version: VERSION,
    pkg: PKG,
    port,
    upgradable: !blocker,
    reason: blocker,
    log: UPGRADE_LOG,
  });
}

// A server cannot upgrade itself in-process: it is running the old code, and
// the npx fetch that downloads the new code IS the upgrade. So the work goes
// to a detached child that outlives this process — the same manoeuvre the cli
// performs when `upgrade` is typed into a terminal owned by the server it is
// about to kill. spawn() calls setsid(), so the runner escapes both the
// process-group kill and the session sweep that are about to land here.
// Clearing GMD_PORT marks it as already-handed-off so it cannot bounce the
// work onwards again.
//
// --force because there is no staleness check: without it a server already on
// the latest release is skipped, comes back never, and the caller waits out
// its whole timeout for a no-op. A restart is the honest outcome of a click.
//
// Live terminal sessions die with the old process. Deliberately unprompted —
// same posture as the cli, which reports them afterwards rather than asking.
function apiUpgrade(res) {
  const blocker = upgradeBlocker();
  if (blocker) return sendJson(res, 409, { error: blocker });

  let fd;
  try {
    mkdirSync(path.dirname(UPGRADE_LOG), { recursive: true, mode: 0o700 });
    fd = openSync(UPGRADE_LOG, 'a', 0o600);
  } catch (e) {
    return sendJson(res, 500, { error: `cannot open ${UPGRADE_LOG}: ${String(e?.message ?? e)}` });
  }

  // npx ships beside the node binary running this. Falling back to PATH covers
  // the shim-based installs (volta, asdf) that put the two elsewhere.
  const sibling = path.join(path.dirname(process.execPath), 'npx');
  let bin = 'npx';
  try { if (statSync(sibling).isFile()) bin = sibling; } catch { /* PATH it is */ }

  const child = spawn(bin, ['-y', `${PKG}@latest`, 'upgrade', '--runner', '--force', '--port', String(port)], {
    cwd: os.homedir(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, GMD_PORT: '', GMD_TERM_ID: '', npm_config_yes: 'true' },
  });
  child.on('error', (e) => console.error(`upgrade: could not spawn ${bin} — ${e.message}`));
  child.unref();
  closeSync(fd);

  console.log(`upgrade requested from the editor — detached runner pid ${child.pid}, log ${UPGRADE_LOG}`);
  sendJson(res, 202, { from: VERSION, pid: child.pid, log: UPGRADE_LOG });
}

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

// Vite emits every asset under /assets/ with a content hash in its name, so the
// URL changes whenever the bytes do. That is the one case where a year-long
// immutable cache is safe — and it is what turns a reload on a slow link into
// no transfer at all. index.html carries those hashed URLs, so it must always
// be revalidated or a deploy would never reach an already-open tab.
function cacheControlFor(urlPath) {
  return urlPath.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

// Only text-shaped assets have sidecars; see scripts/precompress.mjs.
const PRECOMPRESSED = new Set(['.js', '.css', '.html', '.svg', '.json', '.map', '.txt', '.ico']);

// Serve a sidecar the client admits it can decode, brotli first. Falls through
// to the plain file when no sidecar exists, so a dist built without the
// precompress step still serves correctly.
async function encodedVariant(abs, accept) {
  if (!PRECOMPRESSED.has(path.extname(abs))) return null;
  for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
    if (!accept.includes(enc)) continue;
    try {
      const st = await fs.stat(abs + suffix);
      return { file: abs + suffix, enc, size: st.size };
    } catch { /* no sidecar for this one */ }
  }
  return null;
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.resolve(DIST, '.' + rel);
  if (!abs.startsWith(DIST)) {
    res.writeHead(400);
    return res.end('bad path');
  }
  const accept = String(req.headers['accept-encoding'] ?? '');
  try {
    const st = await fs.stat(abs);
    // Tagged from the ORIGINAL's size and mtime, never the sidecar's: the two
    // are interchangeable representations, and tagging them apart would make a
    // client that switches encodings refetch for nothing.
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream',
      'cache-control': cacheControlFor(urlPath),
      etag,
      // A shared cache keyed on URL alone would hand a brotli body to a client
      // that never asked for one.
      vary: 'accept-encoding',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const variant = await encodedVariant(abs, accept);
    if (variant) {
      const buf = await fs.readFile(variant.file);
      res.writeHead(200, { ...headers, 'content-encoding': variant.enc, 'content-length': String(buf.length) });
      return res.end(buf);
    }
    const buf = await fs.readFile(abs);
    res.writeHead(200, { ...headers, 'content-length': String(buf.length) });
    res.end(buf);
  } catch {
    // SPA fallback → index.html; if the dist doesn't exist at all, hint dev flow.
    try {
      const buf = await fs.readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
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
    if (url.pathname === '/api/browse' && req.method === 'GET') return await apiBrowse(res, url.searchParams);
    if (url.pathname === '/api/file' && req.method === 'GET') return await apiFileGet(res, url.searchParams);
    if (url.pathname === '/api/file' && req.method === 'PUT') return await apiFilePut(req, res);
    if (url.pathname === '/api/exists' && req.method === 'GET') return await apiExists(res, url.searchParams);
    if (url.pathname === '/api/upload' && req.method === 'POST') return await apiUpload(req, res);
    if (url.pathname === '/api/search' && req.method === 'GET') return apiSearch(req, res, url.searchParams);
    if (url.pathname === '/api/defs' && req.method === 'GET') return apiDefs(req, res, url.searchParams);
    if (url.pathname === '/api/context' && req.method === 'GET') return await apiContext(res, url.searchParams);
    if (url.pathname === '/api/download' && req.method === 'GET') return await apiDownload(res, url.searchParams);
    if (url.pathname === '/api/git/repos' && req.method === 'GET') return await apiGitRepos(res, url.searchParams);
    if (url.pathname === '/api/git/status' && req.method === 'GET') return await apiGitStatus(res, url.searchParams);
    if (url.pathname === '/api/git/diff' && req.method === 'GET') return await apiGitDiff(res, url.searchParams);
    if (url.pathname === '/api/diff/compare' && req.method === 'POST') return await apiDiffCompare(req, res);
    if (url.pathname === '/api/diff/apply' && req.method === 'POST') return await apiDiffApply(req, res);
    if (url.pathname === '/api/git/refs' && req.method === 'GET') return await apiGitRefs(res, url.searchParams);
    if (url.pathname === '/api/git/log' && req.method === 'GET') return await apiGitLog(res, url.searchParams);
    if (url.pathname === '/api/git/commit' && req.method === 'GET') return await apiGitCommit(res, url.searchParams);
    if (url.pathname === '/api/git/compare' && req.method === 'GET') return await apiGitCompare(res, url.searchParams);
    if (url.pathname === '/api/git/show' && req.method === 'GET') return await apiGitShow(res, url.searchParams);
    if (url.pathname === '/api/git/blame' && req.method === 'GET') return await apiGitBlame(res, url.searchParams);
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
    if (url.pathname === '/api/open' && req.method === 'POST') return await apiOpen(req, res);
    if (url.pathname === '/api/entry' && req.method === 'DELETE') return await apiDeleteEntry(res, url.searchParams);
    if (url.pathname === '/api/entry' && req.method === 'POST') return await apiCreateEntry(req, res);
    if (url.pathname === '/api/entry' && req.method === 'PATCH') return await apiMoveEntry(req, res);
    if (url.pathname === '/api/ports' && req.method === 'GET') return await apiPorts(res);
    if (url.pathname === '/api/version' && req.method === 'GET') return apiVersion(res);
    if (url.pathname === '/api/upgrade' && req.method === 'POST') return apiUpgrade(res);
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
    return await serveStatic(req, res, url.pathname);
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

// Go-to-definition without a language server. Ask ripgrep for the lines that
// look like a declaration of one identifier: keyword-led (`function foo`,
// `class Foo`, `def foo`), a Go method with a receiver, an assigned function
// expression, or a method signature opening a block. Call sites are
// deliberately excluded — "every mention of this word" is what the search panel
// already answers, and mixing the two makes the jump land somewhere useless.
const DEFS_CAP = 50;

function definitionPattern(name) {
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    `(?:^|[^\\w$.])(?:function|class|interface|type|enum|struct|impl|trait|module|namespace|def|fn|func|const|let|var|sub|proc)\\s+${id}\\b`,
    `^\\s*func\\s+\\([^)]*\\)\\s*${id}\\b`,
    `(?:^|[^\\w$.])${id}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\()`,
    `^\\s*(?:(?:public|private|protected|static|async|export|readonly)\\s+)*${id}\\s*\\([^)]*\\)\\s*(?::[^{;]*)?\\{\\s*$`,
  ].join('|');
}

// Buffered rather than streamed like /api/search: the cap is 50 lines, and the
// caller is a click that has to decide between jumping and showing a list.
function apiDefs(req, res, params) {
  const name = params.get('name') ?? '';
  // Anything that is not a bare identifier came from a mis-click, and would be
  // spliced straight into a regex below.
  if (!/^[A-Za-z_$][\w$]{0,127}$/.test(name)) return sendJson(res, 400, { error: 'not an identifier' });
  const dir = resolveSafe(params.get('path') ?? '.');
  if (dir === null) return sendJson(res, 400, { error: 'path escapes root' });

  const rg = spawn(rgBin || 'rg', [
    '--json',
    '--no-messages',
    '--case-sensitive',
    '--max-filesize', '2M',
    // A declaration repeated four times in one file is a re-export or an
    // overload set; more of the same file crowds out other candidates.
    '--max-count', '4',
    '--max-columns', '400',
    '-e', definitionPattern(name),
    '--', dir || '.',
  ], { cwd: ROOT });

  const hits = [];
  let truncated = false;
  let tail = '';
  let sent = false;
  const finish = (payload) => {
    if (sent) return;
    sent = true;
    sendJson(res, 200, payload);
  };

  rg.on('error', (e) => finish({
    hits: [],
    error: e.code === 'ENOENT' ? 'ripgrep (rg) not found on PATH' : String(e.message ?? e),
  }));

  rg.stdout.on('data', (chunk) => {
    tail += chunk;
    const lines = tail.split('\n');
    tail = lines.pop() ?? '';
    for (const l of lines) {
      if (!l) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      if (o.type !== 'match') continue;
      hits.push({
        path: toClientPath(rgText(o.data.path)),
        line: o.data.line_number ?? 1,
        text: rgText(o.data.lines).replace(/\r?\n$/, '').slice(0, 400),
      });
      if (hits.length >= DEFS_CAP) {
        truncated = true;
        rg.kill('SIGKILL');
        return;
      }
    }
  });

  rg.on('close', () => finish({ hits, truncated }));
  // A click can be abandoned by closing the tab mid-scan.
  req.on('close', () => { if (!sent) rg.kill('SIGKILL'); });
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

  const rg = spawn(rgBin || 'rg', args, { cwd: ROOT });

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
        pendingFile = toClientPath(path.resolve(ROOT, rgText(ev.data.path)));
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
//   POST /api/diff/compare         {leftPath, rightPath|rightText} → same hunks
//   POST /api/diff/apply           apply one compare hunk onto either side
//   GET  /api/git/refs?repo=       branch/tag names for the compare picker
//   GET  /api/git/log?repo=&limit=  commit DAG across all refs, for the graph
//   GET  /api/git/commit?repo=&sha= one commit's metadata + changed files
//   GET  /api/git/compare?repo=&base=&mode=   changed files vs a base ref
//   GET  /api/git/show?path=&stage=|&ref=     one file's committed content
//   GET  /api/git/blame?path=                 who last touched each line
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

// Blame is the one git call here that is routinely slow — a long-lived file
// with a deep history takes on the order of a second — so it is the one that
// cannot use the helper above: a spawnSync would hold the event loop for that
// whole second and stall every other request the window has in flight.
function gitAsync(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn('git', ['--no-pager', ...args], { cwd });
    let out = '';
    let err = '';
    let over = false;
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      if (over) return;
      if (out.length + d.length > GIT_MAX) { over = true; p.kill(); return; }
      out += d;
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      resolve({ code: -1, out: '', err: e.code === 'ENOENT' ? 'git not found on PATH' : String(e.message ?? e) });
    });
    p.on('close', (code) => {
      if (over) return resolve({ code: -1, out: '', err: 'blame output too large' });
      resolve({ code: code ?? -1, out, err: err.trim() });
    });
  });
}

// Reject anything that could climb out of the repo before it reaches the CLI.
// resolveSafe guards ROOT; this guards the repo-relative half.
function cleanRepoPath(p) {
  if (typeof p !== 'string' || !p) return null;
  if (p.startsWith('/') || p.split('/').includes('..')) return null;
  return p;
}

// Depth-2 scan rather than a single `rev-parse`: the anchor is often a
// container of sibling checkouts (~/dev), not a repo itself. A directory that
// IS a repo is not descended into — anything below it is a submodule, which
// deserves its own treatment and would otherwise pollute the list.
//
// The scan starts at the open workspace, not at the server's start directory,
// so the panel lists what the folder in view actually contains. Descending
// alone is not enough: anchoring *inside* a checkout (~/dev/repo/src) finds
// nothing below it, so the enclosing checkout is located by climbing first and
// listed ahead of the rest. For a workspace inside the start directory the
// climb stops there — repo ids are relative to it, so a repo above would be
// unaddressable. A workspace outside it addresses repos absolutely instead,
// so that one climbs all the way to the filesystem root.
async function findRepos(baseAbs = ROOT, depth = 2) {
  const found = [];
  const seen = new Set();
  const add = (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    found.push(abs);
  };
  for (let abs = baseAbs; ; ) {
    try {
      await fs.stat(path.join(abs, '.git'));
      add(abs);
      break;
    } catch {
      // not a checkout — keep climbing
    }
    if (abs === ROOT) break;
    const up = path.dirname(abs);
    if (up === abs) break; // filesystem root — dirname('/') is '/'
    abs = up;
  }
  async function walk(abs, d) {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      add(abs);
      return;
    }
    if (d <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || GIT_SKIP.has(e.name)) continue;
      await walk(path.join(abs, e.name), d - 1);
    }
  }
  await walk(baseAbs, depth);
  return found.map(toClientPath);
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

function rawDiff(repoAbs, rel, staged, untracked, base, head) {
  const common = ['--no-color', '--no-ext-diff', '-U3'];
  // An untracked file has nothing to diff against, so compare it to /dev/null
  // rather than synthesising a hunk by hand — this also gets binary detection
  // and the missing-trailing-newline marker for free. It exits 1 by design.
  // This wins over `base` on purpose: a file absent from the base tree has
  // the same whole-file-add shape whichever view asked for it.
  if (untracked) return git(['diff', '--no-index', ...common, '--', '/dev/null', rel], repoAbs);
  // Both sides pinned: the working tree is out of the picture entirely, which
  // is why every mutation refuses this shape (nothing on disk to patch).
  if (base && head) return git(['diff', ...common, base, head, '--', rel], repoAbs);
  // A base ref pins the old side to that commit's tree instead of the index —
  // exactly what the tree-compare view shows.
  if (base) return git(['diff', ...common, base, '--', rel], repoAbs);
  return git(['diff', ...common, ...(staged ? ['--cached'] : []), '--', rel], repoAbs);
}

// A ref is trusted only after git itself confirms it names a commit. The
// leading-dash rejection is not redundant with --end-of-options: the resolved
// ref is later spliced into OTHER argv positions (`git diff <ref>`) where a
// dash-shaped name could read as a flag.
function resolveRef(repoAbs, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) return null;
  const r = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], repoAbs);
  return r.code === 0 ? r.out.trim() : null;
}

// The commit DAG, flat. Parents come back as shas rather than a nested shape
// because the lane layout on the client walks the list top-down anyway, and a
// tree would have to be flattened again to draw it.
//
// `--topo-order` rather than date order: a graph whose edges cross backwards in
// time is unreadable, and commit dates are attacker- and rebase-controlled
// anyway. `--all` so branches nobody has checked out still show up.
async function apiGitLog(res, params) {
  const abs = resolveSafe(params.get('repo') ?? '.');
  if (!abs) return sendJson(res, 400, { error: 'repo escapes root' });
  const asked = Number(params.get('limit') ?? 400);
  const limit = Math.min(2000, Math.max(1, Number.isFinite(asked) ? asked : 400));
  const SEP = '\x1f';
  const r = git(
    [
      'log',
      '--all',
      '--topo-order',
      `--max-count=${limit}`,
      '--date=short',
      `--format=%H${SEP}%P${SEP}%an${SEP}%ad${SEP}%D${SEP}%s`,
    ],
    abs,
  );
  // An empty repository is not an error — it is a graph with nothing in it.
  if (r.code !== 0) {
    // "No commits yet" and "this is not a repository" look identical through
    // git log's exit code, and telling a user their history is empty when they
    // are simply pointed at the wrong folder sends them looking for the wrong
    // problem.
    if (git(['rev-parse', '--git-dir'], abs).code !== 0) {
      return sendJson(res, 400, { error: 'not a git repository' });
    }
    const empty = git(['rev-parse', '--verify', '-q', 'HEAD'], abs).code !== 0;
    if (!empty) return sendJson(res, 500, { error: r.err || 'git log failed' });
    return sendJson(res, 200, { commits: [], head: '', truncated: false });
  }
  const commits = [];
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    const [sha, parents, author, date, refs, subject] = line.split(SEP);
    commits.push({
      sha,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      date,
      // `%D` is "HEAD -> main, origin/main, tag: v1" — split here so the client
      // renders badges instead of re-parsing a display string.
      refs: refs ? refs.split(', ').filter(Boolean) : [],
      subject,
    });
  }
  const head = git(['rev-parse', 'HEAD'], abs);
  return sendJson(res, 200, {
    commits,
    head: head.code === 0 ? head.out.trim() : '',
    truncated: commits.length === limit,
  });
}

// One commit in full: the message body plus what it touched. Two spawns rather
// than one because a name-status listing and a formatted header cannot share a
// single --format without the client having to find the boundary between them.
async function apiGitCommit(res, params) {
  const abs = resolveSafe(params.get('repo') ?? '.');
  if (!abs) return sendJson(res, 400, { error: 'repo escapes root' });
  const sha = String(params.get('sha') ?? '').trim();
  // Anchored hex only: this string reaches a git argv, so a leading dash or a
  // rev-expression must never survive validation.
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return sendJson(res, 400, { error: 'bad sha' });
  const SEP = '\x1f';
  const meta = git(['show', '-s', '--date=iso', `--format=%H${SEP}%an${SEP}%ae${SEP}%ad${SEP}%P${SEP}%s${SEP}%b`, sha], abs);
  if (meta.code !== 0) return sendJson(res, 500, { error: meta.err || 'git show failed' });
  const [full, author, email, date, parents, subject, body] = meta.out.split(SEP);
  // --first-parent keeps a merge commit from listing every file on the branch
  // it absorbed; what a merge "changed" is what it changed relative to trunk.
  const ns = git(['show', '--name-status', '--first-parent', '--format=', sha], abs);
  const files = [];
  for (const line of ns.out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    // Renames arrive as "R096\told\tnew" — the path that matters is the last.
    files.push({
      status: parts[0][0],
      path: parts[parts.length - 1],
      from: parts.length > 2 ? parts[1] : undefined,
    });
  }
  return sendJson(res, 200, {
    sha: full,
    author,
    email,
    date,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    subject,
    body: (body ?? '').trim(),
    files,
  });
}

async function apiGitRefs(res, params) {
  const abs = resolveSafe(params.get('repo') ?? '.');
  if (!abs) return sendJson(res, 400, { error: 'repo escapes root' });
  // One spawn, six NUL-separated fields per ref: the picker wants the same
  // subtitle a log view would show — who moved it, when, and what its tip says.
  const FIELDS = ['refname:short', 'refname', 'objectname:short', 'authorname', 'committerdate:relative', 'contents:subject'];
  const r = git(
    [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${FIELDS.map((f) => `%(${f})`).join('%00')}`,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ],
    abs,
  );
  if (r.code !== 0) return sendJson(res, 500, { error: r.err || 'git for-each-ref failed' });
  const details = [];
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    const [name, full, sha, author, when, subject] = line.split('\0');
    // `origin` alone is origin/HEAD's short name — an alias, not a pickable ref.
    if (!name || name === 'origin') continue;
    const kind = full.startsWith('refs/heads/') ? 'local' : full.startsWith('refs/tags/') ? 'tag' : 'remote';
    details.push({ name, kind, sha, author, when, subject });
  }
  // Kept beside `details` because the compare picker wants nothing but names.
  const refs = details.map((d) => d.name);
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], abs);
  return sendJson(res, 200, { refs, details, head: head.code === 0 ? head.out.trim() : '' });
}

async function apiGitCompare(res, params) {
  const abs = resolveSafe(params.get('repo') ?? '.');
  if (!abs) return sendJson(res, 400, { error: 'repo escapes root' });
  const baseSha = resolveRef(abs, params.get('base'));
  if (!baseSha) return sendJson(res, 400, { error: 'unknown ref' });
  // The incoming side. Absent means the working tree — the historical shape,
  // and the only one where restoring a file from the base is coherent.
  let headSha = '';
  if (params.get('head')) {
    headSha = resolveRef(abs, params.get('head'));
    if (!headSha) return sendJson(res, 400, { error: 'unknown incoming ref' });
  }
  // Merge-base by default mirrors a PR review: only this branch's own work
  // shows up, not everything the base gained since. `mode=direct` compares
  // the trees head-on instead. The resolved sha is returned so every later
  // call (per-file diff, restore) pins to the SAME tree even if HEAD moves.
  let base = baseSha;
  if (params.get('mode') !== 'direct') {
    const mb = git(['merge-base', baseSha, headSha || 'HEAD'], abs);
    if (mb.code === 0) base = mb.out.trim();
  }
  const d = git(
    ['diff', '--no-color', '--no-renames', '--name-status', '-z', base, ...(headSha ? [headSha] : []), '--'],
    abs,
  );
  if (d.code !== 0) return sendJson(res, 500, { error: d.err || 'git diff failed' });
  const files = [];
  const parts = d.out.split('\0');
  for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) {
    files.push({ status: parts[i][0], path: parts[i + 1] });
  }
  // Untracked files never show in a ref diff but ARE part of "my tree vs
  // base", so they are appended with the panel's usual U badge. With an
  // incoming ref pinned they are not part of the comparison at all.
  if (!headSha) {
    const u = git(['ls-files', '--others', '--exclude-standard', '-z'], abs);
    if (u.code === 0) {
      for (const p of u.out.split('\0')) if (p) files.push({ status: 'U', path: p });
    }
  }
  return sendJson(res, 200, {
    base: params.get('base'),
    resolved: base,
    head: params.get('head') ?? '',
    resolvedHead: headSha,
    files,
  });
}

// One file's content as git has it, for the editor's inline change gutter and
// (with an explicit stage) for the three-way merge view. The repo is derived
// from the file rather than passed in: the editor knows which file it has open
// and nothing else, and asking it to also work out which checkout that file
// belongs to would duplicate what the CLI already does correctly.
async function apiGitShow(res, params) {
  const abs = resolveSafe(params.get('path'));
  if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
  const top = git(['rev-parse', '--show-toplevel'], path.dirname(abs));
  if (top.code !== 0) return sendJson(res, 200, { tracked: false, reason: 'not a git repository' });
  const repoAbs = top.out.trim();
  const rel = path.relative(repoAbs, abs);
  if (!rel || rel.startsWith('..')) return sendJson(res, 400, { error: 'path escapes repo' });

  // An explicit stage wins: 1/2/3 are the conflict stages (base, ours, theirs)
  // that the three-way view is built from, 0 is the ordinary index entry.
  // Otherwise the index is tried first and HEAD is the fallback, which is what
  // makes the gutter mark UNSTAGED work only — stage a hunk and it stops being
  // marked, exactly as VS Code behaves.
  const stage = params.get('stage');
  const ref = params.get('ref');
  let specs;
  if (stage) {
    if (!/^[0-3]$/.test(stage)) return sendJson(res, 400, { error: 'bad stage' });
    specs = [[`:${stage}:${rel}`, `stage${stage}`]];
  } else if (ref) {
    const sha = resolveRef(repoAbs, ref);
    if (!sha) return sendJson(res, 400, { error: 'unknown ref' });
    specs = [[`${sha}:${rel}`, ref]];
  } else {
    specs = [[`:0:${rel}`, 'index'], [`HEAD:${rel}`, 'HEAD']];
  }

  for (const [spec, source] of specs) {
    const r = git(['show', spec], repoAbs);
    if (r.code !== 0) continue;
    // A NUL byte is git's own binary heuristic, and the only test that matters
    // here: neither the gutter nor the merge view can display bytes.
    if (r.out.includes('\0')) return sendJson(res, 200, { tracked: true, binary: true, source });
    return sendJson(res, 200, { tracked: true, binary: false, source, path: rel, content: r.out });
  }
  // Untracked, or added since the ref asked for — nothing to compare against.
  return sendJson(res, 200, { tracked: false, reason: 'no such object' });
}

// --incremental rather than --line-porcelain: the same information, but each
// commit's metadata is emitted once instead of once per line. On a file where
// a handful of commits own everything — which is most files — that repetition
// is the bulk of the output.
//
// The wire shape keeps the same economy: commits are deduplicated into a list
// and each line carries an index into it, so a thousand-line file blamed to
// five commits sends five commit records rather than a thousand.
function parseBlameIncremental(out) {
  const commits = [];
  const seen = new Map();
  const lines = [];
  let cur = null;
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    // Every group starts with <sha> <orig-line> <final-line> <line-count>;
    // the metadata lines that follow belong to it, and appear only the first
    // time that commit is named.
    const head = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/.exec(raw);
    if (head) {
      const sha = head[1];
      let i = seen.get(sha);
      if (i === undefined) {
        i = commits.length;
        seen.set(sha, i);
        commits.push({
          sha,
          short: sha.slice(0, 8),
          // All-zero is git's marker for a line that exists only in the
          // working tree. It has no author or message of its own to report.
          uncommitted: /^0+$/.test(sha),
          author: '',
          authorTime: 0,
          summary: '',
        });
      }
      cur = commits[i];
      const final = Number(head[2]);
      const count = Number(head[3]);
      for (let k = 0; k < count; k++) lines[final - 1 + k] = i;
      continue;
    }
    if (!cur) continue;
    const sp = raw.indexOf(' ');
    const key = sp < 0 ? raw : raw.slice(0, sp);
    const val = sp < 0 ? '' : raw.slice(sp + 1);
    if (key === 'author' && !cur.author) cur.author = val;
    else if (key === 'author-time' && !cur.authorTime) cur.authorTime = Number(val) * 1000;
    else if (key === 'summary' && !cur.summary) cur.summary = val;
  }
  return { commits, lines };
}

async function apiGitBlame(res, params) {
  const abs = resolveSafe(params.get('path'));
  if (!abs) return sendJson(res, 400, { error: 'path escapes root' });
  const top = git(['rev-parse', '--show-toplevel'], path.dirname(abs));
  if (top.code !== 0) return sendJson(res, 200, { tracked: false, reason: 'not a git repository' });
  const repoAbs = top.out.trim();
  const rel = path.relative(repoAbs, abs);
  if (!rel || rel.startsWith('..')) return sendJson(res, 400, { error: 'path escapes repo' });

  // --root so the first commit is reported like any other rather than as a
  // boundary with its metadata suppressed.
  const r = await gitAsync(['blame', '--incremental', '--root', '--', rel], repoAbs);
  // A file git has never seen is the ordinary case here, not an error: the
  // gutter simply stays empty for it.
  if (r.code !== 0) return sendJson(res, 200, { tracked: false, reason: r.err || 'no blame for this path' });
  const { commits, lines } = parseBlameIncremental(r.out);
  return sendJson(res, 200, { tracked: true, path: rel, commits, lines });
}

async function apiGitRepos(res, params) {
  // `base` is the workspace the client has open (the same value the explorer
  // and quick-open are anchored to). Absent means the whole start directory.
  // Repo ids take whatever shape toClientPath gives them — relative to the
  // start directory inside it, absolute outside — and status, diff and action
  // all resolve them back through resolveSafe, which accepts both.
  const baseAbs = resolveSafe(params?.get('base') || '.');
  if (!baseAbs) return sendJson(res, 400, { error: 'base escapes root' });
  const repos = [];
  for (const rel of await findRepos(baseAbs)) {
    const abs = resolveSafe(rel) ?? ROOT;
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

// Git's unmerged index states as porcelain reports them, both letters read
// together: 'UU' is both sides editing, 'DD' both deleting, 'AU' ours adding
// while theirs never had the file. What they share is that the index holds
// more than one version, which is the only thing the caller needs to know.
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

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
  // A file mid-merge belongs to neither group. Its index entry is three
  // competing versions rather than one staged change, so the Stage and
  // Discard buttons the other two groups carry would offer the wrong verbs
  // for it — the only useful action is to resolve it.
  const conflicts = [];
  for (const f of s.files) {
    if (f.x === '?' ) {
      changes.push({ path: f.path, status: 'U', untracked: true });
      continue;
    }
    if (UNMERGED.has(`${f.x}${f.y}`)) {
      conflicts.push({ path: f.path, status: `${f.x}${f.y}` });
      continue;
    }
    if (f.x !== ' ' && f.x !== '?') staged.push({ path: f.path, status: f.x, orig: f.orig });
    if (f.y !== ' ') changes.push({ path: f.path, status: f.y, untracked: false });
  }
  // A merge in progress is invisible in porcelain output — it lives in the
  // control files git leaves in the git directory. --git-path is asked rather
  // than assuming .git/, so a worktree or a submodule answers correctly.
  const gitPath = (name) => {
    const r = git(['rev-parse', '--git-path', name], abs);
    const rel = r.code === 0 ? r.out.trim() : '';
    return rel ? path.resolve(abs, rel) : null;
  };
  const mergeHead = gitPath('MERGE_HEAD');
  const merging = mergeHead ? await fs.stat(mergeHead).then(() => true, () => false) : false;
  let mergeMessage = '';
  if (merging) {
    const msgPath = gitPath('MERGE_MSG');
    // The message git would have opened an editor with, which is exactly the
    // default the commit box should offer. Its trailing comment block is the
    // conflict advice, not part of the message.
    const raw = msgPath ? await fs.readFile(msgPath, 'utf8').catch(() => '') : '';
    mergeMessage = raw.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
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
    conflicts,
    merging,
    mergeMessage,
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
  let base;
  if (params.get('base')) {
    base = resolveRef(abs, params.get('base'));
    if (!base) return sendJson(res, 400, { error: 'unknown ref' });
  }
  // `to` pins the new side as well. Only meaningful alongside a base: on its
  // own it would mean "working tree vs a commit", which is `base` reversed.
  let to;
  if (params.get('to')) {
    if (!base) return sendJson(res, 400, { error: 'to requires base' });
    to = resolveRef(abs, params.get('to'));
    if (!to) return sendJson(res, 400, { error: 'unknown ref' });
  }

  const d = rawDiff(abs, rel, staged, untracked, base, to);
  if (d.code === -1) return sendJson(res, 500, { error: d.err });
  if (/^Binary files /m.test(d.out) || /^GIT binary patch/m.test(d.out)) {
    return sendJson(res, 200, { path: rel, staged, binary: true, hunks: [] });
  }
  if (d.out.length > 2 * 1024 * 1024) {
    return sendJson(res, 200, { path: rel, staged, tooBig: true, hunks: [] });
  }
  return sendJson(res, 200, { path: rel, staged, untracked, readOnly: !!to, hunks: parseDiff(d.out) });
}

// Compare two arbitrary inputs. There is no repo and no index here, so this
// leans on `git diff --no-index` — the exact call an untracked file already
// goes through, which means the output lands in parseDiff unchanged and the
// browser renders it with the component it already has. --no-index exits 1
// whenever the inputs differ, so the exit code is not an error signal.
// Resolve the two sides of a compare down to real files. A side that exists
// only in the browser — an unsaved buffer, pasted text — has nothing for git to
// read, so it is given a file for the length of the request. Both sides can be
// in memory at once (a scratch buffer against the clipboard), which is why the
// temporary names are prefixed rather than borrowed wholesale.
async function compareSides(body) {
  const leftMem = typeof body.leftText === 'string';
  const rightMem = typeof body.rightText === 'string';
  let leftAbs = null;
  let rightAbs = null;
  if (!leftMem) {
    leftAbs = resolveSafe(body.leftPath);
    if (!leftAbs) return { error: 'left path escapes root' };
  }
  if (!rightMem) {
    rightAbs = resolveSafe(body.rightPath);
    if (!rightAbs) return { error: 'right path escapes root' };
  }
  let dir = null;
  if (leftMem || rightMem) {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmd-cmp-'));
    // Both columns keep the basename of whichever side is a real file, so that
    // anything keying off the extension treats them as the same kind of
    // document. With neither side on disk there is nothing to borrow.
    const name = path.basename(leftAbs ?? rightAbs ?? 'compared.txt');
    if (leftMem) {
      leftAbs = path.join(dir, `a-${name}`);
      await fs.writeFile(leftAbs, body.leftText, 'utf8');
    }
    if (rightMem) {
      rightAbs = path.join(dir, `b-${name}`);
      await fs.writeFile(rightAbs, body.rightText, 'utf8');
    }
  }
  // git needs a working directory that exists; with the left side in memory,
  // the temporary one is the only directory guaranteed to.
  return { leftAbs, rightAbs, dir, cwd: leftMem ? dir : path.dirname(leftAbs) };
}

async function apiDiffCompare(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const s = await compareSides(body);
  if (s.error) return sendJson(res, 400, { error: s.error });
  const subject = body.leftPath ?? body.rightPath ?? '';

  try {
    const d = git(
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', s.leftAbs, s.rightAbs],
      s.cwd,
    );
    if (d.code === -1) return sendJson(res, 500, { error: d.err });
    if (/^Binary files /m.test(d.out) || /^GIT binary patch/m.test(d.out)) {
      return sendJson(res, 200, { path: subject, binary: true, hunks: [] });
    }
    if (d.out.length > 2 * 1024 * 1024) {
      return sendJson(res, 200, { path: subject, tooBig: true, hunks: [] });
    }
    return sendJson(res, 200, { path: subject, hunks: parseDiff(d.out) });
  } finally {
    if (s.dir) await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Apply one hunk (or the selected lines of it) of an arbitrary compare onto
// one of its own sides — VS Code's per-change arrows. The diff is recomputed
// here so the patch always matches the files as they are right now; a stale
// browser view surfaces as git rejecting the patch, never as silent
// corruption.
async function apiDiffApply(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const s = await compareSides(body);
  if (s.error) return sendJson(res, 400, { error: s.error });
  const target = body.target === 'right' ? 'right' : 'left';

  try {
    // A side held in the browser has no file behind it to rewrite. The editor
    // owns that text and applies the change to itself instead.
    if (typeof (target === 'right' ? body.rightText : body.leftText) === 'string') {
      return sendJson(res, 400, { error: 'that side is not a file on disk' });
    }
    const d = git(
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', s.leftAbs, s.rightAbs],
      s.cwd,
    );
    if (d.code === -1) return sendJson(res, 500, { error: d.err });
    const hunks = parseDiff(d.out);
    const hunk = hunks[body.hunk ?? -1];
    if (!hunk) return sendJson(res, 409, { error: 'hunk no longer exists — refresh' });
    const sel = new Set(
      Array.isArray(body.lines) && body.lines.length
        ? body.lines
        : hunk.lines.map((l, i) => (l.t === '+' || l.t === '-' ? i : -1)).filter((i) => i >= 0),
    );
    if (!hunk.lines.some((l, i) => (l.t === '+' || l.t === '-') && sel.has(i))) {
      return sendJson(res, 400, { error: 'selection contains no changed lines' });
    }
    // The diff reads left→right, so making the LEFT file match the right is a
    // forward apply and making the RIGHT file match the left is a reverse one.
    // buildPatch's demotion rules key off the same flag, so the patch is built
    // against whichever side it will be matched with.
    const targetAbs = target === 'right' ? s.rightAbs : s.leftAbs;
    const reverse = target === 'right';
    const patch = buildPatch(path.basename(targetAbs), hunk, sel, reverse);
    const args = ['apply', '--unidiff-zero', '--whitespace=nowarn'];
    if (reverse) args.push('--reverse');
    args.push('-');
    // cwd = the target's directory + headers naming its basename: git's
    // default -p1 strip lands on the right file with no repo involved.
    const r = git(args, path.dirname(targetAbs), patch);
    return r.code === 0
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 409, { error: r.err || 'patch does not apply — refresh' });
  } finally {
    if (s.dir) await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
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
    case 'checkout': {
      const ref = String(body.ref ?? '').trim();
      if (!ref) return sendJson(res, 400, { error: 'no ref' });
      // Checking out `origin/foo` verbatim detaches HEAD, which is almost never
      // what picking a remote branch is meant to do. Create the local tracking
      // branch instead — unless one already exists under that name.
      const m = /^([^/]+)\/(.+)$/.exec(ref);
      const isRemote = !!m && git(['rev-parse', '--verify', '-q', `refs/remotes/${ref}`], abs).code === 0;
      const localExists = !!m && git(['rev-parse', '--verify', '-q', `refs/heads/${m[2]}`], abs).code === 0;
      const r = git(isRemote && !localExists ? ['checkout', '-b', m[2], '--track', ref] : ['checkout', ref], abs);
      return r.code === 0 ? sendJson(res, 200, { ok: true }) : fail(r);
    }
    case 'branch': {
      const name = String(body.name ?? '').trim();
      if (!name) return sendJson(res, 400, { error: 'no branch name' });
      const from = String(body.from ?? '').trim();
      const r = git(from ? ['checkout', '-b', name, from] : ['checkout', '-b', name], abs);
      return r.code === 0 ? sendJson(res, 200, { ok: true }) : fail(r);
    }
    case 'detach': {
      const ref = String(body.ref ?? '').trim();
      if (!ref) return sendJson(res, 400, { error: 'no ref' });
      const r = git(['checkout', '--detach', ref], abs);
      return r.code === 0 ? sendJson(res, 200, { ok: true }) : fail(r);
    }
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
      // A two-ref diff describes neither the index nor the working tree, so
      // there is no coherent target to stage into or restore from.
      if (body.to) return sendJson(res, 400, { error: 'two-ref diffs are read-only' });
      const mode = body.mode ?? 'stage';
      let base;
      if (body.base) {
        // Stage/unstage are index-relative and meaningless against a pinned
        // tree; only restore-to-base (a reverse apply) is coherent here.
        if (mode !== 'revert') return sendJson(res, 400, { error: 'base diffs only support revert' });
        base = resolveRef(abs, body.base);
        if (!base) return sendJson(res, 400, { error: 'unknown ref' });
      }
      const fromIndex = mode === 'unstage';
      const d = rawDiff(abs, rel, fromIndex, !!body.untracked, base);
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
//   server → client: {t:'d', d:string} output, {t:'x', code, signal} shell exited,
//                    {t:'open', kind, path, reuse} — `code-gh` asking the tab
//                    that owns this shell to open something

// POST /api/open {path, reuse, term} — the endpoint `code-gh` posts to.
// Resolves the path inside the served root, decides file vs folder, then
// pushes the request down the sockets of the terminal that asked, so the open
// lands in the browser tab the command was actually typed in.
async function apiOpen(req, res) {
  let body;
  try {
    body = JSON.parse(String(await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const rel = typeof body.path === 'string' && body.path ? body.path : '.';
  const abs = resolveSafe(rel);
  if (!abs) return sendJson(res, 400, { error: `path is outside the served root: ${rel}` });
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    return sendJson(res, 404, { error: `no such file or directory: ${rel}` });
  }
  const s = sessions.get(String(body.term ?? ''));
  if (!s) return sendJson(res, 404, { error: 'unknown terminal session' });
  const kind = st.isDirectory() ? 'folder' : 'file';
  const clientPath = toClientPath(abs);
  const frame = JSON.stringify({ t: 'open', kind, path: clientPath, reuse: !!body.reuse });
  let delivered = 0;
  for (const ws of s.sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(frame);
      delivered += 1;
    }
  }
  if (!delivered) return sendJson(res, 409, { error: 'this terminal has no browser tab attached' });
  return sendJson(res, 200, { ok: true, kind, path: clientPath });
}

const wss = new WebSocketServer({ noServer: true });

// Per-session replay buffer. Enough to repaint a full screen plus history
// after a reattach, small enough that N idle sessions stay cheap.
const SCROLLBACK = 200_000;

const sessions = new Map();
let termSeq = 0;

function createSession(cwd) {
  if (!pty) throw new Error(`terminal unavailable — node-pty is not installed (${ptyError})`);
  const shell = process.env.SHELL || '/bin/bash';
  // Assigned before the spawn, not after, because the shell needs it in its
  // environment: `code-gh` posts the id back, and that is how the server knows
  // which browser tab asked for the open.
  const id = `t${++termSeq}`;
  // Login shell so the user's rc/profile chain loads — same feel as the
  // VS Code integrated terminal.
  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd ?? ROOT,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      // Prepended rather than appended so the shim wins, but a user who ships
      // their own `code-gh` earlier in PATH still gets theirs.
      PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      GMD_TERM_ID: id,
      GMD_PORT: String(port),
      // The shim curls the API back, so it needs a dialable address. A
      // wildcard bind is not one and collapses to loopback; any other bind
      // (a tailnet address, say) is exactly what has to be dialed, because
      // loopback may not be listening at all.
      GMD_HOST: host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host,
      // A login shell inherits the parent's locale, and a daemon started
      // outside any session often has none — which is what makes vim draw
      // its box drawing as `~` and mangle multibyte input.
      LANG: process.env.LANG || process.env.LC_ALL || 'en_US.UTF-8',
      COLORTERM: process.env.COLORTERM || 'truecolor',
      ...(auth ? { GMD_TOKEN: auth } : {}),
    },
  });
  const s = {
    id,
    // "Open new terminal here" labels the tab with the folder it starts in.
    title: cwd && cwd !== ROOT ? `${path.basename(shell)} — ${path.basename(cwd)}` : path.basename(shell),
    cwd: cwd ?? ROOT,
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
  p.onExit(({ exitCode, signal }) => {
    // Shell exited (or was killed) → the session is gone, exactly like a VS
    // Code terminal tab closing itself. Attached clients drop the tab.
    sessions.delete(s.id);
    // The signal rides along because without it a killed shell is
    // indistinguishable from `exit 0` on the wire: node-pty reports exitCode 0
    // for a SIGKILL, and the client decides whether to close the tab or keep
    // it around with the reason on screen.
    const frame = JSON.stringify({ t: 'x', code: exitCode ?? 0, signal: signal ?? 0 });
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
  // The working directory is what lets a client group sessions by workspace.
  // Reported the same way the `folder` query parameter is written — relative
  // to the served root, or absolute when the shell sits outside it.
  const abs = s.cwd ?? ROOT;
  const rel = abs === ROOT ? '' : path.relative(ROOT, abs);
  return { id: s.id, title: s.title, pid: s.pid, cwd: rel.startsWith('..') ? abs : rel };
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
// Keep `list-servers` honest on a clean exit. A hard kill skips this and
// leaves the file behind; the pid liveness check reaps it on the next read.
process.on('exit', () => unregisterServer(port));
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
// Set while a tunnel is being deliberately torn down and replaced, so the
// child's exit handler does not report a planned reroll as a failure.
let tunnelReplacing = false;
// The URL currently believed to work — what the heartbeat re-checks.
let liveTunnelUrl = null;
process.on('exit', () => { try { tunnelChild?.kill('SIGTERM'); } catch {} });

// Is a binary usable? spawnSync is the portable probe — `which` and `where`
// differ per platform and neither exists in a bare container.
function onPath(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return !r.error;
}

// cloudflared is a ~35MB per-platform Go binary, so it cannot be an npm
// dependency without taxing every install for the few who tunnel. Fetch it
// once into a user cache dir instead — that keeps `--tunnel` a genuinely
// zero-setup flag, which is its entire reason to exist. No apt, no brew, no
// manual download, and every later run reuses the cached copy.
const TUNNEL_CACHE = path.join(os.homedir(), '.cache', 'gh-md-editor');

function cloudflaredAsset() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch];
  if (!arch) return null;
  if (process.platform === 'linux') return { asset: `cloudflared-linux-${arch}`, bin: 'cloudflared', tgz: false };
  // The macOS build is published only as a tarball, and only for amd64/arm64.
  if (process.platform === 'darwin' && (arch === 'amd64' || arch === 'arm64')) return { asset: `cloudflared-darwin-${arch}.tgz`, bin: 'cloudflared', tgz: true };
  if (process.platform === 'win32' && (arch === 'amd64' || arch === '386')) return { asset: `cloudflared-windows-${arch}.exe`, bin: 'cloudflared.exe', tgz: false };
  return null;
}

async function fetchCloudflared() {
  const a = cloudflaredAsset();
  if (!a) return { error: `no cloudflared build for ${process.platform}/${process.arch} — install it yourself and pass --tunnel-bin <path>` };
  const dest = path.join(TUNNEL_CACHE, a.bin);
  try { await fs.access(dest); return { bin: dest }; } catch { /* not cached yet */ }
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${a.asset}`;
  console.log(`  tunnel: cloudflared is not installed — downloading it once to ${dest}`);
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await fs.mkdir(TUNNEL_CACHE, { recursive: true });
    if (a.tgz) {
      const tar = path.join(TUNNEL_CACHE, a.asset);
      await fs.writeFile(tar, buf);
      const x = spawnSync('tar', ['-xzf', tar, '-C', TUNNEL_CACHE], { stdio: 'ignore' });
      await fs.rm(tar, { force: true });
      if (x.error || x.status !== 0) throw new Error('tar could not unpack the download');
    } else {
      // Write beside the target then rename: a killed download must never
      // leave a truncated binary that exists and fails forever after.
      await fs.writeFile(`${dest}.part`, buf);
      await fs.rename(`${dest}.part`, dest);
    }
    await fs.chmod(dest, 0o755).catch(() => {});
    console.log('  tunnel: cloudflared ready.');
    return { bin: dest };
  } catch (e) {
    return { error: `could not download cloudflared: ${String(e?.message ?? e)}` };
  }
}

async function resolveTunnelBin(provider) {
  if (tunnelBin) return { bin: tunnelBin };
  if (provider === 'funnel') {
    // Funnel cannot be auto-installed: it needs a root daemon and an
    // authenticated tailnet, neither of which this process can arrange.
    if (onPath('tailscale')) return { bin: 'tailscale' };
    return { error: 'tailscale is not installed. Funnel needs the daemon running and logged in (https://tailscale.com/download) — plain `--tunnel` needs nothing at all.' };
  }
  if (onPath('cloudflared')) return { bin: 'cloudflared' };
  return await fetchCloudflared();
}

async function startTunnel(provider) {
  const resolved = await resolveTunnelBin(provider);
  if (resolved.error) return { error: resolved.error };
  const bin = resolved.bin;
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
      // A planned reroll kills this child on purpose; the flag is consumed
      // here rather than cleared at kill time because `exit` lands a tick or
      // more later, long after any synchronous reset would have run.
      else if (tunnelReplacing) tunnelReplacing = false;
      else console.error(`  !! tunnel process exited (${code}) — the public URL is dead; local server still up.`);
      if (tunnelChild === child) tunnelChild = null;
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

// --- tunnel readiness -------------------------------------------------------
// cloudflared prints its URL the moment the edge accepts the connection, but
// the hostname's DNS record is created asynchronously and the wait is a
// lottery: measured 15s on one run and still NXDOMAIN at 133s on the very next
// run, same machine, same command. Printing that URL straight away is worse
// than merely premature — clicking a name that does not exist yet makes the
// resolver cache the negative answer, so the link keeps failing for minutes
// AFTER it goes live, and the only "fix" a user finds is to wait and rerun.
// Verify first, print second.
const TUNNEL_VERIFY_MS = 75_000;
const TUNNEL_ATTEMPTS = 3;
const TUNNEL_HEARTBEAT_MS = 60_000;

// Never ask the system resolver whether the hostname exists yet: on the
// machine this was debugged, that resolver was the one holding the poisoned
// negative entry. Public resolvers give an uncached second opinion.
const publicDns = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
publicDns.setServers(['1.1.1.1', '8.8.8.8']);

async function resolvePublic(hostname) {
  try {
    const [ip] = await publicDns.resolve4(hostname);
    return ip ?? null;
  } catch {
    return null;
  }
}

// Any HTTP status proves the entire path works: DNS → edge → this process. A
// 401 from our own auth gate is a perfectly good yes.
function probeVia(url, ip, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = https.request(url, {
        method: 'GET',
        timeout: timeoutMs,
        // Dial the IP the public resolver just handed back. SNI and Host still
        // carry the real hostname, so this is the same request a browser
        // makes — minus any chance of a stale local DNS answer.
        // Two callback shapes, not one: Node 20 turned on autoSelectFamily,
        // which calls lookup with all:true and rejects a bare address string
        // as an invalid IP. Getting this wrong fails every probe silently.
        lookup: (_hostname, opts, cb) => (opts?.all
          ? cb(null, [{ address: ip, family: 4 }])
          : cb(null, ip, 4)),
      }, (res) => { res.resume(); done(res.statusCode ?? 0); });
      req.on('timeout', () => { req.destroy(); done(0); });
      req.on('error', () => done(0));
      req.end();
    } catch {
      done(0);
    }
  });
}

async function waitReachable(url, budgetMs) {
  const hostname = new URL(url).hostname;
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const ip = await resolvePublic(hostname);
    if (ip && (await probeVia(url, ip, 5000)) > 0) return { ok: true, ms: Date.now() - started };
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, ms: Date.now() - started };
}

function killTunnel() {
  const child = tunnelChild;
  tunnelChild = null;
  if (!child) return;
  tunnelReplacing = true;
  try { child.kill('SIGTERM'); } catch {}
  // If that child somehow never reports its exit, the flag must not stay
  // raised and swallow the next genuine tunnel death.
  setTimeout(() => { tunnelReplacing = false; }, 5000).unref();
}

// Every cloudflared attempt draws a NEW random hostname, so a slow draw is
// worth abandoning rather than waiting out — a reroll has beaten the wait in
// every measurement. Funnel gets a single attempt: its hostname is fixed, so
// retrying would only ask for the same name again.
async function bringTunnelUp(provider) {
  const attempts = provider === 'funnel' ? 1 : TUNNEL_ATTEMPTS;
  for (let i = 1; i <= attempts; i++) {
    const started = await startTunnel(provider);
    // An error here is about the BINARY — missing, exited, never printed a
    // URL. No number of retries fixes that, so surface it now.
    if (started.error) return { error: started.error };
    console.log(`  tunnel: got ${started.url} — checking it actually answers before handing it to you…`);
    const seen = await waitReachable(started.url, TUNNEL_VERIFY_MS);
    if (seen.ok) return { url: started.url, ms: seen.ms };
    killTunnel();
    if (i < attempts) {
      console.warn(`  !! tunnel: that hostname never resolved after ${Math.round(seen.ms / 1000)}s — asking for a different one (${i + 1}/${attempts}).`);
    }
  }
  return { error: `${attempts > 1 ? `${attempts} tunnels came` : 'the tunnel came'} up but never became reachable from the public internet` };
}

function announceTunnel(r) {
  liveTunnelUrl = r.url;
  // Land the public URL in the registry too — a detached server's stdout goes
  // to a log file, so this is the only way `list-servers` can hand back a
  // working link.
  patchServer(port, { tunnelUrl: r.url });
  console.log('');
  console.log(`  PUBLIC: ${r.url}/?token=${auth}`);
  console.log(`  verified reachable${r.ms == null ? '' : ` in ${Math.round(r.ms / 1000)}s`} — it works right now, no waiting.`);
  console.log('  !! anyone with this full URL gets a shell as your user — share with care.');
  console.log('  !! the tunnel dies when this process exits; the URL is not reusable.');
}

// A quick tunnel can die quietly hours later — process killed, edge drops the
// connection, laptop slept. Re-roll and announce the replacement instead of
// leaving a dead link sitting in the scrollback as the only thing the user has.
function watchTunnel(provider) {
  let strikes = 0;
  const timer = setInterval(async () => {
    if (!liveTunnelUrl) return;
    const ip = await resolvePublic(new URL(liveTunnelUrl).hostname);
    const code = ip && tunnelChild ? await probeVia(liveTunnelUrl, ip, 5000) : 0;
    // Two misses before acting: one failed probe is usually this machine's
    // network blinking, not the tunnel dying.
    if (code > 0) { strikes = 0; return; }
    if (++strikes < 2) return;
    strikes = 0;
    console.warn('  !! tunnel: the public URL stopped answering — bringing up a replacement…');
    killTunnel();
    liveTunnelUrl = null;
    patchServer(port, { tunnelUrl: null });
    const next = await bringTunnelUp(provider);
    if (next.error) {
      console.warn(`  !! tunnel: could not replace it (${next.error}). Local server still up; will keep trying.`);
      return;
    }
    announceTunnel(next);
  }, TUNNEL_HEARTBEAT_MS);
  // Never hold the process open just to run a health check.
  timer.unref();
}

server.listen(port, host, () => {
  console.log(`gh-md-editor server mode`);
  console.log(`  root: ${ROOT}`);
  console.log(`  url:  http://${host}:${port}/${auth ? `?token=${auth}` : ''}`);
  // Register here and nowhere else: listen() succeeding is the first moment
  // the port is confirmed bound AND the token is final (a bare --tunnel mints
  // one above). This file is what `list-servers` reads and `down` signals.
  registerServer({
    pid: process.pid,
    host,
    port,
    root: ROOT,
    auth: auth ?? null,
    tunnel: tunnel ?? null,
    // Recorded so a restart can replay the exact invocation: `upgrade` rebuilds
    // the argv from this entry and nothing else.
    tunnelBin: tunnelBin ?? null,
    tunnelUrl: null,
    version: VERSION,
    daemon: process.env.GH_MD_EDITOR_DAEMON === '1',
    log: process.env.GH_MD_EDITOR_LOG ?? null,
    startedAt: Date.now(),
  });
  if (!pty) {
    console.warn('');
    console.warn('  !! terminal disabled — the prebuilt pty binary would not load:');
    console.warn(`  !!   ${ptyError}`);
    console.warn('  !! Editor, git, search and port forwarding all work regardless.');
    console.warn(`  !! No build tools are needed or wanted here: this is either a platform`);
    console.warn(`  !! with no prebuilt (${process.platform}-${process.arch}) or an install run with --omit=optional.`);
    console.warn('');
  }
  // git stays a host binary by design — anyone opening a source-control panel
  // has git. ripgrep no longer is: it ships with this package, so a warning
  // here means no prebuilt for this platform AND no host copy either.
  const missing = [];
  if (!rgBin) missing.push('rg');
  if (!onPath('git')) missing.push('git');
  if (missing.length) {
    console.warn('');
    if (missing.includes('rg')) console.warn('  !! ripgrep is unavailable — workspace search and quick open find nothing.');
    if (missing.includes('git')) console.warn('  !! git is not on PATH — the source-control panel stays empty.');
    console.warn(`  !!   Debian/Ubuntu: apt-get install -y ${missing.map((m) => (m === 'rg' ? 'ripgrep' : m)).join(' ')}`);
    console.warn(`  !!   macOS:         brew install ${missing.map((m) => (m === 'rg' ? 'ripgrep' : m)).join(' ')}`);
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
    bringTunnelUp(tunnel).then((r) => {
      if (r.error) {
        console.warn(`  !! tunnel failed: ${r.error}`);
        console.warn('  !! local server unaffected — the url above still works on this machine.');
        return;
      }
      announceTunnel(r);
      watchTunnel(tunnel);
    });
  }
});
