// ==UserScript==
// @name         gh-md-editor GitHub Asset Proxy
// @namespace    https://luutuankiet.github.io/gh-md-editor/
// @version      0.6.4
// @description  Resolve private/org github.com/user-attachments image URLs cookie-authenticated and bridge them back to the gh-md-editor preview pane.
// @match        https://luutuankiet.github.io/gh-md-editor/*
// @match        http://127.0.0.1:5173/gh-md-editor/*
// @match        http://localhost:5173/gh-md-editor/*
// @connect      github.com
// @connect      *.githubusercontent.com
// @connect      *.amazonaws.com
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  const PROXY_FLAG = '__ghMdAssetProxy';
  const REQUEST_TYPE = 'gh-md-asset-resolve-request';
  const RESPONSE_TYPE = 'gh-md-asset-resolve-response';
  const HEARTBEAT_TYPE = 'gh-md-asset-resolver-alive';
  const PING_TYPE = 'gh-md-asset-resolver-ping';
  const VERSION = '0.6.4';
  const LOG_PREFIX = '[gh-md-us]';

  // v0.6.4: in Tampermonkey's default sandbox mode, the userscript's `window`
  // is a Proxy wrapping `unsafeWindow` (the page's real window). Using
  // `window.postMessage` from inside the sandbox tags `event.source` with the
  // proxy, NOT the page window — which trips page-side `event.source === window`
  // filters. Same failure mode in reverse: `window.addEventListener` registered
  // on the proxy may not catch page-window messages, or catches them with
  // `event.source` pointing at unsafeWindow which `!== window` (proxy). Route
  // ALL message I/O through `unsafeWindow` consistently. Fallback to `window`
  // for strict Greasemonkey 4+ where unsafeWindow isn't exposed.
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  try { W[PROXY_FLAG] = VERSION; } catch (_) {
    try { window[PROXY_FLAG] = VERSION; } catch (_) {}
  }

  console.log(LOG_PREFIX, 'userscript loaded v' + VERSION, 'at', location.href);

  function postHeartbeat() {
    W.postMessage({ type: HEARTBEAT_TYPE, version: VERSION }, '*');
    console.log(LOG_PREFIX, 'heartbeat sent');
  }
  postHeartbeat();
  document.addEventListener('DOMContentLoaded', postHeartbeat);

  W.addEventListener('message', (event) => {
    // v0.6.4: replaced `event.source !== window` (broken in TM sandbox — proxy
    // identity issue) with origin-string compare. Same cross-origin guarantee,
    // immune to window-reference shenanigans.
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === PING_TYPE) {
      console.log(LOG_PREFIX, 'ping received → reply heartbeat');
      postHeartbeat();
      return;
    }
    if (data.type !== REQUEST_TYPE) return;

    const { url, requestId } = data;
    if (typeof url !== 'string' || typeof requestId !== 'number') return;

    console.log(LOG_PREFIX, 'request', requestId, url);

    if (!/^https:\/\/github\.com\/user-attachments\/(assets|files)\//.test(url)) {
      console.warn(LOG_PREFIX, 'reject non-asset-url', url);
      W.postMessage({ type: RESPONSE_TYPE, requestId, ok: false, error: 'non-asset-url' }, '*');
      return;
    }

    const t0 = Date.now();
    GM.xmlHttpRequest({
      method: 'GET',
      url: url,
      responseType: 'blob',
      anonymous: false,
      timeout: 15000,
      onload: function (res) {
        const dt = Date.now() - t0;
        const finalUrl = res.finalUrl || res.responseURL || '<no-finalUrl>';
        if (res.status === 200 && res.response) {
          try {
            const blobUrl = URL.createObjectURL(res.response);
            console.log(LOG_PREFIX, 'response 200', dt + 'ms', 'size=' + res.response.size, 'mime=' + (res.response.type || '?'), 'finalUrl=' + finalUrl, 'for', url);
            W.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: true, url: blobUrl, size: res.response.size, mime: res.response.type }, '*');
          } catch (err) {
            console.error(LOG_PREFIX, 'blob-create failed', err && err.message, 'for', url);
            W.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: false, error: 'blob-create-failed' }, '*');
          }
          return;
        }
        console.error(LOG_PREFIX, 'non-200', res.status, res.statusText || '', dt + 'ms', 'finalUrl=' + finalUrl, 'for', url);
        W.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: false, status: res.status, error: 'http-' + res.status }, '*');
      },
      onerror: function (res) {
        const dt = Date.now() - t0;
        const finalUrl = (res && (res.finalUrl || res.responseURL)) || '<no-finalUrl>';
        console.error(LOG_PREFIX, 'network-error', dt + 'ms', 'status=' + (res && res.status), 'finalUrl=' + finalUrl, 'for', url);
        W.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: false, error: 'network-error' }, '*');
      },
      ontimeout: function () {
        const dt = Date.now() - t0;
        console.error(LOG_PREFIX, 'timeout', dt + 'ms', 'for', url);
        W.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: false, error: 'timeout' }, '*');
      },
    });
  });
})();
