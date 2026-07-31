// gh-md-editor daemon mode — `up`, `list-servers`, `down`.
//
// One detached server per workspace, outliving the ssh session that started
// it. State lives in ~/.cache/gh-md-editor/servers/<port>.json — the same dir
// `--tunnel` already downloads cloudflared into, so there is one place to
// inspect and one place to clear.
//
// Three decisions worth keeping:
//
// 1. The SERVER writes its own registry entry, not `up`. listen() succeeding
//    is the only moment the port is confirmed bound AND the auth token is
//    final — a bare `--tunnel` mints the token server-side, so no caller can
//    know it in advance. `up` polls for that entry instead of sleeping.
// 2. One file per port, never a shared servers.json. Two `up` calls racing on
//    a single file clobber each other; per-port files make the unit of write,
//    read and delete the same thing.
// 3. The file is never trusted for liveness — `kill(pid, 0)` is the source of
//    truth and stale entries are reaped on every read. A hard-killed server
//    leaves a file behind; that is expected and self-healing.
//
// The entry holds the auth token, because `list-servers` printing a URL you
// cannot open is useless and daemonised stdout goes to a log nobody reads.
// Dirs are 0700, files 0600.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_ENTRY = fileURLToPath(new URL('./index.mjs', import.meta.url));
const CACHE = process.env.GH_MD_EDITOR_HOME || path.join(os.homedir(), '.cache', 'gh-md-editor');
const SERVERS = path.join(CACHE, 'servers');
const LOGS = path.join(CACHE, 'logs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- registry --------------------------------------------------------------

function ensureDirs() {
  fs.mkdirSync(SERVERS, { recursive: true, mode: 0o700 });
  fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
}

function entryPath(port) {
  return path.join(SERVERS, `${port}.json`);
}

export function logPathFor(port) {
  return path.join(LOGS, `${port}.log`);
}

// EPERM means the pid exists but belongs to someone else — still alive.
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readEntry(port) {
  try { return JSON.parse(fs.readFileSync(entryPath(port), 'utf8')); } catch { return null; }
}

// tmp + rename: `up` polls this file in a loop and must never read a half
// written one.
function writeEntry(e) {
  ensureDirs();
  const p = entryPath(e.port);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(e, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function registerServer(info) {
  try { writeEntry(info); } catch { /* the server still works without a registry */ }
}

export function patchServer(port, patch) {
  try {
    const cur = readEntry(port);
    if (cur) writeEntry({ ...cur, ...patch });
  } catch { /* non-fatal */ }
}

export function unregisterServer(port) {
  try { fs.unlinkSync(entryPath(port)); } catch { /* already gone */ }
}

// Every live server, dead entries reaped as a side effect.
export function listServers() {
  let names;
  try { names = fs.readdirSync(SERVERS).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const p = path.join(SERVERS, n);
    let e = null;
    try { e = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* corrupt */ }
    if (!e || !e.pid || !alive(e.pid)) { try { fs.unlinkSync(p); } catch {} continue; }
    out.push(e);
  }
  return out.sort((a, b) => a.port - b.port);
}

// --- presentation ----------------------------------------------------------

// 0.0.0.0 is a bind address, not something you can paste into a phone.
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
}

function displayHost(h) {
  if (h === '0.0.0.0' || h === '::' || h === '') return lanAddress() || '127.0.0.1';
  return h;
}

function urlOf(e) {
  const q = e.auth ? `?token=${e.auth}` : '';
  return e.tunnelUrl ? `${e.tunnelUrl}/${q}` : `http://${displayHost(e.host)}:${e.port}/${q}`;
}

function tildify(p) {
  if (!p) return '-';
  const h = os.homedir();
  if (p === h) return '~';
  return p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

function since(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  console.log(line(headers));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

// Last N lines without slurping a log that has been appended to for weeks.
function tail(p, n) {
  try {
    const st = fs.statSync(p);
    const len = Math.min(st.size, 65536);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(-n).join('\n').trim();
  } catch { return '(no log output)'; }
}

// --- probes ----------------------------------------------------------------

// How many shells would `down` take with it. Best effort: a server that is
// wedged or bound to an interface we cannot reach reports `?` rather than
// blocking the command.
function probeTerminals(e) {
  return new Promise((resolve) => {
    const req = http.request({
      host: displayHost(e.host) === '' ? '127.0.0.1' : (e.host === '0.0.0.0' || e.host === '::' ? '127.0.0.1' : e.host),
      port: e.port,
      path: '/api/terminals',
      method: 'GET',
      headers: e.auth ? { 'x-auth-token': e.auth } : {},
      timeout: 1500,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).terminals?.length ?? null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function waitFor(fn, timeoutMs, stillAlive) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (stillAlive && !stillAlive()) return null;
    if (Date.now() > deadline) return null;
    await sleep(120);
  }
}

// --- keyboard picker -------------------------------------------------------

// Hand-rolled on node:readline. The package ships two dependencies (ws, and
// node-pty as an optional) and a prompt library is not worth becoming the
// third — this is sixty lines and no install-time surface.
function pick(labels, title) {
  return new Promise((resolve) => {
    const out = process.stdout;
    let cur = 0;
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    out.write('\x1b[?25l');
    out.write(`${title}\n`);

    const draw = (first) => {
      if (!first) out.write(`\x1b[${labels.length}A`);
      for (let i = 0; i < labels.length; i++) {
        out.write('\x1b[2K');
        out.write(i === cur ? `\x1b[7m> ${labels[i]}\x1b[0m\n` : `  ${labels[i]}\n`);
      }
    };

    const done = (v) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(!!wasRaw);
      process.stdin.pause();
      out.write('\x1b[?25h');
      resolve(v);
    };

    const onKey = (_str, k) => {
      if (!k) return;
      if (k.name === 'up' || k.name === 'k') { cur = (cur - 1 + labels.length) % labels.length; draw(false); }
      else if (k.name === 'down' || k.name === 'j') { cur = (cur + 1) % labels.length; draw(false); }
      else if (k.name === 'return' || k.name === 'enter') done(cur);
      else if (k.name === 'escape' || k.name === 'q' || (k.ctrl && k.name === 'c')) done(null);
    };

    draw(true);
    process.stdin.on('keypress', onKey);
  });
}

function confirm(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

// --- cli -------------------------------------------------------------------

function parse(args) {
  const o = { _: [], host: null, port: null, auth: null, tunnel: null, tunnelBin: null, all: false, yes: false, force: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--host') o.host = args[++i];
    else if (a === '--port' || a === '-p') o.port = Number(args[++i]);
    else if (a === '--auth') o.auth = args[++i];
    else if (a === '--tunnel') {
      o.tunnel = args[i + 1] && ['cloudflared', 'funnel'].includes(args[i + 1]) ? args[++i] : 'cloudflared';
    } else if (a === '--tunnel-bin') o.tunnelBin = args[++i];
    else if (a === '--all' || a === '-a') o.all = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--force' || a === '-f') o.force = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('-')) o._.push(a);
    else throw new Error(`unknown flag: ${a}`);
  }
  if (o.port != null && !Number.isInteger(o.port)) throw new Error('--port takes a number');
  return o;
}

async function up(o) {
  const root = path.resolve(process.cwd(), o._[0] ?? '.');
  try {
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`cannot serve ${root}: not a directory`);
    return 1;
  }
  const host = o.host ?? '127.0.0.1';
  const port = o.port ?? 8790;
  const running = listServers();

  // Same workspace twice is almost always a forgotten server, not intent.
  const sameRoot = running.find((e) => e.root === root);
  if (sameRoot && !o.force) {
    console.log(`already up for this workspace (pid ${sameRoot.pid}, port ${sameRoot.port})`);
    console.log(`  url:  ${urlOf(sameRoot)}`);
    console.log('');
    console.log('  --force starts a second server for the same workspace anyway');
    return 0;
  }
  const samePort = running.find((e) => e.port === port);
  if (samePort) {
    console.error(`port ${port} is already served by pid ${samePort.pid} (${tildify(samePort.root)})`);
    console.error(`  stop it:  gh-md-editor down --port ${port}`);
    return 1;
  }

  ensureDirs();
  const logPath = logPathFor(port);
  const fd = fs.openSync(logPath, 'a', 0o600);

  const argv = [SERVER_ENTRY, root, '--host', host, '--port', String(port)];
  if (o.auth) argv.push('--auth', o.auth);
  if (o.tunnel) argv.push('--tunnel', o.tunnel);
  if (o.tunnelBin) argv.push('--tunnel-bin', o.tunnelBin);

  // detached:true makes the child a session leader, so the SIGHUP that fires
  // when the ssh session ends is delivered to the old foreground group and
  // never reaches it. stdio goes to the log rather than /dev/null — the
  // startup warnings about a missing pty, missing rg and missing git are the
  // whole diagnostic story when something looks broken later.
  const child = spawn(process.execPath, argv, {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, GH_MD_EDITOR_DAEMON: '1', GH_MD_EDITOR_LOG: logPath },
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.unref();
  fs.closeSync(fd);

  // Wait for the child's own registry write instead of guessing a sleep. If
  // it dies first the reason is in the log — EADDRINUSE and an unreadable
  // workspace both land here.
  const entry = await waitFor(() => {
    const e = readEntry(port);
    return e && e.pid === child.pid ? e : null;
  }, 20_000, () => !exited);

  if (!entry) {
    console.error(`server did not come up on :${port} — last lines of ${tildify(logPath)}:`);
    console.error('');
    console.error(tail(logPath, 20).replace(/^/gm, '  '));
    return 1;
  }

  if (o.tunnel) {
    process.stdout.write(`  tunnel: waiting for the ${o.tunnel} url…`);
    const withUrl = await waitFor(() => {
      const e = readEntry(port);
      return e?.tunnelUrl ? e : null;
    }, 40_000, () => !exited);
    console.log('');
    if (withUrl) Object.assign(entry, withUrl);
    else console.warn(`  !! no public url yet — see ${tildify(logPath)}. the local server is up regardless.`);
  }

  console.log('gh-md-editor is up');
  console.log(`  root: ${tildify(entry.root)}`);
  console.log(`  url:  ${urlOf(entry)}`);
  console.log(`  pid:  ${entry.pid}`);
  console.log(`  log:  ${tildify(entry.log ?? logPath)}`);

  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !entry.auth) {
    console.warn('');
    console.warn('  !! listening on a non-loopback interface with NO auth.');
    console.warn('  !! anyone who can reach this port gets a shell as your user.');
    console.warn('  !! opt in to auth: --auth <token>');
  }

  console.log('');
  console.log(`  the ssh session can close now — stop it later with:  gh-md-editor down --port ${entry.port}`);
  return 0;
}

async function ls() {
  const rows = listServers();
  if (!rows.length) {
    console.log('no gh-md-editor servers running');
    return 0;
  }
  const terms = await Promise.all(rows.map(probeTerminals));
  table(
    ['PID', 'PORT', 'MODE', 'UP', 'TERMS', 'WORKSPACE', 'URL'],
    rows.map((e, i) => [e.pid, e.port, e.daemon ? 'bg' : 'fg', since(e.startedAt), terms[i] ?? '?', tildify(e.root), urlOf(e)]),
  );
  return 0;
}

// SIGTERM, never SIGKILL first. The server's own handler is what sweeps the
// pty children (process group kill, then a session sweep for anything job
// control detached). SIGKILL skips that and leaks every shell the terminal
// panel ever opened.
async function stop(e) {
  try {
    process.kill(e.pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') { unregisterServer(e.port); return true; }
    throw err;
  }
  const gone = await waitFor(() => (alive(e.pid) ? null : true), 8000, null);
  if (!gone) {
    try { process.kill(e.pid, 'SIGKILL'); } catch {}
    await sleep(400);
  }
  unregisterServer(e.port);
  return !alive(e.pid);
}

async function down(o) {
  const rows = listServers();
  if (!rows.length) {
    console.log('no gh-md-editor servers running');
    return 0;
  }

  let targets;
  if (o.all) {
    targets = rows;
  } else if (o.port != null) {
    targets = rows.filter((e) => e.port === o.port);
    if (!targets.length) { console.error(`no server on port ${o.port}`); return 1; }
  } else if (o._.length) {
    const want = Number(o._[0]);
    targets = rows.filter((e) => e.port === want);
    if (!targets.length) { console.error(`no server on port ${o._[0]}`); return 1; }
  } else if (rows.length === 1) {
    targets = rows;
  } else if (process.stdin.isTTY) {
    const terms = await Promise.all(rows.map(probeTerminals));
    const labels = rows.map((e, i) =>
      `:${String(e.port).padEnd(5)} ${String(terms[i] ?? '?').padStart(2)} term  ${since(e.startedAt).padStart(5)}  ${tildify(e.root)}`);
    const picked = await pick(labels, 'stop which server?   ↑↓ move · enter stop · esc cancel');
    if (picked == null) { console.log('cancelled'); return 130; }
    targets = [rows[picked]];
  } else {
    console.error(`${rows.length} servers running and no tty to pick from — pass --port <n> or --all`);
    return 1;
  }

  // Live shells are the only thing here that cannot be recreated by starting
  // the server again, so they are the only thing worth a prompt.
  const counts = await Promise.all(targets.map(probeTerminals));
  const live = counts.reduce((a, c) => a + (c ?? 0), 0);
  if (live > 0 && !o.yes) {
    if (!process.stdin.isTTY) {
      console.error(`${live} live terminal session(s) would be killed and there is no tty to confirm on — re-run with --yes`);
      return 1;
    }
    const ok = await confirm(`${live} live terminal session(s) will be killed. continue? [y/N] `);
    if (!ok) { console.log('cancelled'); return 130; }
  }

  let rc = 0;
  for (const e of targets) {
    let ok = false;
    try { ok = await stop(e); } catch (err) { console.error(`  ${String(err?.message ?? err)}`); }
    console.log(ok ? `stopped :${e.port}  (pid ${e.pid}, ${tildify(e.root)})` : `could not stop :${e.port} (pid ${e.pid})`);
    if (!ok) rc = 1;
  }
  return rc;
}

function help() {
  console.log(`gh-md-editor — background servers

  gh-md-editor up [dir] [--host H] [-p PORT] [--auth TOKEN] [--tunnel [cloudflared|funnel]]
      start a detached server for [dir] (default .) and return straight away.
      it outlives the ssh session that started it. a workspace that already
      has a server prints that one instead; --force starts a second.

  gh-md-editor list-servers                                        (alias: ls)
      every running server: pid, port, uptime, live terminals, workspace, url.
      entries whose process is gone are reaped on read.

  gh-md-editor down [PORT] [-p PORT] [--all] [--yes]
      stop servers. exactly one running stops it outright; several give a
      keyboard picker (up/down + enter). --all stops every one. --yes skips
      the confirmation shown when terminal sessions are still live.

  state: ${tildify(CACHE)}
      servers/<port>.json holds the auth token so list-servers can print a url
      you can actually open — dirs 0700, files 0600. logs/<port>.log is the
      detached server's stdout.

  with no subcommand gh-md-editor runs a server in the foreground, as before.`);
}

export async function run(sub, args) {
  let o;
  try { o = parse(args); } catch (e) { console.error(String(e?.message ?? e)); return 1; }
  if (o.help) { help(); return 0; }
  if (sub === 'up') return up(o);
  if (sub === 'ls' || sub === 'list-servers') return ls(o);
  if (sub === 'down') return down(o);
  help();
  return 1;
}
