// CodeMirror 6 themes (chrome + highlight) for the editor pane.
//
// Two variants — light and dark — surfaced as Extension[] tuples ready to drop
// into a Compartment so Editor.svelte can hot-swap them when the user toggles.
//
// Dark palette is GitHub's 'primer' dark scheme (#0d1117 surface, c9d1d9 fg,
// ff7b72 / 79c0ff / d2a8ff / ffa657 token hues) — matches what
// github-markdown-dark.css renders in the preview pane, so both panes feel
// like the same editor when set to dark.
//
// Why this file exists: pre-v0.7 the Editor declared only the LIGHT highlight
// hex colors and relied on the browser's auto color-scheme to flip the editor
// chrome dark — which produced washed-out, near-invisible token colors against
// the dark surface (#0550ae dark blue on #0d1117 dark grey ≈ no contrast).

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

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

export const darkHighlight = HighlightStyle.define([
  { tag: t.heading1, color: '#ff7b72', fontWeight: '700', fontSize: '1.18em' },
  { tag: t.heading2, color: '#79c0ff', fontWeight: '700', fontSize: '1.10em' },
  { tag: t.heading3, color: '#d2a8ff', fontWeight: '600' },
  { tag: t.heading4, color: '#ffa657', fontWeight: '600' },
  { tag: t.heading5, color: '#a5d6ff', fontWeight: '500' },
  { tag: t.heading6, color: '#ffdfb6', fontWeight: '500' },
  { tag: t.strong, color: '#c9d1d9', fontWeight: '700' },
  { tag: t.emphasis, color: '#c9d1d9', fontStyle: 'italic' },
  { tag: t.monospace, color: '#ffa657', backgroundColor: 'rgba(110,118,129,0.30)' },
  { tag: t.link, color: '#58a6ff', textDecoration: 'underline' },
  { tag: t.url, color: '#58a6ff' },
  { tag: t.meta, color: '#8b949e' },
  { tag: t.quote, color: '#8b949e', fontStyle: 'italic' },
  { tag: t.list, color: '#c9d1d9' },
  { tag: t.keyword, color: '#ff7b72', fontWeight: '600' },
  { tag: t.controlKeyword, color: '#ff7b72', fontWeight: '600' },
  { tag: t.operatorKeyword, color: '#ff7b72' },
  { tag: t.definitionKeyword, color: '#ff7b72', fontWeight: '600' },
  { tag: t.modifier, color: '#ff7b72' },
  { tag: t.string, color: '#a5d6ff' },
  { tag: t.special(t.string), color: '#a5d6ff' },
  { tag: t.regexp, color: '#a5d6ff' },
  { tag: t.number, color: '#79c0ff' },
  { tag: t.atom, color: '#79c0ff' },
  { tag: t.bool, color: '#79c0ff' },
  { tag: t.null, color: '#79c0ff' },
  { tag: t.comment, color: '#8b949e', fontStyle: 'italic' },
  { tag: t.lineComment, color: '#8b949e', fontStyle: 'italic' },
  { tag: t.blockComment, color: '#8b949e', fontStyle: 'italic' },
  { tag: t.typeName, color: '#79c0ff' },
  { tag: t.className, color: '#79c0ff', fontWeight: '500' },
  { tag: t.variableName, color: '#c9d1d9' },
  { tag: t.propertyName, color: '#d2a8ff' },
  { tag: t.function(t.variableName), color: '#d2a8ff' },
  { tag: t.function(t.propertyName), color: '#d2a8ff' },
  { tag: t.definition(t.variableName), color: '#c9d1d9' },
  { tag: t.standard(t.variableName), color: '#79c0ff' },
  { tag: t.attributeName, color: '#d2a8ff' },
  { tag: t.attributeValue, color: '#a5d6ff' },
  { tag: t.tagName, color: '#7ee787' },
  { tag: t.namespace, color: '#79c0ff' },
  { tag: t.operator, color: '#ff7b72' },
  { tag: t.punctuation, color: '#c9d1d9' },
  { tag: t.bracket, color: '#c9d1d9' },
  { tag: t.escape, color: '#79c0ff' },
  { tag: t.invalid, color: '#ff7b72', textDecoration: 'underline wavy' },
]);

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

export const darkEditorTheme = EditorView.theme({
  '&': { backgroundColor: '#0d1117', color: '#c9d1d9' },
  '.cm-content': { caretColor: '#c9d1d9' },
  '.cm-gutters': {
    backgroundColor: '#0d1117',
    color: '#6e7681',
    border: 'none',
    borderRight: '1px solid #21262d',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(56,139,253,0.10)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(56,139,253,0.18)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(56,139,253,0.40) !important' },
  '.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(56,139,253,0.40) !important' },
  '.cm-cursor': { borderLeftColor: '#c9d1d9' },
  '.cm-panel.cm-search': {
    background: 'rgba(22,27,34,0.96)',
    border: '1px solid #30363d',
    color: '#c9d1d9',
  },
  '.cm-panel.cm-search input.cm-textfield': {
    background: '#0d1117',
    border: '1px solid #30363d',
    color: '#c9d1d9',
  },
  '.cm-panel.cm-search button[name]:hover': {
    background: 'rgba(56,139,253,0.16)',
    borderColor: '#30363d',
  },
}, { dark: true });

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
