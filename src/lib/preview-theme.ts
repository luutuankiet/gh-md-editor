// Preview-pane theme injection.
//
// github-markdown-css ships three flavors: an auto file that switches on
// prefers-color-scheme (no good for per-pane override), and explicit -light /
// -dark variants that BOTH declare rules under the same .markdown-body root.
// Importing both directly would have the last one win.
//
// Strategy: pull both as inline strings via Vite's `?inline` query, prefix
// every `.markdown-body` selector with `.markdown-body.theme-{light|dark}`,
// and inject ONCE into <head>. The preview pane then renders
// <article class="markdown-body theme-light"> or `theme-dark`, and CSS
// custom properties scope to that subtree.
//
// Bundle cost: ~44KB extra inlined (22KB × 2). Acceptable — the project's
// initial bundle budget is 1MB gzip per ARCHITECTURE.md.

import lightCSS from 'github-markdown-css/github-markdown-light.css?inline';
import darkCSS from 'github-markdown-css/github-markdown-dark.css?inline';

let injected = false;

function scope(css: string, theme: 'light' | 'dark'): string {
  // Match `.markdown-body` followed by anything that is not a word char or `-`
  // (so it does NOT clobber a hypothetical `.markdown-body-foo` class). Covers
  // bare `.markdown-body { ... }`, `.markdown-body h1`, `.markdown-body[x]`,
  // and trailing-EOL cases.
  return css.replace(/\.markdown-body(?=[^-\w]|$)/g, `.markdown-body.theme-${theme}`);
}

export function injectPreviewThemes(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.setAttribute('data-gmd-preview-themes', '');
  style.textContent = scope(lightCSS, 'light') + '\n' + scope(darkCSS, 'dark');
  document.head.appendChild(style);
}
