// ==UserScript==
// @name         gh-md-editor GitHub Asset Proxy
// @namespace    https://luutuankiet.github.io/gh-md-editor/
// @version      0.6.1
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
  const VERSION = '0.6.1';

  try { unsafeWindow[PROXY_FLAG] = VERSION; } catch (_) {
    try { window[PROXY_FLAG] = VERSION; } catch (_) {}
  }

  function postHeartbeat() {
    window.postMessage({ type: HEARTBEAT_TYPE, version: VERSION }, '*');
  }
  postHeartbeat();
  document.addEventListener('DOMContentLoaded', postHeartbeat);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === PING_TYPE) { postHeartbeat(); return; }
    if (data.type !== REQUEST_TYPE) return;

    const { url, requestId } = data;
    if (typeof url !== 'string' || typeof requestId !== 'number') return;
    if (!/^https:\/\/github\.com\/user-attachments\/(assets|files)\//.test(url)) {
      window.postMessage({ type: RESPONSE_TYPE, requestId, ok: false, error: 'non-asset-url' }, '*');
      return;
    }

    GM.xmlHttpRequest({
      method: 'GET',
      url: url,
      responseType: 'blob',
      anonymous: false,
      timeout: 15000,
      onload: function (res) {
        if (res.status === 200 && res.response) {
          try {
            const blobUrl = URL.createObjectURL(res.response);
            window.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: true, url: blobUrl, size: res.response.size, mime: res.response.type }, '*');
          } catch (err) {
            window.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: false, error: 'blob-create-failed' }, '*');
          }
          return;
        }
        window.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: false, status: res.status, error: 'http-' + res.status }, '*');
      },
      onerror: function () {
        window.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: false, error: 'network-error' }, '*');
      },
      ontimeout: function () {
        window.postMessage({ type: RESPONSE_TYPE, requestId: requestId, ok: false, error: 'timeout' }, '*');
      },
    });
  });
})();
