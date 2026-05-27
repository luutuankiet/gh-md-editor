import MarkdownIt from 'markdown-it';
import GithubAlerts from 'markdown-it-github-alerts';

// html: true enables native <details>/<summary>/<kbd>/etc. — GitHub-style collapsible blocks
// work via the browser's built-in <details> behaviour once the raw HTML passes through.
// Trade-off: arbitrary HTML can XSS, acceptable for this personal-use editor (author = reader).
const md = new MarkdownIt({
  html: true,
  linkify: true,
  // v0.7.7 / v0.2.6: GFM-style soft breaks. Every `\n` in source becomes a
  // `<br>` in output — matches GitHub issue/PR/comment rendering and the
  // user's WYSIWYG-ish mental model (editor source line = preview visual line).
  // Pre-v0.7.7 was strict CommonMark (consecutive non-blank lines collapsed
  // into one space-joined paragraph), which lost the visual line layout of
  // structured prose like sequential `**Field:** value` lines used heavily
  // in agentic-prompt markdown.
  breaks: true,
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
  // v0.6.1 + v0.7.6 / v0.2.5: undo line-shift from TWO normalizers that run
  // before markdown-it sees the source:
  //   (1) normalizeAlerts — synthesizes body lines for inline `> [!NOTE] body`
  //   (2) normalizeStandaloneTags — surrounds prompt-engineering tags like
  //       <active_task> / <vision> with blank lines so each becomes its own
  //       html_block / paragraph, preserving the editor's line layout.
  // Both insertions arrays are monotonically ascending; subtraction order
  // matters — undo tag normalizer FIRST since it ran LAST on the alert-
  // normalized source.
  const env = state.env as any;
  const alertInsertions: number[] = (env?.alertInsertions ?? []) as number[];
  const tagInsertions: number[] = (env?.tagInsertions ?? []) as number[];
  for (const tok of state.tokens) {
    if (!BLOCK_OPEN_TYPES.has(tok.type)) continue;
    if (!tok.map || tok.map.length < 1) continue;
    let line = tok.map[0] + 1; // 1-indexed in FINAL (post-normalize) source
    let adj = 0;
    for (const ins of tagInsertions) {
      if (ins <= line) adj++;
      else break;
    }
    line -= adj;
    adj = 0;
    for (const ins of alertInsertions) {
      if (ins <= line) adj++;
      else break;
    }
    tok.attrJoin('data-source-line', String(line - adj));
  }
});

// v0.7.5 / v0.2.4: render arbitrary XML-like tags (e.g. <active_task>, <vision>,
// <decisions>) as literal text in the preview, NOT as HTML elements the browser
// silently swallows. Two leak modes existed before this fix:
//   (1) Tags with underscores (e.g. <active_task>) failed markdown-it's tag
//       regex and went through the text-token path — automatically HTML-escaped
//       by markdown-it → already rendered as literal text. Working.
//   (2) Tags with clean names (e.g. <vision>, <blockers>) PASSED markdown-it's
//       regex and reached the browser as HTMLUnknownElement instances — invisible
//       but their content flowed inline, silently collapsing paragraph
//       boundaries around them. THIS is the leak this override closes.
// Whitelist approach: override html_block + html_inline renderers to escape any
// tag whose name is NOT in HTML5_TAG_WHITELIST. <details>, <kbd>, <sub>, <sup>,
// <mark> etc. pass through byte-identical to before. <script>, <style>, <iframe>
// are intentionally NOT in the whitelist — additive defense even though html:true
// is on (author = reader trust model unchanged). Code blocks are automatically
// safe — their content flows through fence/code_block/code_inline tokens, never
// html_block/html_inline.
const HTML5_TAG_WHITELIST = new Set([
  'a','abbr','address','article','aside','b','bdi','bdo','blockquote','br',
  'caption','cite','code','col','colgroup','dd','del','details','dfn','div',
  'dl','dt','em','figcaption','figure','footer','h1','h2','h3','h4','h5','h6',
  'header','hgroup','hr','i','img','ins','kbd','li','main','mark','nav','ol',
  'p','picture','pre','q','s','samp','section','small','source','span','strong',
  'sub','summary','sup','table','tbody','td','tfoot','th','thead','time','tr',
  'u','ul','var','wbr',
]);

