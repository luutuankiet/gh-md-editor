/**
 * Page-side bridge to a Tampermonkey userscript that resolves private GitHub
 * user-attachments URLs into blob: URLs the page can render in <img src>.
 *
 * github.com/user-attachments/* requires a session cookie. From a static-site
 * origin the browser won't send github.com cookies cross-origin. A userscript
 * with GM.xmlHttpRequest + @connect github.com has the privilege; this module
 * brokers requests/responses via window.postMessage. Without the userscript,
 * resolveGitHubAsset() returns null and the caller renders a fallback link.
 */

const REQUEST_TYPE = 'gh-md-asset-resolve-request';
const RESPONSE_TYPE = 'gh-md-asset-resolve-response';
const HEARTBEAT_TYPE = 'gh-md-asset-resolver-alive';
const PING_TYPE = 'gh-md-asset-resolver-ping';
const PROXY_FLAG = '__ghMdAssetProxy';

const RESOLVE_TIMEOUT_MS = 15_000;
const PROCESSED_ATTR = 'data-gh-asset-processed';
const ORIGINAL_SRC_ATTR = 'data-gh-original-src';

const SPINNER_DATA_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="14" fill="none" stroke="#0969da" stroke-width="3" stroke-dasharray="20 60" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="1s" repeatCount="indefinite"/></circle></svg>',
  );

export const GH_ASSET_URL_PATTERN = /^https:\/\/github\.com\/user-attachments\/(assets|files)\/[a-zA-Z0-9-]+/i;

export function isGitHubAssetUrl(url: string | null | undefined): boolean {
  return !!url && GH_ASSET_URL_PATTERN.test(url);
}

let requestCounter = 0;
const pending = new Map<number, { resolve: (url: string | null) => void; timeoutId: number }>();
let lastHeartbeatAt = 0;
let userscriptVersion: string | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === HEARTBEAT_TYPE) {
      lastHeartbeatAt = Date.now();
      userscriptVersion = typeof data.version === 'string' ? data.version : 'unknown';
      return;
    }

    if (data.type === RESPONSE_TYPE && typeof data.requestId === 'number') {
      const entry = pending.get(data.requestId);
      if (!entry) return;
      clearTimeout(entry.timeoutId);
      pending.delete(data.requestId);
      entry.resolve(data.ok && typeof data.url === 'string' ? data.url : null);
    }
  });
  // Ping in case userscript loaded before this module ran.
  window.postMessage({ type: PING_TYPE }, '*');
}

export function isUserscriptInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as any)[PROXY_FLAG]) return true;
  return lastHeartbeatAt > 0 && Date.now() - lastHeartbeatAt < 60_000;
}

export function getUserscriptVersion(): string | null {
  return userscriptVersion;
}

export function resolveGitHubAsset(url: string, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!isUserscriptInstalled()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const requestId = ++requestCounter;
    const timeoutId = window.setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);
    pending.set(requestId, { resolve, timeoutId });
    window.postMessage({ type: REQUEST_TYPE, requestId, url }, '*');
  });
}

/**
 * Idempotent post-render DOM walker. Call after each morphdom diff.
 * Finds <img src="https://github.com/user-attachments/..."> tags, then:
 *   - userscript installed: spinner → resolve → blob URL swap
 *   - userscript NOT installed: wrap in a shell with a sibling fallback link.
 *     The original <img> stays in the DOM (hidden via CSS) so copied/exported
 *     preview HTML preserves the canonical markup.
 * Already-processed nodes are skipped (data-gh-asset-processed attr).
 */
export function processGitHubAssets(root: HTMLElement): void {
  if (!root) return;
  const imgs = root.querySelectorAll<HTMLImageElement>('img:not([' + PROCESSED_ATTR + '])');
  for (const img of imgs) {
    const src = img.getAttribute('src');
    if (!src || !isGitHubAssetUrl(src)) {
      img.setAttribute(PROCESSED_ATTR, 'skip');
      continue;
    }
    processOne(img, src);
  }
}

function processOne(img: HTMLImageElement, originalUrl: string): void {
  img.setAttribute(PROCESSED_ATTR, 'true');
  img.setAttribute(ORIGINAL_SRC_ATTR, originalUrl);

  if (!isUserscriptInstalled()) {
    applyFallback(img, originalUrl);
    return;
  }

  img.setAttribute('src', SPINNER_DATA_URL);
  img.classList.add('gh-asset-pending');
  img.title = 'Resolving GitHub attachment via userscript...';

  resolveGitHubAsset(originalUrl).then((blobUrl) => {
    if (!img.isConnected) return;
    img.classList.remove('gh-asset-pending');
    if (blobUrl) {
      img.setAttribute('src', blobUrl);
      img.classList.add('gh-asset-resolved');
      img.title = '';
    } else {
      applyFallback(img, originalUrl);
    }
  });
}

/**
 * Non-destructive fallback (v0.6.1). Wraps the <img> in
 * <span class="gh-asset-shell gh-asset-shell-fallback"> and appends a sibling
 * <a class="gh-asset-fallback"> link. The wrapper's CSS hides the <img>
 * visually but keeps it in the DOM tree, so:
 *   - copy/export of preview HTML preserves the canonical <img src="..."> markup
 *   - image attrs (width/height/alt) stay attached to the original element
 *   - a future re-render path can recover and resolve once the userscript installs
 *
 * Idempotent: if the img is already inside a gh-asset-shell, do nothing.
 */
function applyFallback(img: HTMLImageElement, originalUrl: string): void {
  const existingShell = img.parentElement;
  if (existingShell?.classList.contains('gh-asset-shell')) return;

  const shell = document.createElement('span');
  shell.className = 'gh-asset-shell gh-asset-shell-fallback';
  shell.setAttribute(PROCESSED_ATTR, 'fallback');
  shell.setAttribute(ORIGINAL_SRC_ATTR, originalUrl);

  const link = document.createElement('a');
  link.href = originalUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'gh-asset-fallback';
  link.textContent = 'View attachment on GitHub →';
  link.title = originalUrl;

  // Insert shell at the img's position, move img into shell, append the link.
  img.parentNode?.insertBefore(shell, img);
  shell.appendChild(img);
  shell.appendChild(link);
}
