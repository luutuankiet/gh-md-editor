import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

const BLOCK_OPEN_TYPES = new Set([
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'list_item_open',
  'bullet_list_open',
  'ordered_list_open',
  'table_open',
  'fence',
  'code_block',
  'hr',
  'html_block',
]);

md.core.ruler.push('source_line_map', (state) => {
  for (const tok of state.tokens) {
    if (!BLOCK_OPEN_TYPES.has(tok.type)) continue;
    if (!tok.map || tok.map.length < 1) continue;
    const line = tok.map[0] + 1; // 1-indexed
    tok.attrJoin('data-source-line', String(line));
  }
});

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