const FIRST_TAG_NAME_RE = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)\b/;

function isWhitelistedHtml(content: string): boolean {
  const m = FIRST_TAG_NAME_RE.exec(content.trim());
  // Comments / CDATA / processing instructions — not a normal tag; pass through.
  if (!m) return true;
  return HTML5_TAG_WHITELIST.has(m[1].toLowerCase());
}

const _origHtmlBlock = md.renderer.rules.html_block;
const _origHtmlInline = md.renderer.rules.html_inline;

md.renderer.rules.html_block = function (tokens, idx, opts, env, self) {
  const tok = tokens[idx];
  const c = tok.content;
  if (isWhitelistedHtml(c)) {
    return _origHtmlBlock ? _origHtmlBlock.call(this, tokens, idx, opts, env, self) : c;
  }
  // v0.7.6 / v0.2.5: wrap escaped non-whitelisted tags in <p data-source-line="N">
  // so right-click reveal-counterpart fires on them (walks up from click target,
  // finds the data-source-line attribute, jumps editor to that line). Safe to
  // wrap here — unlike the unescaped pass-through case (see // NOTE below)
  // — because escaped output is pure text, no HTML construct to split.
  const lineAttr = tok.attrs?.find(([k]) => k === 'data-source-line')?.[1];
  const escaped = md.utils.escapeHtml(c.trim());
  return lineAttr
    ? `<p data-source-line="${lineAttr}">${escaped}</p>\n`
    : `<p>${escaped}</p>\n`;
};
md.renderer.rules.html_inline = function (tokens, idx, opts, env, self) {
  const c = tokens[idx].content;
  return isWhitelistedHtml(c)
    ? (_origHtmlInline ? _origHtmlInline.call(this, tokens, idx, opts, env, self) : c)
    : md.utils.escapeHtml(c);
};

// NOTE: do NOT wrap html_block in a <div data-source-line> wrapper — multi-line
// HTML constructs (most importantly `<details>...</details>`) span SEPARATE
// html_block tokens (one for the opening tag block, one for the closing tag).
// Wrapping each in its own <div> splits the construct in half and the browser
// auto-balances by closing <details> at the wrong place, so the inner markdown
// renders OUTSIDE the collapsible. Inner markdown (headings, paragraphs) still
// carries its own data-source-line, which is enough for reveal-navigation and
// outline tracking — expandDetailsAncestors() walks UP from those to the
// enclosing <details>.

// v0.6.1: markdown-it-github-alerts only recognizes `> [!NOTE]` when the marker
// is on its own line followed by body on subsequent `> ` lines. If the user
// writes `> [!NOTE] body` with body INLINE on the same line, the plugin still
// recognizes the marker but the resulting alert body layout is broken (centered/
// indented title-styling bleeds into the body). GitHub's native renderer is
// lenient and handles inline body correctly; we mirror that by splitting the
// marker and body into the canonical two-line form before parsing.
//
// Matches all 5 GitHub alert types case-insensitively. The split is tracked in
// `insertions` so `source_line_map` can subtract them and keep editor↔preview
// navigation aligned to the user's original line numbers.
const ALERT_INLINE_PATTERN = /^(\s*>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])\s+(\S.*)$/i;

function normalizeAlerts(src: string): { normalized: string; insertions: number[] } {
  const lines = src.split('\n');
  const out: string[] = [];
  const insertions: number[] = []; // 1-indexed lines in OUTPUT where a body line was synthesized
  for (const line of lines) {
    const m = ALERT_INLINE_PATTERN.exec(line);
    if (m) {
      out.push(m[1]);                 // marker on its own line
      out.push(`> ${m[2]}`);          // body forced to next line
      insertions.push(out.length);    // record synthesized body line (post-push, 1-indexed)
    } else {
      out.push(line);
    }
  }
  return { normalized: out.join('\n'), insertions };
}

