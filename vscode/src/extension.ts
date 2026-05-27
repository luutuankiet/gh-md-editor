import * as vscode from 'vscode';

const VIEW_TYPE = 'luutuankiet.ghMdEditor';
const GLOBAL_KEY_WIDTHS = 'ghMdEditor.widths';
const GLOBAL_KEY_APP_ZOOM = 'ghMdEditor.appZoom';
const CONFIG_NAMESPACE = 'ghMdEditor';

type Widths = { splitPct: number; outlineSplitterPct: number };
type ThemeChoice = 'light' | 'dark' | 'auto';
type Pane = 'editor' | 'preview' | 'outline';
type PaneThemes = { editor: ThemeChoice; preview: ThemeChoice; outline: ThemeChoice };

let output: vscode.OutputChannel | null = null;

// Every live webview panel. Commands (zoom, settings push) look up the active
// one via findActivePanel(); settingsUpdate fan-out walks the full set.
const activePanels = new Set<vscode.WebviewPanel>();

function log(msg: string): void {
  try {
    output?.appendLine(`[${new Date().toISOString()}] ${msg}`);
  } catch { /* output may be disposed */ }
  console.log(`[GH MD Editor] ${msg}`);
}

function currentTabUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab) {
    const input = tab.input;
    if (input instanceof vscode.TabInputCustom) return input.uri;
    if (input instanceof vscode.TabInputText) return input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

function findActivePanel(): vscode.WebviewPanel | undefined {
  for (const p of activePanels) {
    if (p.active) return p;
  }
  return undefined;
}

function readPaneThemes(): PaneThemes {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return {
    editor: (cfg.get<ThemeChoice>('editorTheme') ?? 'auto'),
    preview: (cfg.get<ThemeChoice>('previewTheme') ?? 'auto'),
    outline: (cfg.get<ThemeChoice>('outlineTheme') ?? 'auto'),
  };
}

function paneToSettingKey(pane: Pane): string {
  return `${pane}Theme`;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('GH MD Editor');
  log(`Extension activating. Version 0.2.0. Extension URI: ${context.extensionUri.toString()}`);

  const provider = new GhMdEditorProvider(context);

  // Push pane-theme changes to every live panel when user edits settings.json
  // or when paneThemeChange writeback round-trips. Skip non-ghMdEditor changes
  // so workspace settings churn doesn't ping the webview.
  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(CONFIG_NAMESPACE)) return;
    const themes = readPaneThemes();
    for (const p of activePanels) {
      try {
        p.webview.postMessage({ type: 'settingsUpdate', themes });
      } catch (err) {
        log(`settingsUpdate post error: ${err}`);
      }
    }
    log(`config changed; pushed settingsUpdate to ${activePanels.size} panel(s): ${JSON.stringify(themes)}`);
  });

  context.subscriptions.push(
    output,
    configSub,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('ghMdEditor.openCurrentFile', async () => {
      const uri = currentTabUri();
      if (!uri) {
        vscode.window.showWarningMessage('GH MD Editor: No active file to open.');
        return;
      }
      log(`openCurrentFile invoked for ${uri.toString()}`);
      try {
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      } catch (err) {
        log(`openCurrentFile error: ${err}`);
        vscode.window.showErrorMessage(`GH MD Editor: Failed to open file. ${err}`);
      }
    }),
    vscode.commands.registerCommand('ghMdEditor.switchToBuiltInTextEditor', async () => {
      const uri = currentTabUri();
      if (!uri) {
        vscode.window.showWarningMessage('GH MD Editor: No active editor to switch.');
        return;
      }
      log(`switchToBuiltInTextEditor invoked for ${uri.toString()}`);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    vscode.commands.registerCommand('ghMdEditor.showOutput', () => {
      output?.show();
    }),
    vscode.commands.registerCommand('ghMdEditor.zoomIn', () => {
      const p = findActivePanel();
      if (!p) { log('zoomIn: no active panel'); return; }
      p.webview.postMessage({ type: 'appZoomDelta', delta: 0.1 });
    }),
    vscode.commands.registerCommand('ghMdEditor.zoomOut', () => {
      const p = findActivePanel();
      if (!p) { log('zoomOut: no active panel'); return; }
      p.webview.postMessage({ type: 'appZoomDelta', delta: -0.1 });
    }),
    vscode.commands.registerCommand('ghMdEditor.zoomReset', () => {
      const p = findActivePanel();
      if (!p) { log('zoomReset: no active panel'); return; }
      p.webview.postMessage({ type: 'appZoomReset' });
    }),
    vscode.commands.registerCommand('ghMdEditor.setAsDefault', async () => {
      // Write workbench.editorAssociations for *.md / *.markdown -> our viewType.
      // Preserves any existing associations the user has for other patterns.
      const cfg = vscode.workspace.getConfiguration('workbench');
      const current = cfg.get<Record<string, string>>('editorAssociations') ?? {};
      const updated = {
        ...current,
        '*.md': VIEW_TYPE,
        '*.markdown': VIEW_TYPE,
      };
      try {
        await cfg.update('editorAssociations', updated, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          'GH MD Editor is now the default for *.md and *.markdown files.',
        );
        log(`setAsDefault wrote workbench.editorAssociations: ${JSON.stringify(updated)}`);
      } catch (err) {
        log(`setAsDefault error: ${err}`);
        vscode.window.showErrorMessage(`GH MD Editor: Failed to set default. ${err}`);
      }
    }),
  );

  log(`Extension activated. Registered custom editor viewType=${VIEW_TYPE}, retainContextWhenHidden=true.`);

  const HINT_KEY = 'ghMdEditor.firstRunHintShown';
  if (!context.globalState.get<boolean>(HINT_KEY)) {
    vscode.window.showInformationMessage(
      'GH MD Editor activated. Open a .md file via right-click → "Open With..." → "GH MD Editor", or run "GH MD Editor: Set as Default Editor for Markdown" to auto-open every .md.',
      'Set as Default',
      'Show Logs',
      'Got it',
    ).then((choice) => {
      if (choice === 'Set as Default') void vscode.commands.executeCommand('ghMdEditor.setAsDefault');
      else if (choice === 'Show Logs') output?.show();
      void context.globalState.update(HINT_KEY, true);
    });
  }
}

export function deactivate(): void {
  log('Extension deactivating.');
  output?.dispose();
  output = null;
}

class GhMdEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    log(`resolveCustomTextEditor START for ${document.uri.toString()}`);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };

    try {
      panel.webview.html = this.buildHtml(panel.webview);
      log(`Webview HTML attached; size=${panel.webview.html.length} bytes`);
    } catch (err) {
      log(`buildHtml error: ${err}`);
      panel.webview.html = `<html><body><h1>GH MD Editor failed to load</h1><pre>${String(err)}</pre></body></html>`;
      return;
    }

    activePanels.add(panel);

    let suppressNextEcho = false;

    const messageSub = panel.webview.onDidReceiveMessage(async (msg: any) => {
      try {
        log(`webview→host: ${msg?.type}`);
        switch (msg?.type) {
          case 'ready': {
            const widths = this.context.globalState.get<Widths>(GLOBAL_KEY_WIDTHS);
            const appZoom = this.context.globalState.get<number>(GLOBAL_KEY_APP_ZOOM) ?? 1.0;
            const themes = readPaneThemes();
            panel.webview.postMessage({
              type: 'init',
              content: document.getText(),
              widths,
              appZoom,
              themes,
              uri: document.uri.toString(),
              languageId: document.languageId,
            });
            log(`init sent (${document.getText().length} chars, widths=${JSON.stringify(widths)}, appZoom=${appZoom}, themes=${JSON.stringify(themes)})`);
            break;
          }
          case 'editorChange': {
            const text = String(msg.text ?? '');
            if (text === document.getText()) break;
            suppressNextEcho = true;
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length),
            );
            edit.replace(document.uri, fullRange, text);
            await vscode.workspace.applyEdit(edit);
            setTimeout(() => { suppressNextEcho = false; }, 0);
            break;
          }
          case 'widthsChange': {
            const splitPct = Number(msg.splitPct);
            const outlineSplitterPct = Number(msg.outlineSplitterPct);
            if (Number.isFinite(splitPct) && Number.isFinite(outlineSplitterPct)) {
              await this.context.globalState.update(GLOBAL_KEY_WIDTHS, {
                splitPct,
                outlineSplitterPct,
              });
              log(`widths persisted: ${splitPct}/${outlineSplitterPct}`);
            }
            break;
          }
          case 'appZoomChange': {
            // Persist whole-app zoom across reloads. globalState (not setting) — zoom
            // is per-installation UX state, not a setting users want to portably sync.
            const value = Number(msg.value);
            if (Number.isFinite(value) && value >= 0.5 && value <= 3.0) {
              await this.context.globalState.update(GLOBAL_KEY_APP_ZOOM, value);
              log(`appZoom persisted: ${value}`);
            }
            break;
          }
          case 'paneThemeChange': {
            // Cycle button -> write back to settings.json. Settings is the source of
            // truth in v0.2.0; this re-fires onDidChangeConfiguration above which
            // round-trips a settingsUpdate to all panels (no-op for the originating
            // pane since local state already reflects the new value).
            const pane = String(msg.pane ?? '') as Pane;
            const value = String(msg.value ?? '') as ThemeChoice;
            if (
              (pane === 'editor' || pane === 'preview' || pane === 'outline') &&
              (value === 'light' || value === 'dark' || value === 'auto')
            ) {
              const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
              // Workspace target if open (per-project README styling), else Global.
              const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
              try {
                await cfg.update(paneToSettingKey(pane), value, target);
                log(`pane theme persisted: ${pane}=${value} (target=${target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global'})`);
              } catch (err) {
                log(`paneThemeChange error: ${err}`);
              }
            }
            break;
          }
          case 'openExternal': {
            // mermaid 'open in mermaid.live' button + any <a target=_blank>
            // intercepted by webview's global click listener. window.open is
            // blocked in webviews; route via vscode.env.openExternal which
            // opens the user's default browser.
            const url = String(msg.url ?? '');
            if (/^https?:\/\//.test(url)) {
              try {
                await vscode.env.openExternal(vscode.Uri.parse(url));
                log(`openExternal: ${url}`);
              } catch (err) {
                log(`openExternal error: ${err}`);
              }
            }
            break;
          }
          default:
            log(`unknown message type: ${msg?.type}`);
            break;
        }
      } catch (err) {
        log(`message handler error: ${err}`);
      }
    });

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (suppressNextEcho) return;
      if (e.contentChanges.length === 0) return;
      panel.webview.postMessage({
        type: 'externalUpdate',
        text: e.document.getText(),
      });
    });

    panel.onDidDispose(() => {
      log(`panel disposed for ${document.uri.toString()}`);
      activePanels.delete(panel);
      messageSub.dispose();
      changeSub.dispose();
    });

    log(`resolveCustomTextEditor DONE for ${document.uri.toString()}`);
  }

  private buildHtml(webview: vscode.Webview): string {
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'index.css'));
    const cspSource = webview.cspSource;
    const nonce = createNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}' 'unsafe-eval'; img-src ${cspSource} https: data:; font-src ${cspSource} data:; connect-src https:;">
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>GH MD Editor</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
