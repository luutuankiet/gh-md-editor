// Every diagnostic every running language server has published, per file, in
// full LSP shape (code, codeDescription, source, relatedInformation, data are
// all kept). Fed by `textDocument/publishDiagnostics` in client.ts, so it also
// covers files the server reports on that no tab has open. The explorer, the
// status bar and the Problems panel read the reactive summary; editors listen
// with `onDiagnostics`.

export interface LspRange { start: { line: number; character: number }; end: { line: number; character: number } }

export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  tags?: number[];
  relatedInformation?: { location: { uri: string; range: LspRange }; message: string }[];
  data?: unknown;
}

export interface FileProblems {
  errors: number;
  warnings: number;
  infos: number;
  // Each item remembers the server that reported it: quick fixes go back to it.
  items: { serverId: string; d: LspDiagnostic }[];
}

// serverId -> path -> diagnostics. Plain, not reactive: rebuilt into `problems`.
const raw = new Map<string, Map<string, LspDiagnostic[]>>();

export const problems = $state<{ byPath: Record<string, FileProblems> }>({ byPath: {} });

const listeners = new Set<(path: string) => void>();

/** Called with the path whose diagnostics changed. Returns an unsubscribe. */
export function onDiagnostics(fn: (path: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function rebuild(path: string) {
  const items: FileProblems['items'] = [];
  for (const [serverId, m] of raw) for (const d of m.get(path) ?? []) items.push({ serverId, d });
  if (!items.length) {
    delete problems.byPath[path];
  } else {
    items.sort((a, b) => (a.d.severity ?? 1) - (b.d.severity ?? 1) || a.d.range.start.line - b.d.range.start.line);
    let errors = 0, warnings = 0, infos = 0;
    for (const { d } of items) {
      const s = d.severity ?? 1;
      if (s === 1) errors++; else if (s === 2) warnings++; else infos++;
    }
    problems.byPath[path] = { errors, warnings, infos, items };
  }
  for (const fn of listeners) fn(path);
}

export function publish(serverId: string, path: string, diags: LspDiagnostic[]) {
  let m = raw.get(serverId);
  if (!m) raw.set(serverId, (m = new Map()));
  if (diags.length) m.set(path, diags); else m.delete(path);
  rebuild(path);
}

/** A server went away: everything it reported goes with it. */
export function dropServer(serverId: string) {
  const m = raw.get(serverId);
  if (!m) return;
  raw.delete(serverId);
  for (const path of m.keys()) rebuild(path);
}

export function diagnosticsFor(path: string, serverId?: string): LspDiagnostic[] {
  if (serverId) return raw.get(serverId)?.get(path) ?? [];
  return (problems.byPath[path]?.items ?? []).map((i) => i.d);
}

/** Worst severity under a folder ('' is the root), for the explorer's dots. */
export function folderSeverity(byPath: Record<string, FileProblems>, folder: string): 1 | 2 | 0 {
  const pre = folder ? folder.replace(/\/+$/, '') + '/' : '';
  let worst: 1 | 2 | 0 = 0;
  for (const [p, f] of Object.entries(byPath)) {
    if (!p.startsWith(pre)) continue;
    if (f.errors) return 1;
    if (f.warnings) worst = 2;
  }
  return worst;
}

export const totals = () => {
  let errors = 0, warnings = 0, infos = 0;
  for (const f of Object.values(problems.byPath)) { errors += f.errors; warnings += f.warnings; infos += f.infos; }
  return { errors, warnings, infos };
};
