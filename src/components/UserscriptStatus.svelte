<script lang="ts">
  /**
   * v0.6.3 — visible status pill for the Tampermonkey userscript bridge.
   * Bottom-right of the editor, color-coded, click to expand failures.
   * Subscribes to the `resolverStats` writable store exported from
   * gh-asset-resolver.ts; no props.
   */
  import { resolverStats, type ResolverStats } from '../lib/gh-asset-resolver';

  let expanded = $state(false);

  type View = { color: 'gray' | 'green' | 'yellow' | 'red'; label: string };

  function classify(s: ResolverStats): View {
    if (!s.userscriptDetected) {
      return { color: 'gray', label: 'userscript not detected' };
    }
    if (s.pending > 0) {
      return { color: 'yellow', label: `resolving ${s.pending}…` };
    }
    if (s.failed > 0) {
      return {
        color: 'red',
        label: `userscript v${s.userscriptVersion ?? '?'} · ${s.resolved} ok · ${s.failed} failed`,
      };
    }
    if (s.resolved > 0) {
      return {
        color: 'green',
        label: `userscript v${s.userscriptVersion ?? '?'} · ${s.resolved} resolved`,
      };
    }
    return {
      color: 'green',
      label: `userscript v${s.userscriptVersion ?? '?'} · idle`,
    };
  }

  let view = $derived<View>(classify($resolverStats));
  let failuresPreview = $derived(
    $resolverStats.failures.slice(-10).reverse(),
  );

  function shortUrl(url: string): string {
    const m = /\/(assets|files)\/([^/?#]+)/.exec(url);
    if (m) return `.../${m[1]}/${m[2].slice(0, 12)}…`;
    return url.length > 60 ? url.slice(0, 60) + '…' : url;
  }

  function toggle() {
    expanded = !expanded;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  }
</script>

<div
  class="status-pill {view.color}"
  class:expanded
  role="button"
  tabindex="0"
  aria-expanded={expanded}
  aria-label={view.label}
  title={view.label}
  onclick={toggle}
  onkeydown={onKeydown}
>
  <span class="dot"></span>
  <span class="label">{view.label}</span>
  {#if expanded}
    <div class="detail" onclick={(e) => e.stopPropagation()} role="presentation">
      <div class="detail-grid">
        <span>detected</span>
        <code>{$resolverStats.userscriptDetected ? 'yes' : 'no'}</code>
        <span>version</span>
        <code>{$resolverStats.userscriptVersion ?? '—'}</code>
        <span>pending</span>
        <code>{$resolverStats.pending}</code>
        <span>resolved</span>
        <code>{$resolverStats.resolved}</code>
        <span>failed</span>
        <code>{$resolverStats.failed}</code>
      </div>
      {#if failuresPreview.length > 0}
        <div class="failures-title">
          Last {failuresPreview.length} failure{failuresPreview.length === 1 ? '' : 's'}
        </div>
        <ul class="failures-list">
          {#each failuresPreview as f (f.at + f.url)}
            <li class="failure-row">
              <code class="reason"
                >{f.reason}{f.status !== undefined ? ` (${f.status})` : ''}</code
              >
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                title={f.url}
              >
                {shortUrl(f.url)}
              </a>
            </li>
          {/each}
        </ul>
      {:else if $resolverStats.userscriptDetected && $resolverStats.resolved === 0}
        <div class="hint">
          No GitHub user-attachment images on this page yet.
        </div>
      {:else if !$resolverStats.userscriptDetected}
        <div class="hint">
          Install the Tampermonkey userscript via
          <a href="./userscript-installer.html">userscript-installer</a> to
          resolve private GitHub attachments.
        </div>
      {/if}
      <div class="hint hint-muted">Filter console for <code>gh-md-us</code> or <code>gh-asset</code> for the full trail.</div>
    </div>
  {/if}
</div>

<style>
  .status-pill {
    position: fixed;
    bottom: 12px;
    right: 12px;
    z-index: 9999;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.2;
    background: rgba(246, 248, 250, 0.95);
    border: 1px solid rgba(208, 215, 222, 0.8);
    color: #1f2328;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    max-width: 360px;
    user-select: none;
  }
  .status-pill:hover { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16); }
  .status-pill:focus-visible { outline: 2px solid #0969da; outline-offset: 2px; }
  .status-pill.expanded {
    flex-direction: column;
    align-items: stretch;
    border-radius: 10px;
    max-width: 480px;
    cursor: default;
    padding: 10px 12px;
  }
  .status-pill.expanded > .dot,
  .status-pill.expanded > .label {
    display: inline-flex;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
  }
  .gray .dot { background: #6e7681; }
  .green .dot { background: #1a7f37; }
  .yellow .dot { background: #bf8700; animation: pulse 1.2s ease-in-out infinite; }
  .red .dot { background: #cf222e; }
  .green { color: #1a7f37; border-color: rgba(26, 127, 55, 0.4); }
  .yellow { color: #9a6700; border-color: rgba(191, 135, 0, 0.4); }
  .red { color: #cf222e; border-color: rgba(207, 34, 46, 0.4); }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .expanded .label {
    white-space: normal;
    word-break: break-word;
  }
  .detail {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(208, 215, 222, 0.6);
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: #1f2328;
    cursor: default;
  }
  .detail-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 12px;
    row-gap: 4px;
    font-size: 11px;
  }
  .detail-grid > span { color: #57606a; }
  .detail-grid > code {
    color: #1f2328;
    background: rgba(175, 184, 193, 0.18);
    padding: 0 4px;
    border-radius: 3px;
    font-size: 11px;
  }
  .failures-title {
    font-weight: 600;
    color: #1f2328;
    font-size: 11px;
  }
  .failures-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 240px;
    overflow-y: auto;
  }
  .failure-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
  }
  .reason {
    color: #cf222e;
    font-weight: 600;
    background: rgba(207, 34, 46, 0.08);
    padding: 0 4px;
    border-radius: 3px;
    align-self: flex-start;
  }
  .failure-row a {
    color: #0969da;
    text-decoration: none;
    word-break: break-all;
  }
  .failure-row a:hover { text-decoration: underline; }
  .hint {
    font-size: 11px;
    color: #57606a;
  }
  .hint a { color: #0969da; }
  .hint-muted { color: #8b949e; font-size: 10px; }
  .hint code {
    background: rgba(175, 184, 193, 0.18);
    padding: 0 3px;
    border-radius: 3px;
  }
  @media (prefers-color-scheme: dark) {
    .status-pill {
      background: rgba(13, 17, 23, 0.95);
      border-color: rgba(48, 54, 61, 0.8);
      color: #c9d1d9;
    }
    .green { color: #3fb950; border-color: rgba(63, 185, 80, 0.4); }
    .yellow { color: #d29922; border-color: rgba(210, 153, 34, 0.4); }
    .red { color: #ff7b72; border-color: rgba(255, 123, 114, 0.4); }
    .detail { color: #c9d1d9; border-top-color: rgba(48, 54, 61, 0.6); }
    .detail-grid > span { color: #8b949e; }
    .detail-grid > code {
      color: #c9d1d9;
      background: rgba(110, 118, 129, 0.2);
    }
    .failures-title { color: #c9d1d9; }
    .reason {
      color: #ff7b72;
      background: rgba(255, 123, 114, 0.12);
    }
    .failure-row a { color: #79c0ff; }
    .hint { color: #8b949e; }
    .hint a { color: #79c0ff; }
    .hint code { background: rgba(110, 118, 129, 0.2); }
  }
</style>
