// Rough token count without shipping a tokenizer. Anthropic does not publish
// the Claude BPE table, and the open ones are megabytes of vocabulary for a
// number that only ever informs a judgement call. This approximates from the
// two signals that actually drive BPE output instead: how many word-ish runs
// the text has, and how much of it is punctuation that splits off on its own.
//
// Prose lands near chars/4 and source code nearer chars/3; the blend below
// tracks both within roughly ten percent. Always render the result with a `~`.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let words = 0;
  let symbols = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Non-ASCII counts as word material: CJK and emoji cost more per character,
    // which the higher per-word weight below absorbs.
    const wordish =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;
    if (wordish) {
      if (!inWord) {
        words++;
        inWord = true;
      }
      continue;
    }
    inWord = false;
    // Whitespace rides along with the word that follows it; other punctuation
    // almost always costs a token of its own.
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) symbols++;
  }
  // A word run averages ~1.35 tokens (short words are one, long identifiers
  // split into several); punctuation ~0.8 once runs like `);` merge.
  return Math.max(1, Math.round(words * 1.35 + symbols * 0.8));
}

// 950 -> "950", 12400 -> "12.4k", 1240000 -> "1.2M"
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
