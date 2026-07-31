// CodeMirror 6 themes (chrome + highlight) for the editor pane.
//
// Two variants — light and dark — surfaced as Extension[] tuples ready to drop
// into a Compartment so Editor.svelte can hot-swap them when the user toggles.
//
// Light palette is GitHub's 'primer' light scheme. Dark is Monokai Dimmed,
// defined once in monokai-dimmed.ts and shared with the server-mode code
// editor so a fenced block here and the same file opened as a tab look alike.
// (The preview pane still renders through github-markdown-css, a separate
// engine with its own dark sheet — it does not follow this palette.)
//
// Why this file exists: pre-v0.7 the Editor declared only the LIGHT highlight
// hex colors and relied on the browser's auto color-scheme to flip the editor
// chrome dark — which produced washed-out, near-invisible token colors against
// the dark surface (#0550ae dark blue on #0d1117 dark grey ≈ no contrast).

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { monokaiChrome, monokaiMarkdownHighlight } from './monokai-dimmed';

export const lightHighlight = HighlightStyle.define([
  // Markdown-level tags
  { tag: t.heading1, color: '#cf222e', fontWeight: '700', fontSize: '1.18em' },
  { tag: t.heading2, color: '#0550ae', fontWeight: '700', fontSize: '1.10em' },
  { tag: t.heading3, color: '#6639ba', fontWeight: '600' },
  { tag: t.heading4, color: '#953800', fontWeight: '600' },
  { tag: t.heading5, color: '#0a3069', fontWeight: '500' },
  { tag: t.heading6, color: '#3b2300', fontWeight: '500' },
  { tag: t.strong, color: '#1f2328', fontWeight: '700' },
  { tag: t.emphasis, color: '#1f2328', fontStyle: 'italic' },
  { tag: t.monospace, color: '#953800', backgroundColor: 'rgba(175,184,193,0.20)' },
  { tag: t.link, color: '#0969da', textDecoration: 'underline' },
  { tag: t.url, color: '#0969da' },
  { tag: t.meta, color: '#6e7681' },
  { tag: t.quote, color: '#6e7681', fontStyle: 'italic' },
  { tag: t.list, color: '#1f2328' },
  // Nested-language tags (SQL, TypeScript, Python, etc. inside fenced code).
  { tag: t.keyword, color: '#cf222e', fontWeight: '600' },
  { tag: t.controlKeyword, color: '#cf222e', fontWeight: '600' },
  { tag: t.operatorKeyword, color: '#cf222e' },
  { tag: t.definitionKeyword, color: '#cf222e', fontWeight: '600' },
  { tag: t.modifier, color: '#cf222e' },
  { tag: t.string, color: '#0a3069' },
  { tag: t.special(t.string), color: '#0a3069' },
  { tag: t.regexp, color: '#0a3069' },
  { tag: t.number, color: '#0550ae' },
  { tag: t.atom, color: '#0550ae' },
  { tag: t.bool, color: '#0550ae' },
  { tag: t.null, color: '#0550ae' },
  { tag: t.comment, color: '#6e7681', fontStyle: 'italic' },
  { tag: t.lineComment, color: '#6e7681', fontStyle: 'italic' },
  { tag: t.blockComment, color: '#6e7681', fontStyle: 'italic' },
  { tag: t.typeName, color: '#0550ae' },
  { tag: t.className, color: '#0550ae', fontWeight: '500' },
  { tag: t.variableName, color: '#1f2328' },
  { tag: t.propertyName, color: '#6639ba' },
  { tag: t.function(t.variableName), color: '#6639ba' },
  { tag: t.function(t.propertyName), color: '#6639ba' },
  { tag: t.definition(t.variableName), color: '#1f2328' },
  { tag: t.standard(t.variableName), color: '#0550ae' },
  { tag: t.attributeName, color: '#6639ba' },
  { tag: t.attributeValue, color: '#0a3069' },
  { tag: t.tagName, color: '#116329' },
  { tag: t.namespace, color: '#0550ae' },
  { tag: t.operator, color: '#cf222e' },
  { tag: t.punctuation, color: '#1f2328' },
  { tag: t.bracket, color: '#1f2328' },
  { tag: t.escape, color: '#0550ae' },
  { tag: t.invalid, color: '#cf222e', textDecoration: 'underline wavy' },
]);

// Re-exported under the old names so every import site stays put.
export const darkHighlight = monokaiMarkdownHighlight;

// Editor chrome (surface, gutter, cursor, selection, search panel) per theme.
// dark:true / dark:false signals to CM6 which default extension colors to use
// when an extension doesn't override (e.g. selection contrast computations).
export const lightEditorTheme = EditorView.theme({
  '&': { backgroundColor: '#ffffff', color: '#1f2328' },
  '.cm-content': { caretColor: '#1f2328' },
  '.cm-gutters': {
    backgroundColor: '#f6f8fa',
    color: '#6e7681',
    border: 'none',
    borderRight: '1px solid #d0d7de',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(208,215,222,0.20)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(208,215,222,0.40)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: '#b6d6fb !important' },
  '.cm-focused .cm-selectionBackground': { backgroundColor: '#b6d6fb !important' },
  '.cm-cursor': { borderLeftColor: '#1f2328' },
  // Search panel chrome — light background, dark text.
  '.cm-panel.cm-search': {
    background: 'rgba(255,255,255,0.96)',
    border: '1px solid #d0d7de',
    color: '#1f2328',
  },
  '.cm-panel.cm-search input.cm-textfield': {
    background: '#ffffff',
    border: '1px solid #d0d7de',
    color: '#1f2328',
  },
  '.cm-panel.cm-search button[name]:hover': {
    background: 'rgba(9,105,218,0.10)',
    borderColor: '#d0d7de',
  },
}, { dark: false });

export const darkEditorTheme = monokaiChrome;

export function editorThemeExtensions(theme: 'light' | 'dark'): Extension[] {
  if (theme === 'dark') {
    return [
      syntaxHighlighting(darkHighlight),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      darkEditorTheme,
    ];
  }
  return [
    syntaxHighlighting(lightHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    lightEditorTheme,
  ];
}
