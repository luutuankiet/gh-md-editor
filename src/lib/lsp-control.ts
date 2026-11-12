// Control plane for the server's opt-in language servers (`/api/lsp`), shared
// by the bottom panel and the command palette.

export type LspKind = 'tsgo' | 'ty' | 'basedpyright';

export const LSP_KINDS: { kind: LspKind; label: string }[] = [
  { kind: 'tsgo', label: 'TypeScript 7 (tsgo)' },
  { kind: 'ty', label: 'Python (ty)' },
  { kind: 'basedpyright', label: 'Python (basedpyright)' },
];

// Starts one server for `folder` (relative to the served root, '' = root).
// When nothing is installed locally the server answers 409 with the npx/uvx
// line it would run; that only happens after the user agrees to it.
// Resolves to an error message, or null on success or on a declined download.
export async function startLanguageServer(kind: LspKind, folder: string): Promise<string | null> {
  const post = (allowDownload: boolean) =>
    fetch('/api/lsp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, folder, allowDownload }),
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
    window.dispatchEvent(new CustomEvent('gmd:lsp-changed'));
  }
}
