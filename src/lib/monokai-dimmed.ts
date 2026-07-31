// Monokai Dimmed for CodeMirror 6 — a port of VS Code's built-in theme
// (extensions/theme-monokai-dimmed/themes/dimmed-monokai-color-theme.json).
//
// Single source of truth for BOTH panes. The markdown cockpit (via
// editor-theme.ts) and the server-mode code editor (CodeTab.svelte) each used
// to carry their own hand-maintained GitHub-dark palette; they drifted, and
// fixing a colour meant remembering to fix it twice.
//
// Faithfulness notes, so a future edit doesn't "correct" these back:
//   - all six heading levels share ONE yellow upstream. Hierarchy is carried
//     by weight and size only, never by hue.
//   - comments are NOT italic. The upstream rule sets fontStyle to the empty
//     string, which is an explicit reset rather than an omission.
//   - inline code really is hot pink.
// The theme only defines 64 colours and inherits everything else from VS
// Code's dark default, so entries flagged 'inherited' below are drawn from
// its own greys rather than invented.

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

// Chrome palette. Exported because the app shell (explorer, tabs, panels,
// modals) has to match the editor surface for the theme to read as one thing.
export const mono = {
  bg: '#1e1e1e',
  fg: '#c5c8c6',
  caret: '#c07020',
  selection: 'rgba(103,107,113,0.50)',
  activeLine: '#303030',
  gutterFg: '#606060',            // inherited
  gutterActiveFg: '#949494',
  border: '#303030',
  surface: '#272727',             // side bar, menus, quick input
  surfaceAlt: '#282828',          // tab strip
  surfaceRaised: '#353535',       // activity bar
  tabInactive: '#404040',
  hover: '#444444',
  selectedInactive: '#4e4e4e',
  selected: '#707070',
  chrome: '#505050',              // status bar, title bar, section headers
  inputBg: '#525252',
  buttonBg: '#565656',
  accent: '#3655b5',              // focus border, badges
  accentWarm: '#e58520',          // highlighted text in lists
  muted: '#b0b0b0',
  bright: '#ffffff',
  indentGuide: '#505037',
  indentGuideActive: '#707057',
  findMatch: 'rgba(71,71,161,0.50)',        // inherited
  findMatchActive: 'rgba(103,103,206,0.50)', // inherited
};

// Token palette, named by role rather than by hue so the tag map below reads
// as intent. Values are lifted verbatim from the upstream tokenColors array.
const c = {
  fg: '#C5C8C6',
  comment: '#9A9B99',
  olive: '#9AA83A',     // strings
  blue: '#6089B4',      // numbers, variables, tags
  purple: '#9872A2',    // control flow, properties
  red: '#C7444A',
  darkRed: '#9B0000',   // types and classes
  burntOrange: '#CE6700', // function names
  orange: '#D08442',    // escapes inside strings, regexps
  yellow: '#D0B344',    // attribute names, headings
  grey: '#676867',      // plain keywords, operators
  teal: '#408080',      // booleans and null
  periwinkle: '#8080FF', // constants, character escapes
  alarm: '#FF0B00',     // invalid
  pink: '#FF0080',      // inline code
  violet: '#AE81FF',    // links
};

// Tags shared by every grammar the editor can load.
const codeTags = [
  { tag: t.keyword, color: c.grey },
  { tag: t.controlKeyword, color: c.purple },
  { tag: t.operatorKeyword, color: c.purple },
  { tag: t.definitionKeyword, color: c.purple },
  { tag: t.modifier, color: c.purple },
  { tag: t.string, color: c.olive },
  { tag: t.special(t.string), color: c.orange },
  { tag: t.regexp, color: c.orange },
  { tag: t.comment, color: c.comment },
  { tag: t.lineComment, color: c.comment },
  { tag: t.blockComment, color: c.comment },
  { tag: t.docComment, color: c.comment },
  { tag: t.number, color: c.blue },
  { tag: t.bool, color: c.teal },
  { tag: t.null, color: c.teal },
  { tag: t.atom, color: c.teal },
  { tag: t.variableName, color: c.blue },
  { tag: t.definition(t.variableName), color: c.blue },
  { tag: t.local(t.variableName), color: c.blue },
  { tag: t.special(t.variableName), color: c.red },
  { tag: t.standard(t.variableName), color: c.red },
  { tag: t.constant(t.variableName), color: c.periwinkle },
  { tag: t.self, color: c.red },
  { tag: t.propertyName, color: c.purple },
  { tag: t.function(t.variableName), color: c.burntOrange },
  { tag: t.function(t.propertyName), color: c.burntOrange },
  { tag: t.definition(t.function(t.variableName)), color: c.burntOrange },
  { tag: t.labelName, color: c.burntOrange },
  { tag: t.typeName, color: c.darkRed },
  { tag: t.className, color: c.darkRed },
  { tag: t.namespace, color: c.darkRed },
  { tag: t.tagName, color: c.blue },
  { tag: t.attributeName, color: c.yellow },
  { tag: t.attributeValue, color: c.olive },
  { tag: t.operator, color: c.grey },
  { tag: t.punctuation, color: c.fg },
  { tag: t.bracket, color: c.fg },
  { tag: t.meta, color: c.fg },
  { tag: t.processingInstruction, color: c.comment },
  { tag: t.escape, color: c.periwinkle },
  { tag: t.character, color: c.periwinkle },
  { tag: t.invalid, color: c.alarm },
];

