// Control plane for the server's opt-in language servers (`/api/lsp`), shared
// by the bottom panel, the status bar item, the command palette and the
// editor client. The kinds come from the server's registry (GET /api/lsp
// `kinds`); the list below is only what shows before the first answer.

export type LspKind = string;

export interface LspKindSpec {
  kind: LspKind;
  label: string;
  // extension (no dot, lower case) -> LSP language id announced for it
  extensions: Record<string, string>;
  // exact base name -> language id
  filenames: Record<string, string>;
  // base-name glob with `*` -> language id
  globs: Record<string, string>;
  // Absent until the server answers. `install` is set for servers that are
  // never downloaded; `onPath` says whether their binary was found.
  install?: string | null;
  onPath?: boolean;
  hasDownload?: boolean;
  explicitOnly?: boolean;
  // Helpers the server runs from PATH, such as shellcheck for bash.
  tools?: { bin: string; gives: string; install: string; found: boolean }[];
}

/** How to install `k` when it cannot start from here, else null. */
export function missingInstall(k: LspKindSpec | undefined): string | null {
  return k && k.install && !k.hasDownload && k.onPath === false ? k.install : null;
}

const FALLBACK: LspKindSpec[] = [
  {
    kind: 'tsgo',
    label: 'TypeScript 7 (tsgo)',
    // TS 7 needs the *react ids to parse JSX.
    extensions: {
      ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
    },
    filenames: {},
    globs: {},
  },
  { kind: 'ty', label: 'Python (ty)', extensions: { py: 'python', pyi: 'python' }, filenames: {}, globs: {} },
  { kind: 'basedpyright', label: 'Python (basedpyright)', extensions: { py: 'python', pyi: 'python' }, filenames: {}, globs: {} },
  { kind: 'yaml', label: 'YAML (yaml-language-server)', extensions: { yml: 'yaml', yaml: 'yaml' }, filenames: {}, globs: {} },
  { kind: 'json', label: 'JSON (vscode-json-language-server)', extensions: { json: 'json', jsonc: 'jsonc' }, filenames: {}, globs: {} },
  {
    kind: 'dockerfile',
    label: 'Dockerfile (docker-langserver)',
    extensions: { dockerfile: 'dockerfile', containerfile: 'dockerfile' },
    filenames: { Dockerfile: 'dockerfile', Containerfile: 'dockerfile' },
    globs: { 'Dockerfile.*': 'dockerfile', 'Containerfile.*': 'dockerfile' },
  },
];

// Mutated in place so every reader (components and plain modules) sees updates.
export const LSP_KINDS: LspKindSpec[] = $state(FALLBACK);

/** Replaces the kinds with the server's registry; a malformed answer is ignored. */
export function setLspKinds(kinds: unknown) {
  if (!kinds || typeof kinds !== 'object') return;
  const next: LspKindSpec[] = [];
  type Wire = Partial<LspKindSpec> & { download?: unknown };
  for (const [kind, k] of Object.entries(kinds as Record<string, Wire>)) {
    if (!k || typeof k !== 'object') continue;
    next.push({
      kind,
      label: k.label ?? kind,
      extensions: k.extensions ?? {},
      filenames: k.filenames ?? {},
      globs: k.globs ?? {},
      install: k.install ?? null,
      onPath: k.onPath,
      hasDownload: !!k.download,
      explicitOnly: !!k.explicitOnly,
      tools: Array.isArray(k.tools) ? k.tools : [],
    });
  }
  if (!next.length) return;
  if (JSON.stringify(next) === JSON.stringify($state.snapshot(LSP_KINDS))) return;
  LSP_KINDS.splice(0, LSP_KINDS.length, ...next);
}