// v0.7.6 / v0.2.5: detect "lone tag on its own line" — covers BOTH shapes:
//   - tags markdown-it would accept as HTML (e.g. <vision>, <decisions>)
//   - tags markdown-it rejects (underscores, spaces, weird chars) but the
//     user still uses as structural delimiters (e.g. <active_task>,
//     <some name of tag>, <this_is>)
// Permissive on tag NAME (allows almost anything up to `>`) because the regex
// is paired with a whitelist filter — known HTML5 tags pass through untouched,
// everything else gets blank-line isolated so markdown-it makes each its own
// html_block / paragraph and the editor line layout is preserved.
//
// Anchor `^\s{0,3}`: 0-3 spaces of indent allowed (4+ would mean indented code
// block per CommonMark spec, which we MUST NOT touch).
const ANY_STANDALONE_TAG_RE = /^\s{0,3}<\/?\s*([a-zA-Z][^>]*)\s*>\s*$/;
// Extract a plausible HTML tag name (alphanumerics + hyphens only, per HTML5
// spec) from the inside content of a tag-shaped line. If the inside content
// doesn't start with a real-shaped tag name (e.g. <active_task> has an
// underscore, <some name> has a space), this still returns the leading word
// — but it won't appear in HTML5_TAG_WHITELIST, so the line gets isolated.
const HTML_TAG_NAME_PREFIX_RE = /^([a-zA-Z][a-zA-Z0-9-]*)/;

function normalizeStandaloneTags(src: string): { normalized: string; insertions: number[] } {
  const lines = src.split('\n');
  const out: string[] = [];
  const insertions: number[] = [];
  let inFence = false;
  let fenceChar = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // CRITICAL: do NOT normalize content inside fenced code blocks. Inserting
    // blank lines around tag-shaped lines inside ```...``` would mangle the
    // rendered code-block content (which is preserved as-is by markdown-it,
    // including any inserted blanks). Mirror the fence-state tracker used by
    // extractOutline() below.
    const fenceMatch = /^(\s{0,3})(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
      } else if (marker[0] === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const m = ANY_STANDALONE_TAG_RE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }

    const nameMatch = HTML_TAG_NAME_PREFIX_RE.exec(m[1].trim());
    const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';

    if (tagName && HTML5_TAG_WHITELIST.has(tagName)) {
      // Whitelisted real HTML tag (<details>, <summary>, <kbd>, ...) — leave
      // untouched; preserves the v0.3.x-era HTML pass-through path so multi-
      // line constructs like <details>/<summary>...</details> still work.
      out.push(line);
      continue;
    }

    // Non-whitelisted standalone tag — surround with blank lines so markdown-it
    // sees it as an isolated block, NOT merged into the surrounding paragraph.
    // The html_block / paragraph_open path then attaches data-source-line, and
    // the html_block renderer override escapes the tag to literal text wrapped
    // in <p data-source-line>. Result in the rendered preview: each tag occupies
    // its own visual line at the editor's source line, with content between
    // tags rendered as normal markdown (paragraphs, lists, formatting all work).
    if (out.length > 0 && out[out.length - 1].trim() !== '') {
      out.push('');
      insertions.push(out.length); // 1-indexed line number of inserted blank
    }
    out.push(line);
    if (i + 1 < lines.length && lines[i + 1].trim() !== '') {
      out.push('');
      insertions.push(out.length);
    }
  }

  return { normalized: out.join('\n'), insertions };
}

export function parseMarkdown(src: string): string {
  // Chained normalization. Order matters for line tracking:
  //   1. normalizeAlerts — splits inline `> [!NOTE] body` into two lines
  //   2. normalizeStandaloneTags — isolates prompt tags with blank lines
  // Each stage emits its own insertions array; source_line_map ruler undoes
  // them in REVERSE order (tag first, then alert) to map tokens back to the
  // user's original source line.
  const a = normalizeAlerts(src);
  const t = normalizeStandaloneTags(a.normalized);
  return md.render(t.normalized, {
    alertInsertions: a.insertions,
    tagInsertions: t.insertions,
  });
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
