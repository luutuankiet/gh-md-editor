// Lazy starry-night highlighter for preview-pane fenced code blocks.
// starry-night is GitHub's actual syntax highlighter (TextMate grammars).
// Loaded on demand only when the preview contains a non-mermaid fenced code block,
// so the initial bundle stays small.

// starry-night's package exports map is `"./style/*": "./style/*.css"`, so requesting
// `style/light.css` resolves to `light.css.css` (broken). Drop the .css extension.
// `both` bundles light + dark with prefers-color-scheme media queries.
import '@wooorm/starry-night/style/both';
import { common, createStarryNight } from '@wooorm/starry-night';
import { toDom } from 'hast-util-to-dom';

type StarryNight = Awaited<ReturnType<typeof createStarryNight>>;

let starryNightPromise: Promise<StarryNight> | null = null;

function getStarryNight(): Promise<StarryNight> {
  if (!starryNightPromise) {
    starryNightPromise = createStarryNight(common);
  }
  return starryNightPromise;
}

export async function applyStarryNight(host: HTMLElement | null): Promise<void> {
  if (!host) return;
  const blocks = host.querySelectorAll<HTMLElement>('pre > code[class*="language-"]');
  if (blocks.length === 0) return;

  // Quick filter: bail if every block is mermaid (handled by mermaid.ts separately).
  let hasHighlightable = false;
  for (const b of blocks) {
    if (!b.className.includes('language-mermaid')) { hasHighlightable = true; break; }
  }
  if (!hasHighlightable) return;

  const starryNight = await getStarryNight();

  for (const block of Array.from(blocks)) {
    if (block.dataset.snHighlighted === 'true') continue;
    const langMatch = block.className.match(/language-(\S+)/);
    if (!langMatch) continue;
    const lang = langMatch[1];
    if (lang === 'mermaid') continue;

    const scope = starryNight.flagToScope(lang);
    if (!scope) continue;

    const text = block.textContent || '';
    try {
      const tree = starryNight.highlight(text, scope);
      const dom = toDom(tree, { fragment: true });
      block.textContent = '';
      block.appendChild(dom as Node);
      block.dataset.snHighlighted = 'true';
    } catch (err) {
      // Skip failed blocks silently; the un-highlighted source still renders.
      console.warn('starry-night failed for lang=' + lang, err);
    }
  }
}