export function lspLabel(kind: string): string {
  return LSP_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

const globRe = (glob: string) =>
  new RegExp('^' + glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

/** The language id `spec` announces for `path`, or null; same order as the server. */
export function languageIdOf(spec: LspKindSpec, path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (Object.hasOwn(spec.filenames, base)) return spec.filenames[base];
  const dot = base.lastIndexOf('.');
  if (dot >= 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (Object.hasOwn(spec.extensions, ext)) return spec.extensions[ext];
  }
  for (const [glob, id] of Object.entries(spec.globs)) if (globRe(glob).test(base)) return id;
  return null;
}

/** Every kind that can serve `path`, with the language id the first one announces. */
export function lspLanguageFor(path: string): { kinds: LspKind[]; id: string } | null {
  let id: string | null = null;
  const kinds: LspKind[] = [];
  for (const k of LSP_KINDS) {
    const l = languageIdOf(k, path);
    if (!l) continue;
    id ??= l;
    kinds.push(k.kind);
  }
  return id ? { kinds, id } : null;
}

// The browser's `?folder=` value: the workspace the server remembers
// per-workspace choices (autostart, settings) under.
export function currentWorkspace(): string {
  return new URLSearchParams(location.search).get('folder') ?? '';
}

const changed = () => window.dispatchEvent(new CustomEvent('gmd:lsp-changed'));

// Starts one server for `folder` (relative to the served root, '' = root) and
// remembers it for this workspace, so it starts again when a matching file
// opens. When nothing is installed locally the server answers 409 with the
// npx/uvx line it would run; that only happens after the user agrees to it.
// Resolves to an error message, or null on success or on a declined download.
export async function startLanguageServer(kind: LspKind, folder: string): Promise<string | null> {
  const workspace = currentWorkspace();
  const post = (allowDownload: boolean) =>
    fetch('/api/lsp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, folder, allowDownload, workspace }),
    });
  try {
    let r = await post(false);
    if (r.status === 409) {
      const d = await r.json().catch(() => ({}));
      const ok = confirm(`No local ${kind} found for ${folder || 'the served root'}.\n\nDownload and run it with:\n${d.command ?? '(unknown command)'}`);
      if (!ok) return null;
      r = await post(true);
    }
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return d.error ?? `start failed: HTTP ${r.status}`;
    }
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  } finally {
    changed();
  }
}

async function call(url: string, init: RequestInit, what: string): Promise<string | null> {
  try {
    const r = await fetch(url, init);
    if (!r.ok && r.status !== 404) {
      const d = await r.json().catch(() => ({}));
      return d.error ?? `${what} failed: HTTP ${r.status}`;
    }
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  } finally {
    changed();
  }
}

// `forget` also drops it from this workspace's remembered servers, so it does
// not start again on its own.
export function stopLanguageServer(id: string, forget: boolean): Promise<string | null> {
  return call(`/api/lsp?id=${encodeURIComponent(id)}${forget ? '&forget=1' : ''}`, { method: 'DELETE' }, 'stop');
}

export function restartLanguageServer(id: string): Promise<string | null> {
  return call('/api/lsp/restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }, 'restart');
}

/** The server's stderr and window/logMessage lines, as plain text. */
export async function fetchLspLog(id: string): Promise<string> {
  try {
    const r = await fetch(`/api/lsp/log?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    return r.ok ? await r.text() : `log unavailable: HTTP ${r.status}`;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

// Asks the server to start whatever this workspace remembered for `path`.
// Once per path per page load; true when something started.
const autostartTried = new Set<string>();
export async function autostartFor(path: string): Promise<boolean> {
  if (autostartTried.has(path)) return false;
  autostartTried.add(path);
  try {
    const r = await fetch('/api/lsp/autostart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: currentWorkspace(), path }),
    });
    if (!r.ok) return false;
    const d = (await r.json().catch(() => ({}))) as { started?: unknown[] };
    if (!d.started?.length) return false;
    changed();
    return true;
  } catch {
    return false;
  }
}

export interface LspOffer {
  kind: LspKind;
  label: string;
  // where to start it, relative to the served root
  folder: string;
  available: boolean;
  install: string | null;
}

/** The servers the server suggests for `path` (none running is assumed). */
export async function fetchLspOffers(path: string): Promise<LspOffer[]> {
  try {
    const r = await fetch(`/api/lsp/offer?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (!r.ok) return [];
    return ((await r.json()) as { offers?: LspOffer[] }).offers ?? [];
  } catch {
    return [];
  }
}
