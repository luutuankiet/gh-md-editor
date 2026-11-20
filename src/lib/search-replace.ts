// Client-side twin of the replacement rules in server/index.mjs (apiReplace),
// used only to preview what a replace will write. The server never trusts
// this copy; it recomputes every replacement against the file on disk. Keep
// the two in step when either changes.

export interface ReplaceOpts {
  matchCase: boolean;
  word: boolean;
  regex: boolean;
  preserveCase: boolean;
}

export function replaceRegex(q: string, o: Pick<ReplaceOpts, 'matchCase' | 'word' | 'regex'>): RegExp | null {
  let src = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.word) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, o.matchCase ? 'g' : 'gi');
  } catch {
    return null;
  }
}

export function expandReplacement(repl: string, m: RegExpExecArray, regex: boolean): string {
  if (!regex) return repl;
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i];
    const n = repl[i + 1];
    if (c === '\\' && n !== undefined) {
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '\\' ? '\\' : c + n;
      i++;
    } else if (c === '$' && n === '$') { out += '$'; i++; }
    else if (c === '$' && n === '&') { out += m[0]; i++; }
    else if (c === '$' && n === '<') {
      const close = repl.indexOf('>', i);
      const name = close === -1 ? null : repl.slice(i + 2, close);
      if (name && m.groups && name in m.groups) { out += m.groups[name] ?? ''; i = close; }
      else out += c;
    } else if (c === '$' && /[0-9]/.test(n ?? '')) {
      let k = n;
      if (/[0-9]/.test(repl[i + 2] ?? '') && Number(n + repl[i + 2]) < m.length) k = n + repl[i + 2];
      if (Number(k) > 0 && Number(k) < m.length) { out += m[Number(k)] ?? ''; i += k.length; }
      else out += c;
    } else out += c;
  }
  return out;
}

export function preserveCase(matched: string, repl: string): string {
  if (!/[a-z]/i.test(matched)) return repl;
  if (matched === matched.toUpperCase()) return repl.toUpperCase();
  if (matched === matched.toLowerCase()) return repl.toLowerCase();
  if (matched[0] === matched[0].toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) {
    return repl.charAt(0).toUpperCase() + repl.slice(1).toLowerCase();
  }
  return repl;
}

// The text a replace would put at [s, e) of this line, or null when the JS
// pattern does not land on that exact span (the server would skip it too).
export function replacementAt(line: string, s: number, e: number, re: RegExp, repl: string, o: ReplaceOpts): string | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index === s && m.index + m[0].length === e) {
      const r = expandReplacement(repl, m, o.regex);
      return o.preserveCase ? preserveCase(m[0], r) : r;
    }
    if (m.index > s) break;
    if (m[0].length === 0) re.lastIndex++;
  }
  return null;
}
