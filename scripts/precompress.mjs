// Ship .gz/.br sidecars next to the built client so the server answers a
// compressed request with a file read instead of compressing the same bundle
// again for every visitor. Brotli at max quality costs seconds once, here, and
// nothing at request time — the trade that on-the-fly compression cannot make.
//
// Run from `npm run build:server`, after vite has emitted dist/web.
import { readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'dist', 'web');
// Anything else in a client bundle is already compressed (woff2, png, webp) and
// re-compressing it spends CPU to add bytes.
const EXTS = new Set(['.js', '.css', '.html', '.svg', '.json', '.map', '.txt', '.ico']);
// Below roughly one packet there is nothing to win, and the sidecar can end up
// larger than the file it shadows.
const MIN_BYTES = 1024;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else yield abs;
  }
}

try {
  await stat(DIST);
} catch {
  console.error(`precompress: ${DIST} not found — run the client build first`);
  process.exit(0);
}

// A previous build's sidecars are stale the moment their source changes, and a
// stale sidecar would be served in preference to the fresh original.
for await (const abs of walk(DIST)) {
  if (abs.endsWith('.gz') || abs.endsWith('.br')) await rm(abs, { force: true });
}

let files = 0;
let raw = 0;
let br = 0;
let gz = 0;

for await (const abs of walk(DIST)) {
  if (!EXTS.has(path.extname(abs))) continue;
  const buf = await readFile(abs);
  if (buf.length < MIN_BYTES) continue;
  // Source maps are the bulk of the bytes here and are fetched only when a
  // developer opens devtools — paying max-quality brotli on them would triple
  // the build's compression time to speed up a request almost nobody makes.
  const quality = path.extname(abs) === '.map' ? 5 : zlib.constants.BROTLI_MAX_QUALITY;
  const [b, g] = await Promise.all([
    brotli(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }),
    gzip(buf, { level: zlib.constants.Z_BEST_COMPRESSION }),
  ]);
  // A sidecar bigger than the original would be served and waste bandwidth.
  if (b.length < buf.length) await writeFile(`${abs}.br`, b);
  if (g.length < buf.length) await writeFile(`${abs}.gz`, g);
  files += 1;
  raw += buf.length;
  br += Math.min(b.length, buf.length);
  gz += Math.min(g.length, buf.length);
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`precompress: ${files} files, ${kb(raw)} raw → ${kb(br)} br / ${kb(gz)} gzip`);