// Markdown-only tags. Upstream gives every heading the same yellow, so the
// only signal left for depth is weight and size.
const markdownTags = [
  { tag: t.heading1, color: c.yellow, fontWeight: '700', fontSize: '1.18em' },
  { tag: t.heading2, color: c.yellow, fontWeight: '700', fontSize: '1.10em' },
  { tag: t.heading3, color: c.yellow, fontWeight: '700' },
  { tag: t.heading4, color: c.yellow, fontWeight: '600' },
  { tag: t.heading5, color: c.yellow, fontWeight: '500' },
  { tag: t.heading6, color: c.yellow, fontWeight: '500' },
  { tag: t.strong, color: c.blue, fontWeight: '700' },
  { tag: t.emphasis, color: c.blue, fontStyle: 'italic' },
  { tag: t.strikethrough, color: c.fg, textDecoration: 'line-through' },
  { tag: t.monospace, color: c.pink, backgroundColor: 'rgba(103,107,113,0.22)' },
  { tag: t.link, color: c.violet, textDecoration: 'underline' },
  { tag: t.url, color: c.violet },
  { tag: t.quote, color: c.purple, fontStyle: 'italic' },
  { tag: t.list, color: c.olive },
];

export const monokaiCodeHighlight = HighlightStyle.define(codeTags);
export const monokaiMarkdownHighlight = HighlightStyle.define([...markdownTags, ...codeTags]);

// Editor chrome. Shared by both panes so a fenced code block in the markdown
// cockpit sits on the same surface as the same code opened as a file.
export const monokaiChrome = EditorView.theme({
  '&': { backgroundColor: mono.bg, color: mono.fg },
  '.cm-content': { caretColor: mono.caret },
  '.cm-gutters': {
    backgroundColor: mono.bg,
    color: mono.gutterFg,
    border: 'none',
    borderRight: `1px solid ${mono.border}`,
  },
  '.cm-activeLine': { backgroundColor: mono.activeLine },
  '.cm-activeLineGutter': { backgroundColor: mono.activeLine, color: mono.gutterActiveFg },
  '.cm-selectionBackground, ::selection': { backgroundColor: `${mono.selection} !important` },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: `${mono.selection} !important` },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: mono.caret, borderLeftWidth: '2px' },
  '.cm-selectionMatch': { backgroundColor: mono.findMatch },
  '.cm-searchMatch': { backgroundColor: mono.findMatch, outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: mono.findMatchActive },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(87,91,97,0.50)',
    outline: `1px solid ${mono.indentGuideActive}`,
  },
  '.cm-foldPlaceholder': {
    backgroundColor: mono.surface,
    border: `1px solid ${mono.border}`,
    color: mono.muted,
  },
  '.cm-panels': { backgroundColor: mono.surface, color: mono.fg },
  '.cm-panel.cm-search': {
    background: mono.surface,
    border: `1px solid ${mono.border}`,
    color: mono.fg,
  },
  '.cm-panel.cm-search input.cm-textfield': {
    background: mono.inputBg,
    border: `1px solid ${mono.border}`,
    color: mono.fg,
  },
  '.cm-panel.cm-search input.cm-textfield:focus': { borderColor: mono.accent },
  '.cm-panel.cm-search button[name]:hover': {
    background: mono.hover,
    borderColor: mono.border,
  },
  '.cm-tooltip': {
    backgroundColor: mono.surface,
    border: `1px solid ${mono.border}`,
    color: mono.fg,
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: mono.selected,
    color: mono.bright,
  },
}, { dark: true });

// Chrome and token colours travel together — a compartment that swapped only
// one of the two would leave the editor half-themed mid-transition.
export const monokaiCodeBundle: Extension[] = [
  monokaiChrome,
  syntaxHighlighting(monokaiCodeHighlight),
];
