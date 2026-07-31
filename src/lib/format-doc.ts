// Document formatting. JSON only for now — it covers the overwhelming
// majority of the reach-for-the-formatter cases, and it is the one language
// that can be formatted without shipping a parser for it.
//
// Deliberately NOT JSON.parse followed by JSON.stringify. That round-trip
// rebuilds the document out of JavaScript values, which quietly reorders
// integer-like keys ({"10":..,"2":..} comes back sorted numerically) and
// rounds any number that does not survive a float64 — snowflake ids, high
// precision decimals, 1e999. Both are silent data loss in a command whose
// entire promise is that it only touches whitespace.
//
// Instead: parse once purely to validate (the result is thrown away, and the
// thrown error carries a position for free), then re-indent by walking the
// ORIGINAL characters. Every literal is copied through byte for byte.
//
// Not routed through the server's jq either. A round-trip is slower than
// doing this locally, and the static build has no server to ask.

const WS = ' \t\n\r';

function nextSignificant(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (!WS.includes(text[i])) return i;
  }
  return -1;
}

export function formatJson(text: string, indentWidth = 2): string {
  JSON.parse(text); // validation only — the parsed value is intentionally unused

  const pad = ' '.repeat(indentWidth);
  const breakTo = (d: number) => '\n' + pad.repeat(d);
  let out = '';
  let depth = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Strings are copied whole, escapes included, so nothing inside one is
    // ever mistaken for structure.
    if (ch === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        i++;
      }
      out += text.slice(start, i);
      continue;
    }

    // All original whitespace is dropped; this function is the sole author
    // of layout.
    if (WS.includes(ch)) { i++; continue; }

    if (ch === '{' || ch === '[') {
      // Empty containers stay on one line, as every other formatter does.
      const next = nextSignificant(text, i + 1);
      if (next >= 0 && (text[next] === '}' || text[next] === ']')) {
        out += ch + text[next];
        i = next + 1;
        continue;
      }
      depth++;
      out += ch + breakTo(depth);
      i++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      depth--;
      out += breakTo(depth) + ch;
      i++;
      continue;
    }

    if (ch === ',') { out += ',' + breakTo(depth); i++; continue; }
    if (ch === ':') { out += ': '; i++; continue; }

    // Numbers, true, false, null: no whitespace can occur inside them, so
    // copying one character at a time is safe.
    out += ch;
    i++;
  }

  return out + '\n';
}

export type FormatOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string };

// JSON with comments is a different grammar; running it through JSON.parse
// would reject the file rather than format it, so it is not claimed here.
const JSON_SUFFIXES = ['.json', '.jsonl', '.geojson', '.webmanifest', '.json5'];

function looksLikeJson(filename: string, text: string): boolean {
  const lower = filename.toLowerCase();
  if (JSON_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  // An untitled buffer holding a pasted payload is the other common case.
  const head = text.trimStart()[0];
  return head === '{' || head === '[';
}

export function formatDocumentText(text: string, filename: string): FormatOutcome {
  if (!text.trim()) return { ok: false, message: 'Nothing to format' };
  if (!looksLikeJson(filename, text)) {
    return { ok: false, message: 'Format Document currently supports JSON only' };
  }
  try {
    return { ok: true, text: formatJson(text) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Invalid JSON — ${detail}` };
  }
}
