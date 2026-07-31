#!/usr/bin/env node
// Vendors the vscode-icons (vscode-icons-team.vscode-icons) icon set into
// src/lib/vscode-icons/.  Run once per upstream bump; the output is committed.
//
//   node scripts/vendor-vscode-icons.mjs
//
// Source of truth is the *published VSIX*, not the GitHub repo: the repo only
// holds TypeScript sources (supportedExtensions.ts / supportedFolders.ts) that
// have to be run through the extension's own IoC build to produce a manifest.
// The VSIX already ships the built manifests.
//
// We read `vsicons-icon-theme-zed.json` rather than `vsicons-icon-theme.json`.
// The VS Code manifest routes most common extensions (ts, js, py, md, yml, rs)
// through `languageIds`, keyed by VS Code *language id* -- there is no
// extension->languageId table outside VS Code itself, so `fileExtensions.ts`
// is simply undefined there.  The Zed manifest is generated for a host with no
// language-id concept, so every language is already flattened onto its known
// file suffixes.  That is the map a browser needs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VSIX_URL =
  'https://vscode-icons-team.gallery.vsassets.io/_apis/public/gallery/publisher/vscode-icons-team/extension/vscode-icons/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage';
const THEME_NAME = 'VSCode Icons for Zed (Dark)';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'src', 'lib', 'vscode-icons');
const outIcons = path.join(outDir, 'icons');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'vsi-'));

console.log('· downloading VSIX ...');
const vsix = path.join(tmp, 'vsi.vsix');
execFileSync('curl', ['-sSL', '-o', vsix, VSIX_URL]);
execFileSync('unzip', ['-q', '-o', vsix, '-d', path.join(tmp, 'x')]);

const ext = path.join(tmp, 'x', 'extension');
const version = JSON.parse(
  fs.readFileSync(path.join(ext, 'package.json'), 'utf8'),
).version;
console.log(`· vscode-icons v${version}`);

const zed = JSON.parse(
  fs.readFileSync(path.join(ext, 'dist', 'src', 'vsicons-icon-theme-zed.json'), 'utf8'),
);
const theme = zed.themes.find((t) => t.name === THEME_NAME);
if (!theme) throw new Error(`theme not found: ${THEME_NAME}`);

// ---------------------------------------------------------------- flattening
const needed = new Set();
const base = (p) => p.replace(/^\.\/icons\//, '');

/** id -> "file_type_x.svg", dropping ids with no icon entry (upstream bug). */
function resolveFile(id) {
  const e = theme.file_icons[id];
  if (!e || !e.path) return null;
  const f = base(e.path);
  needed.add(f);
  return f;
}

/**
 * Zed keys are case-sensitive, so upstream emits both `LICENSE` and `license`,
 * and mixed-case-only keys such as `Cargo.toml` / `Rakefile`.  The browser side
 * matches on a lowercased name, so fold here.
 *
 * Two keys can fold onto the same lowercase name with *different* icons -- as
 * of v12.19.0 that is `Pipfile`->python vs `pipfile`->pip (and the .lock pair).
 * The cased key is the casing the file actually has on disk, so it wins.
 */
function fold(src, resolve) {
  const out = {};
  const cased = new Set();
  const collisions = [];
  for (const [k, v] of Object.entries(src)) {
    const icon = resolve(v);
    if (!icon) continue;
    const lk = k.toLowerCase();
    const isCased = k !== lk;
    if (out[lk] === undefined) {
      out[lk] = icon;
      if (isCased) cased.add(lk);
    } else if (out[lk] !== icon) {
      if (isCased && !cased.has(lk)) {
        collisions.push([lk, icon, out[lk]]);
        out[lk] = icon;
        cased.add(lk);
      } else {
        collisions.push([lk, out[lk], icon]);
      }
    }
  }
  return { out, collisions };
}

// Upstream flattens each language's `knownExtensions` onto the suffix map, and
// when two languages claim the same extension the later one wins. 21 such
// clashes exist in v12.19.0; all resolve sensibly except `.css`, which the
// `tailwindcss` pseudo-language steals from `css`. In real VS Code that never
// shows, because `tailwindcss` is a distinct language id you only get with the
// Tailwind extension active -- a flattened map has no language ids, so plain
// stylesheets would render as Tailwind logos. Re-point it.
const SUFFIX_OVERRIDES = { css: 'file_type_css.svg' };

const fileNames = fold(theme.file_stems, resolveFile);
const fileExtensions = fold(theme.file_suffixes, resolveFile);
for (const [suffix, icon] of Object.entries(SUFFIX_OVERRIDES)) {
  if (!fs.existsSync(path.join(ext, 'icons', icon)))
    throw new Error(`override target missing: ${icon}`);
  fileExtensions.out[suffix] = icon;
  needed.add(icon);
}
const folderNames = fold(theme.named_directory_icons, (o) => {
  if (!o.collapsed) return null;
  const f = base(o.collapsed);
  needed.add(f);
  return f;
});
const folderNamesExpanded = fold(theme.named_directory_icons, (o) => {
  if (!o.expanded) return null;
  const f = base(o.expanded);
  needed.add(f);
  return f;
});

const defaults = {
  // The Zed theme has no default *file* icon, only default directory icons.
  // default_file.svg is what the VS Code manifest's `_file` definition points
  // at, and it ships in the same icons/ dir.
  file: 'default_file.svg',
  folder: base(theme.directory_icons.collapsed),
  folderExpanded: base(theme.directory_icons.expanded),
};
Object.values(defaults).forEach((f) => needed.add(f));

for (const c of [
  ...fileNames.collisions,
  ...fileExtensions.collisions,
  ...folderNames.collisions,
]) {
  console.warn(`  ! case collision ${c[0]}: kept ${c[1]}, dropped ${c[2]}`);
}

// ------------------------------------------------------------------- emit
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outIcons, { recursive: true });

let bytes = 0;
for (const f of [...needed].sort()) {
  const src = path.join(ext, 'icons', f);
  if (!fs.existsSync(src)) {
    console.warn(`  ! missing svg ${f}`);
    continue;
  }
  fs.copyFileSync(src, path.join(outIcons, f));
  bytes += fs.statSync(src).size;
}

const manifest = {
  _generated: `vscode-icons v${version} - ${THEME_NAME}. Regenerate with scripts/vendor-vscode-icons.mjs`,
  version,
  ...defaults,
  fileNames: fileNames.out,
  fileExtensions: fileExtensions.out,
  folderNames: folderNames.out,
  folderNamesExpanded: folderNamesExpanded.out,
};
fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify(manifest, null, 0) + '\n',
);

fs.copyFileSync(path.join(ext, 'LICENSE.txt'), path.join(outDir, 'LICENSE.txt'));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  `· wrote ${needed.size} svg (${(bytes / 1048576).toFixed(2)} MB) + manifest.json\n` +
    `  fileNames ${Object.keys(manifest.fileNames).length} · ` +
    `fileExtensions ${Object.keys(manifest.fileExtensions).length} · ` +
    `folderNames ${Object.keys(manifest.folderNames).length}`,
);
