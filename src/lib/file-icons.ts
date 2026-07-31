// VS Code-style file icons for the server-mode explorer, powered by the
// vscode-icons icon set (vscode-icons-team.vscode-icons).
//
// Unlike material-icon-theme there is no npm package that ships both the
// mapping and the SVGs, so both are vendored into ./vscode-icons by
// scripts/vendor-vscode-icons.mjs (run it to pick up an upstream release).
// manifest.json is a pre-flattened, lowercased map of the same four lookup
// categories the material manifest had; Vite's glob import turns every
// vendored SVG into a hashed asset URL.
import manifestJson from './vscode-icons/manifest.json';

interface IconManifest {
  file: string;
  folder: string;
  folderExpanded: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
}

const manifest = manifestJson as unknown as IconManifest;

const iconUrls = import.meta.glob('./vscode-icons/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

// Manifest values are bare SVG filenames ('file_type_rust.svg'), so unlike the
// material version there is no '.svg' to append here.
function urlFor(iconFile: string | undefined): string | null {
  if (!iconFile) return null;
  return iconUrls[`./vscode-icons/icons/${iconFile}`] ?? null;
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();
  let icon = manifest.fileNames[lower];
  if (!icon) {
    // Longest-suffix match so compound extensions (e.g. .d.ts, .test.tsx)
    // win over their plain tails.
    const parts = lower.split('.');
    for (let i = 1; i < parts.length && !icon; i++) {
      icon = manifest.fileExtensions[parts.slice(i).join('.')];
    }
    // Upstream files a handful of dotless stems ('makefile') under suffixes
    // rather than names, and the loop above never sees a name with no dot.
    if (!icon) icon = manifest.fileExtensions[lower];
  }
  return urlFor(icon) ?? urlFor(manifest.file) ?? '';
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();
  const named = expanded
    ? manifest.folderNamesExpanded[lower]
    : manifest.folderNames[lower];
  const fallback = expanded ? manifest.folderExpanded : manifest.folder;
  return urlFor(named) ?? urlFor(fallback) ?? '';
}
