import MarkdownIt from 'markdown-it';
import GithubAlerts from 'markdown-it-github-alerts';

// html: true enables native <details>/<summary>/<kbd>/etc. — GitHub-style collapsible blocks
// work via the browser's built-in <details> behaviour once the raw HTML passes through.
// Trade-off: arbitrary HTML can XSS, acceptable for this personal-use editor (author = reader).
const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});

// GitHub-flavored callouts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION].
// The plugin rewrites `blockquote_open` → `alert_open` (tag=div, meta.title/type/icon)
// and emits `<div class="markdown-alert markdown-alert-${type}"><p class="markdown-alert-title">…`.
md.use(GithubAlerts);

// Tokens whose rendered open-tag should carry `data-source-line` so the preview
// can map preview clicks back to editor line numbers (and reveal can find them).
// `alert_open` is added because the github-alerts plugin renames blockquote_open
// to alert_open before our rule runs — without it, callouts lose their source line.
const BLOCK_OPEN_TYPES = new Set([
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'list_item_open',
  'bullet_list_open',
  'ordered_list_open',
  'table_open',
  'tr_open',
  'fence',
  'code_block',
  'hr',
  'html_block',
  'alert_open',
]);

md.core.ruler.push('source_line_map', (state) => {
  for (const tok of state.tokens) {
    if (!BLOCK_OPEN_TYPES.has(tok.type)) continue;
    if (!tok.map || tok.map.length < 1) continue;
    const line = tok.map[0] + 1; // 1-indexed
    tok.attrJoin('data-source-line', String(line));
  }
});

// NOTE: do NOT wrap html_block in a <div data-source-line> wrapper — multi-line
// HTML constructs (most importantly `<details>...</details>`) span SEPARATE
// html_block tokens (one for the opening tag block, one for the closing tag).
// Wrapping each in its own <div> splits the construct in half and the browser
// auto-balances by closing <details> at the wrong place, so the inner markdown
// renders OUTSIDE the collapsible. Inner markdown (headings, paragraphs) still
// carries its own data-source-line, which is enough for reveal-navigation and
// outline tracking — expandDetailsAncestors() walks UP from those to the
// enclosing <details>.

export function parseMarkdown(src: string): string {
  return md.render(src);
}

export { md };

export interface OutlineNode {
  level: number;
  text: string;
  line: number;
  children: OutlineNode[];
}

/**
 * Extracts H1-H8 headings from raw markdown source.
 * Skips headings inside fenced code blocks (``` or ~~~).
 * Strips common inline markdown from heading text for display.
 * Returns a tree built by relative heading levels.
 */
export function extractOutline(src: string): OutlineNode[] {
  const lines = src.split('\n');
  const flat: { level: number; text: string; line: number }[] = [];
  let inFence = false;
  let fenceChar = '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    const fenceMatch = /^(\s{0,3})(```+|~~~+)/.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
      } else if (marker[0] === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,8})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (!m) continue;

    const level = m[1].length;
    const text = m[2]
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .trim();

    if (text) flat.push({ level, text, line: i + 1 });
  }

  return buildOutlineTree(flat);
}

function buildOutlineTree(flat: { level: number; text: string; line: number }[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const f of flat) {
    const node: OutlineNode = { ...f, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}
