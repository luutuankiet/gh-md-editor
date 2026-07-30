// VS Code-style file icons for the server-mode explorer, powered by the
// material-icon-theme package (same icon set as the VS Code extension).
// generateManifest() yields the filename/extension/foldername → icon-name
// mapping; Vite's glob import turns every shipped SVG into a hashed asset URL.
import { generateManifest } from 'material-icon-theme';

const manifest = generateManifest();

const iconUrls = import.meta.glob(
  '../../node_modules/material-icon-theme/icons/*.svg',
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>;

function urlFor(iconName: string | undefined): string | null {
  if (!iconName) return null;
  return iconUrls[`../../node_modules/material-icon-theme/icons/${iconName}.svg`] ?? null;
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();
  let icon = manifest.fileNames?.[lower];
  if (!icon) {
    // Longest-suffix match so compound extensions (e.g. .d.ts, .test.tsx)
    // win over their plain tails.
    const parts = lower.split('.');
    for (let i = 1; i < parts.length && !icon; i++) {
      icon = manifest.fileExtensions?.[parts.slice(i).join('.')];
    }
  }
  return urlFor(icon) ?? urlFor(manifest.file) ?? '';
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();
  const named = expanded
    ? manifest.folderNamesExpanded?.[lower]
    : manifest.folderNames?.[lower];
  const fallback = expanded ? manifest.folderExpanded : manifest.folder;
  return urlFor(named) ?? urlFor(fallback) ?? '';
}
