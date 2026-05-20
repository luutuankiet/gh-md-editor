<script lang="ts">
  let { open = $bindable(false) }: { open?: boolean } = $props();

  let dialog: HTMLDialogElement;

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  function handleClose() {
    open = false;
  }

  interface Shortcut { pane: string; keys: string; description: string }
  const shortcuts: Shortcut[] = [
    { pane: 'Editor', keys: 'Right-click', description: 'Flash matching block in preview (auto-expands collapsed <details>, lands on the matching table row not the whole table)' },
    { pane: 'Editor', keys: 'Cmd/Ctrl + F', description: 'Find / replace (CodeMirror panel, top-right). Scrollbar shows match ticks; word at cursor lights up implicitly in a fainter shade.' },
    { pane: 'Editor', keys: 'Alt / Opt + Z', description: 'Toggle word wrap (persisted). Mac Opt+Z handled at the DOM event level so Firefox does not paste Ω.' },
    { pane: 'Editor', keys: 'Cmd/Ctrl + Shift + →', description: 'Expand selection: token → expression → fence → ENCLOSING MARKDOWN SECTION → document.' },
    { pane: 'Editor', keys: '` * _ ~ ( [ { " \'', description: 'Wrap selection with the pair (markdown auto-pair)' },
    { pane: 'Editor', keys: 'Tab / Shift+Tab', description: 'Indent / outdent' },
    { pane: 'Preview', keys: 'Cmd/Ctrl + F', description: 'Find in preview (overlay top-right). Scrollbar match ticks; Enter / Shift+Enter to step through; Esc to close.' },
    { pane: 'Preview', keys: 'Left-click on a word', description: 'Implicit highlight — all matching occurrences light up faintly (different shade than explicit search), with scrollbar ticks.' },
    { pane: 'Preview', keys: 'Right-click', description: 'Jump editor caret to the clicked block' },
    { pane: 'Outline', keys: 'Click row', description: 'Jump both panes; toggle fold if the row has children' },
    { pane: 'Outline', keys: '−', description: 'Fold all (while outline pane is focused)' },
    { pane: 'Outline', keys: '+ / =', description: 'Unfold all (while outline pane is focused)' },
    { pane: 'URL', keys: '?reset=1', description: 'Append to URL and reload to restore the v0.5.0 sample doc (wipes the current localStorage draft).' },
  ];
</script>

<dialog
  bind:this={dialog}
  class="shortcuts-dialog"
  onclose={handleClose}
  onclick={(e) => {
    if (e.target === dialog) handleClose();
  }}
>
  <div class="dialog-body">
    <header>
      <h2>Keyboard shortcuts</h2>
      <button type="button" onclick={handleClose} aria-label="Close">×</button>
    </header>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pane</th>
            <th>Keys</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {#each shortcuts as s}
            <tr>
              <td class="pane-col">{s.pane}</td>
              <td><kbd>{s.keys}</kbd></td>
              <td>{s.description}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <footer>
      <span>Press <kbd>Esc</kbd> or click outside to close.</span>
    </footer>
  </div>
</dialog>

<style>
  .shortcuts-dialog {
    border: 1px solid #d0d7de;
    border-radius: 10px;
    padding: 0;
    min-width: 560px;
    max-width: 92vw;
    max-height: 86vh;
    background: #ffffff;
    color: #1f2328;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }
  .shortcuts-dialog::backdrop {
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(2px);
  }
  .dialog-body {
    display: flex;
    flex-direction: column;
    max-height: 86vh;
    overflow: hidden;
  }
  .shortcuts-dialog header {
    display: flex;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid #d0d7de;
  }
  .shortcuts-dialog h2 {
    flex: 1;
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }
  .shortcuts-dialog header button {
    width: 26px;
    height: 26px;
    border: none;
    background: transparent;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    border-radius: 4px;
    color: inherit;
  }
  .shortcuts-dialog header button:hover { background: #eaeef2; }
  .table-wrap {
    overflow-y: auto;
    flex: 1;
  }
  .shortcuts-dialog table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .shortcuts-dialog thead {
    background: #f6f8fa;
    position: sticky;
    top: 0;
  }
  .shortcuts-dialog th,
  .shortcuts-dialog td {
    text-align: left;
    padding: 7px 16px;
    border-bottom: 1px solid #eaeef2;
    vertical-align: top;
  }
  .shortcuts-dialog th {
    font-weight: 600;
    color: #57606a;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .shortcuts-dialog .pane-col {
    font-weight: 600;
    color: #57606a;
    white-space: nowrap;
    width: 80px;
  }
  .shortcuts-dialog kbd {
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    padding: 2px 6px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    line-height: 1.5;
    color: #1f2328;
    white-space: nowrap;
  }
  .shortcuts-dialog footer {
    padding: 8px 16px;
    border-top: 1px solid #eaeef2;
    font-size: 11px;
    color: #6e7681;
    background: #fafbfc;
  }
  @media (prefers-color-scheme: dark) {
    .shortcuts-dialog {
      background: #161b22;
      color: #c9d1d9;
      border-color: #30363d;
    }
    .shortcuts-dialog header { border-bottom-color: #30363d; }
    .shortcuts-dialog header button:hover { background: #30363d; }
    .shortcuts-dialog thead { background: #21262d; }
    .shortcuts-dialog th { color: #8b949e; }
    .shortcuts-dialog th,
    .shortcuts-dialog td { border-bottom-color: #30363d; }
    .shortcuts-dialog .pane-col { color: #8b949e; }
    .shortcuts-dialog kbd {
      background: #21262d;
      border-color: #30363d;
      color: #c9d1d9;
    }
    .shortcuts-dialog footer {
      background: #1c2128;
      border-top-color: #30363d;
      color: #8b949e;
    }
  }
</style>
