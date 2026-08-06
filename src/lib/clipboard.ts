// navigator.clipboard exists only in secure contexts (https / localhost).
// Permissive LAN binds are plain http, so fall back to the hidden-textarea
// execCommand path there.
export async function toClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { return await navigator.clipboard.writeText(text); } catch { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
