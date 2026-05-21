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

import { writable, type Writable } from 'svelte/store';

export type ResolverFailureReason =
  | 'userscript-not-detected'
  | 'resolve-null-or-timeout'
  | 'http-error'
  | 'network-error'
  | 'timeout'
  | 'non-asset-url'
  | 'blob-create-failed';

export type ResolverFailure = {
  url: string;
  reason: ResolverFailureReason;
  status?: number;
  at: number;
};

export type ResolverStats = {
  userscriptDetected: boolean;
  userscriptVersion: string | null;
  pending: number;
  resolved: number;
  failed: number;
  failures: ResolverFailure[];
};

// v0.6.3: writable store the UserscriptStatus.svelte component subscribes to.
// Mutated from: heartbeat handler (detection), processOne (pending+/resolved+/failed+),
// reprocessFallbackImages (clear stale failures on retry).
export const resolverStats: Writable<ResolverStats> = writable({
  userscriptDetected: false,
  userscriptVersion: null,
  pending: 0,
  resolved: 0,
  failed: 0,
  failures: [],
});

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
    // v0.6.4: replaced `event.source !== window` filter (broken in TM sandbox
    // — userscript's postMessage tags source as sandbox proxy, !== page window)
    // with origin-string compare. Same cross-origin guarantee.
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === HEARTBEAT_TYPE) {
      const wasInstalledBefore = isUserscriptInstalled();
      lastHeartbeatAt = Date.now();
      userscriptVersion = typeof data.version === 'string' ? data.version : 'unknown';
      // v0.6.4: log every heartbeat (not just first detection) so the channel
      // is observable from the page side. ~3 heartbeats per page load total:
      // userscript@load + DOMContentLoaded + PING-response — not noisy.
      console.log('[gh-asset] heartbeat from userscript v' + userscriptVersion);
      if (!wasInstalledBefore) {
        resolverStats.update((s) => ({
          ...s,
          userscriptDetected: true,
          userscriptVersion,
        }));
        // v0.6.2: if detection arrived AFTER first render, any imgs locked
        // into the fallback shell are stuck — walker won't re-evaluate
        // without a morphdom diff. On first detection, unwrap them and retry.
        reprocessFallbackImages();
      } else {
        // Quiet keep-alive — refresh version in store.
        resolverStats.update((s) =>
          s.userscriptVersion === userscriptVersion ? s : { ...s, userscriptVersion },
        );
      }
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

  console.log('[gh-asset] processing', originalUrl);

  if (!isUserscriptInstalled()) {
    console.warn('[gh-asset] userscript not detected → fallback', originalUrl);
    resolverStats.update((s) => ({
      ...s,
      failed: s.failed + 1,
      failures: [
        ...s.failures,
        { url: originalUrl, reason: 'userscript-not-detected', at: Date.now() },
      ],
    }));
    applyFallback(img, originalUrl);
    return;
  }

  img.setAttribute('src', SPINNER_DATA_URL);
  img.classList.add('gh-asset-pending');
  img.title = 'Resolving GitHub attachment via userscript...';

  console.log('[gh-asset] resolve→userscript', originalUrl);
  resolverStats.update((s) => ({ ...s, pending: s.pending + 1 }));

  resolveGitHubAsset(originalUrl).then((blobUrl) => {
    if (!img.isConnected) {
      resolverStats.update((s) => ({ ...s, pending: Math.max(0, s.pending - 1) }));
      return;
    }
    img.classList.remove('gh-asset-pending');
    if (blobUrl) {
      console.log('[gh-asset] resolved ✓', originalUrl);
      img.setAttribute('src', blobUrl);
      img.classList.add('gh-asset-resolved');
      img.title = '';
      resolverStats.update((s) => ({
        ...s,
        pending: Math.max(0, s.pending - 1),
        resolved: s.resolved + 1,
      }));
    } else {
      console.warn('[gh-asset] resolve failed/null → fallback', originalUrl);
      resolverStats.update((s) => ({
        ...s,
        pending: Math.max(0, s.pending - 1),
        failed: s.failed + 1,
        failures: [
          ...s.failures,
          { url: originalUrl, reason: 'resolve-null-or-timeout', at: Date.now() },
        ],
      }));
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
/**
 * Re-evaluate imgs currently wrapped in a fallback shell. Called when the
 * userscript heartbeat arrives AFTER the first render walker ran with no
 * userscript detected. Unwrap the img, clear PROCESSED_ATTR, hand back to
 * processOne which will now take the spinner/resolve path.
 *
 * Re-entry guard: heartbeat fires repeatedly; only the first one triggers
 * unwrap, subsequent heartbeats find no fallback shells (idempotent).
 */
let reprocessing = false;
function reprocessFallbackImages(): void {
  if (typeof document === 'undefined') return;
  if (reprocessing) return;
  reprocessing = true;
  try {
    const shells = document.querySelectorAll<HTMLElement>('.gh-asset-shell-fallback');
    if (shells.length === 0) return;
    console.log('[gh-asset] heartbeat-late: reprocessing', shells.length, 'fallback shells');
    // v0.6.3: clear stale failure entries for URLs we're about to retry.
    // processOne will re-count them on the new attempt.
    const retryUrls = new Set<string>();
    shells.forEach((shell) => {
      const u = shell.getAttribute(ORIGINAL_SRC_ATTR);
      if (u) retryUrls.add(u);
    });
    resolverStats.update((s) => {
      const survivingFailures = s.failures.filter((f) => !retryUrls.has(f.url));
      return {
        ...s,
        failed: survivingFailures.length,
        failures: survivingFailures,
      };
    });
    for (const shell of shells) {
      const img = shell.querySelector<HTMLImageElement>('img');
      const originalUrl = shell.getAttribute(ORIGINAL_SRC_ATTR);
      if (!img || !originalUrl) continue;
      // Move img back out to shell's parent at shell's position; drop shell.
      shell.parentNode?.insertBefore(img, shell);
      shell.remove();
      // Clear PROCESSED_ATTR so processOne can re-run from scratch.
      img.removeAttribute(PROCESSED_ATTR);
      processOne(img, originalUrl);
    }
  } finally {
    reprocessing = false;
  }
}

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
