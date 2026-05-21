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

  interface Shortcut { pane: string; keys: string; description: string; highlight?: boolean }
  const shortcuts: Shortcut[] = [
    { pane: 'Editor', keys: 'Right-click', description: 'NOVEL FEATURE — flash matching block in preview (auto-expands collapsed <details>, lands on the matching table row not the whole table). Pairs with right-click in the preview going the other way: never lose your place when switching panes.' },
    { pane: 'Editor', keys: 'Cmd/Ctrl + F', description: 'Find / replace (CodeMirror panel, top-right). Scrollbar shows match ticks; word at cursor lights up implicitly in a fainter shade.' },
    { pane: 'Editor', keys: 'Alt / Opt + Z', description: 'Toggle word wrap (persisted). Mac Opt+Z handled at the DOM event level so Firefox does not paste Ω.', highlight: true },
    { pane: 'Editor', keys: 'Cmd/Ctrl + D', description: 'Multi-cursor — spawn a caret at the next matching occurrence of the word or selection. Press repeatedly to keep adding cursors.', highlight: true },
    { pane: 'Editor', keys: 'Alt / Opt + Left-click', description: 'Multi-cursor — drop an additional caret at the click point. Combine with Cmd+D for free-form multi-cursor editing.', highlight: true },
    { pane: 'Editor', keys: 'Cmd/Ctrl + = / -', description: 'Zoom editor pane font size (preview unaffected — heading hierarchy stays readable while you bump editor text). Persisted across reloads. Range 9–32 px.', highlight: true },
    { pane: 'Editor', keys: 'Cmd/Ctrl + 0', description: 'Reset editor pane font size to default (13 px).', highlight: true },
    { pane: 'Editor', keys: 'Cmd/Ctrl + Shift + →', description: 'Expand selection: token → expression → fence → MARKDOWN SECTION → ENCLOSING PARENT SECTION → document. Mac Ctrl+Shift+→ also bound for muscle-memory parity.' },
    { pane: 'Editor', keys: '` * _ ~ ( [ { " \'', description: 'Wrap selection with the pair (markdown auto-pair)' },
    { pane: 'Editor', keys: 'Tab / Shift+Tab', description: 'Indent / outdent' },
    { pane: 'Preview', keys: 'Cmd/Ctrl + F', description: 'Find in preview (overlay top-right). Scrollbar match ticks; Enter / Shift+Enter to step through; Esc to close.', highlight: true },
    { pane: 'Preview', keys: 'Left-click on a word', description: 'Implicit highlight — all matching occurrences light up faintly (different shade than explicit search), with scrollbar ticks.' },
    { pane: 'Preview', keys: 'Right-click', description: 'NOVEL FEATURE — jump editor caret to the clicked block. Pairs with editor right-click for the other direction.' },
    { pane: 'Outline', keys: 'Click row', description: 'Jump both panes; toggle fold if the row has children. Auto-expands when scrolling moves the active heading into a collapsed branch.' },
    { pane: 'Outline', keys: 'Trash icon', description: 'Clear stored draft and reload — restores the sample doc.' },
    { pane: 'Outline', keys: '−', description: 'Fold all (while outline pane is focused)' },
    { pane: 'Outline', keys: '+ / =', description: 'Unfold all (while outline pane is focused)' },
    { pane: 'URL', keys: '?reset=1', description: 'Append to URL and reload to restore the sample doc (wipes the current localStorage draft).' },
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
            <tr class:highlight={s.highlight}>
              <td class="pane-col">{s.pane}</td>
              <td>
                <kbd>{s.keys}</kbd>
                {#if s.highlight}<span class="muscle-badge" title="A VS Code muscle-memory binding">VS Code</span>{/if}
              </td>
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
  /* v0.5.1: rows marked highlight=true are VS Code muscle-memory bindings.
     Accent stripe on the left edge + soft background tint + inline badge. */
  .shortcuts-dialog tr.highlight > td {
    background: rgba(9, 105, 218, 0.06);
  }
  .shortcuts-dialog tr.highlight > td:first-child {
    border-left: 3px solid #0969da;
    padding-left: 13px;
  }
  .shortcuts-dialog .muscle-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    font-size: 10px;
    line-height: 1.4;
    font-weight: 600;
    color: #ffffff;
    background: linear-gradient(180deg, #0969da, #0a5dc2);
    border-radius: 10px;
    vertical-align: middle;
    letter-spacing: 0.02em;
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
    .shortcuts-dialog tr.highlight > td {
      background: rgba(56, 139, 253, 0.10);
    }
    .shortcuts-dialog tr.highlight > td:first-child {
      border-left-color: #58a6ff;
    }
    .shortcuts-dialog .muscle-badge {
      background: linear-gradient(180deg, #1f6feb, #1158c7);
      color: #ffffff;
    }
    .shortcuts-dialog footer {
      background: #1c2128;
      border-top-color: #30363d;
      color: #8b949e;
    }
  }
</style>
