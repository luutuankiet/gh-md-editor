// Diagnostics, hover card, quick fixes, rename and format for one language
// server. `@codemirror/lsp-client` 6.3.0 keeps only from/to/severity/message
// of a diagnostic and applies edits to open files only, so this module owns
// `publishDiagnostics` (full LSP shape, into diag-store.svelte.ts), renders the
// hover card VS Code shows (problem, rule link, symbol hover, actions), asks
// `textDocument/codeAction` and `textDocument/rename`, and applies the
// resulting WorkspaceEdit to open editors and to closed files on disk alike.

import { LSPPlugin, formatDocument as lspFormat, type LSPClient, type LSPClientExtension } from '@codemirror/lsp-client';
import { Prec, Text, type Extension } from '@codemirror/state';
import {
  EditorView, GutterMarker, ViewPlugin, gutter, hoverTooltip, keymap, type Command,
} from '@codemirror/view';
import {
  forEachDiagnostic, linter, nextDiagnostic, openLintPanel, previousDiagnostic, setDiagnostics, type Diagnostic,
} from '@codemirror/lint';
import { pathForUri, type Conn } from './client';
import { diagnosticsFor, onDiagnostics, publish, type LspDiagnostic, type LspRange } from './diag-store.svelte';
import { lineHasDiagnostic } from './error-lens';
import { tabOwns } from './doc-share';

type TextEdit = { range: LspRange; newText: string };
type LspCommand = { title: string; command: string; arguments?: unknown[] };
type CodeAction = {
  title: string; kind?: string; isPreferred?: boolean; diagnostics?: LspDiagnostic[];
  edit?: WorkspaceEdit; command?: LspCommand; data?: unknown; disabled?: { reason: string };
};
type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: ({ textDocument: { uri: string }; edits: TextEdit[] } | { kind: string })[];
};

// The LSP diagnostic behind each lint diagnostic in an editor.
const rawOf = new WeakMap<Diagnostic, LspDiagnostic>();
const SEV = ['error', 'error', 'warning', 'info', 'hint'] as const;

export function ruleLabel(d: LspDiagnostic): string {
  if (d.source && d.code != null) return `${d.source}(${d.code})`;
  return d.source ?? (d.code != null ? String(d.code) : '');
}

// --- the editor's squiggles, from the store ---------------------------------

function pushToView(view: EditorView, serverId: string) {
  const plugin = LSPPlugin.get(view);
  const path = plugin && pathForUri(plugin.uri);
  if (!plugin || path == null) return;
  const len = plugin.syncedDoc.length;
  const at = (p: { line: number; character: number }) => {
    let off: number;
    try { off = plugin.fromPosition(p, plugin.syncedDoc); } catch { off = len; }
    return plugin.unsyncedChanges.mapPos(Math.min(Math.max(off, 0), len));
  };
  const out: Diagnostic[] = diagnosticsFor(path, serverId).map((d) => {
    const from = at(d.range.start);
    const lint: Diagnostic = {
      from, to: Math.max(from, at(d.range.end)),
      severity: SEV[d.severity ?? 1] as Diagnostic['severity'],
      message: d.message,
      source: ruleLabel(d) || undefined,
      markClass: d.tags?.includes(1) ? 'cm-lsp-unnecessary' : undefined,
    };
    rawOf.set(lint, d);
    return lint;
  });
  view.dispatch(setDiagnostics(view.state, out));
}

function storeSync(serverId: string) {
  return ViewPlugin.define((view) => {
    queueMicrotask(() => pushToView(view, serverId));
    const off = onDiagnostics((path) => {
      const plugin = LSPPlugin.get(view);
      if (plugin && pathForUri(plugin.uri) === path) pushToView(view, serverId);
    });
    return { destroy: off };
  });
}

// --- requests ----------------------------------------------------------------

function rawAt(view: EditorView, from: number, to: number): LspDiagnostic[] {
  const out: LspDiagnostic[] = [];
  forEachDiagnostic(view.state, (d, f, t) => {
    const raw = rawOf.get(d);
    if (raw && f <= to && t >= from) out.push(raw);
  });
  return out;
}

async function codeActions(view: EditorView, from: number, to: number, only?: string[]): Promise<(CodeAction | LspCommand)[]> {
  const plugin = LSPPlugin.get(view);
  if (!plugin || !plugin.client.serverCapabilities?.codeActionProvider) return [];
  plugin.client.sync();
  const res = await plugin.client.request<unknown, (CodeAction | LspCommand)[] | null>('textDocument/codeAction', {
    textDocument: { uri: plugin.uri },
    range: { start: plugin.toPosition(from), end: plugin.toPosition(to) },
    context: { diagnostics: rawAt(view, from, to), triggerKind: 1, ...(only ? { only } : {}) },
  }).catch(() => null);
  return res ?? [];
}

async function runAction(client: LSPClient, a: CodeAction | LspCommand) {
  if (typeof a.command === 'string') {
    await client.request('workspace/executeCommand', { command: a.command, arguments: (a as LspCommand).arguments });
    return;
  }
  let act = a as CodeAction;
  if (!act.edit && act.data !== undefined && client.serverCapabilities?.codeActionProvider &&
      (client.serverCapabilities.codeActionProvider as { resolveProvider?: boolean }).resolveProvider) {
    act = await client.request<CodeAction, CodeAction>('codeAction/resolve', act).catch(() => act);
  }
  if (act.edit) {
    const r = await applyWorkspaceEdit(client, act.edit);
    if (!r.applied) alert(`Could not apply "${act.title}": ${r.failureReason}`);
  }
  if (act.command) {
    await client.request('workspace/executeCommand', { command: act.command.command, arguments: act.command.arguments })
      .catch(() => {});
  }
}

// --- WorkspaceEdit -----------------------------------------------------------

function offsetIn(doc: Text, p: { line: number; character: number }): number {
  if (p.line >= doc.lines) return doc.length;
  const line = doc.line(p.line + 1);
  return Math.min(line.from + p.character, line.to);
}

/** Applies an edit to open editors and, through the file API, to closed files. */
export async function applyWorkspaceEdit(client: LSPClient, edit: WorkspaceEdit): Promise<{ applied: boolean; failureReason?: string }> {
  const per: [string, TextEdit[]][] = [];
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if (!('textDocument' in dc)) return { applied: false, failureReason: `file ${dc.kind} is not supported` };
      per.push([dc.textDocument.uri, dc.edits]);
    }
  } else {
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) per.push([uri, edits]);
  }
  const failed: string[] = [];
  for (const [uri, edits] of per) {
    const path = pathForUri(uri);
    if (path == null) { failed.push(uri); continue; }
    const view = client.workspace.getFile(uri)?.getView();
    const plugin = view && LSPPlugin.get(view);
    if (view && plugin) {
      const map = (p: TextEdit['range']['start']) =>
        plugin.unsyncedChanges.mapPos(offsetIn(plugin.syncedDoc, p));
      view.dispatch({
        changes: edits.map((e) => ({ from: map(e.range.start), to: map(e.range.end), insert: e.newText })),
        userEvent: 'input.lsp',
      });
      continue;
    }
    if (tabOwns(path)) { failed.push(`${path} (open in a tab that is not showing)`); continue; }
    try {
      const got = (await (await fetch(`/api/file?path=${encodeURIComponent(path)}`)).json()) as { content?: string; mtimeMs?: number };
      if (typeof got.content !== 'string') { failed.push(path); continue; }
      const crlf = got.content.includes('\r\n');
      const doc = Text.of(got.content.split(/\r?\n/));
      const changes = edits
        .map((e) => ({ from: offsetIn(doc, e.range.start), to: offsetIn(doc, e.range.end), insert: e.newText }))
        .sort((a, b) => b.from - a.from);
      let text = doc.toString();
      for (const c of changes) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
      if (crlf) text = text.replace(/\r?\n/g, '\r\n');
      const r = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content: text, baseMtimeMs: got.mtimeMs }),
      });
      if (!r.ok) failed.push(path);
    } catch {
      failed.push(path);
    }
  }
  window.dispatchEvent(new CustomEvent('gmd:git-refresh'));
  return failed.length ? { applied: false, failureReason: `could not edit ${failed.join(', ')}` } : { applied: true };
}

/** A request the server sent the editor; returns the reply, or null when it is not ours. */
export function answerServerRequest(conn: Conn, msg: { id: number | string; method: string; params?: unknown }): Promise<unknown> | null {
  if (msg.method !== 'workspace/applyEdit') return null;
  const edit = (msg.params as { edit?: WorkspaceEdit })?.edit ?? {};
  return applyWorkspaceEdit(conn.client, edit);
}

// --- floating menu and input -------------------------------------------------

let openMenu: HTMLElement | null = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }

function floatAt(view: EditorView, pos: number, el: HTMLElement) {
  closeMenu();
  const c = view.coordsAtPos(pos) ?? view.dom.getBoundingClientRect();
  el.className = `gmd-lsp-float ${el.className}`;
  el.style.left = `${Math.round(c.left)}px`;
  el.style.top = `${Math.round(c.bottom + 2)}px`;
  view.dom.ownerDocument.body.appendChild(el);
  openMenu = el;
  const away = (e: MouseEvent) => { if (!el.contains(e.target as Node)) { closeMenu(); removeEventListener('mousedown', away, true); } };
  addEventListener('mousedown', away, true);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); view.focus(); }
  });
}

function showActions(view: EditorView, pos: number, actions: (CodeAction | LspCommand)[]) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const el = document.createElement('div');
  el.className = 'gmd-lsp-actions';
  el.setAttribute('role', 'menu');
  const usable = actions.filter((a) => !(a as CodeAction).disabled);
  if (!usable.length) {
    el.textContent = 'No code actions available';
    el.tabIndex = -1;
  }
  usable.sort((a, b) => Number(!!(b as CodeAction).isPreferred) - Number(!!(a as CodeAction).isPreferred));
  for (const a of usable) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.textContent = a.title;
    b.onclick = () => { closeMenu(); view.focus(); void runAction(plugin.client, a); };
    el.appendChild(b);
  }
  el.addEventListener('keydown', (e) => {
    const items = [...el.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
  floatAt(view, pos, el);
  ((el.querySelector('button') as HTMLElement | null) ?? el).focus();
}

/** The range quick fixes are asked for: the selection, else the cursor line's problems. */
function fixRange(view: EditorView): { from: number; to: number } {
  const sel = view.state.selection.main;
  if (!sel.empty) return { from: sel.from, to: sel.to };
  const line = view.state.doc.lineAt(sel.head);
  let from = sel.head, to = sel.head;
  forEachDiagnostic(view.state, (_d, f, t) => {
    if (f <= line.to && t >= line.from && (from === sel.head || (f <= sel.head && t >= sel.head))) { from = f; to = t; }
  });
  return { from, to };
}

export const quickFix: Command = (view) => {
  if (!LSPPlugin.get(view)) return false;
  const { from, to } = fixRange(view);
  void codeActions(view, from, to).then((a) => showActions(view, view.state.selection.main.head, a));
  return true;
};

export const renameSymbol: Command = (view) => {
  const plugin = LSPPlugin.get(view);
  if (!plugin || !plugin.client.serverCapabilities?.renameProvider) return false;
  const word = view.state.wordAt(view.state.selection.main.head);
  if (!word) return true;
  const el = document.createElement('div');
  const input = document.createElement('input');
  input.value = view.state.sliceDoc(word.from, word.to);
  input.setAttribute('aria-label', 'New name');
  el.className = 'gmd-lsp-rename';
  el.appendChild(input);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const newName = input.value.trim();
    closeMenu();
    view.focus();
    if (!newName || newName === view.state.sliceDoc(word.from, word.to)) return;
    plugin.client.sync();
    void plugin.client.request<unknown, WorkspaceEdit | null>('textDocument/rename', {
      textDocument: { uri: plugin.uri }, position: plugin.toPosition(word.from), newName,
    }).then(async (edit) => {
      if (!edit) return;
      const r = await applyWorkspaceEdit(plugin.client, edit);
      if (!r.applied) alert(`Rename incomplete: ${r.failureReason}`);
    }, (err: { message?: string }) => alert(`Rename failed: ${err?.message ?? err}`));
  });
  floatAt(view, word.from, el);
  input.focus();
  input.select();
  return true;
};

// LSP formatting when the server offers it; otherwise the tab's own formatter
// (bound to the same chord at a lower precedence) runs.
const formatViaServer: Command = (view) => {
  const plugin = LSPPlugin.get(view);
  if (!plugin || !plugin.client.serverCapabilities?.documentFormattingProvider) return false;
  return lspFormat(view);
};

const viewProblem: Command = (view) => openLintPanel(view);

// --- hover card --------------------------------------------------------------

function renderHover(plugin: LSPPlugin, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => renderHover(plugin, v)).join('<hr>');
  if (typeof value === 'string') return plugin.docToHTML(value, 'markdown');
  const v = value as { language?: string; value: string; kind?: string };
  if (v.language !== undefined) return plugin.docToHTML('```' + v.language + '\n' + v.value + '\n```', 'markdown');
  return plugin.docToHTML(v as { kind: 'markdown' | 'plaintext'; value: string });
}

function btn(label: string, kbd: string | null, run: () => void): HTMLElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (kbd) { const k = document.createElement('kbd'); k.textContent = kbd; b.append(' ', k); }
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = run;
  return b;
}

const hoverCard = hoverTooltip(async (view, pos) => {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  const diags: { d: Diagnostic; from: number; to: number }[] = [];
  forEachDiagnostic(view.state, (d, from, to) => { if (from <= pos && to >= pos) diags.push({ d, from, to }); });
  plugin.client.sync();
  const hoverP = !plugin.client.serverCapabilities?.hoverProvider ? Promise.resolve(null)
    : plugin.client.request<unknown, { contents: unknown; range?: LspRange } | null>('textDocument/hover', {
      textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos),
    }).catch(() => null);
  const fixesP = diags.length
    ? Promise.race([codeActions(view, diags[0].from, diags[0].to, ['quickfix']), new Promise<[]>((r) => setTimeout(() => r([]), 1500))])
    : Promise.resolve([]);
  const [hover, fixes] = await Promise.all([hoverP, fixesP]);
  if (!hover && !diags.length) return null;
  const from = diags.length ? Math.min(...diags.map((x) => x.from)) : pos;
  const to = diags.length ? Math.max(...diags.map((x) => x.to)) : pos;
  return {
    pos: from, end: to, above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-lsp-hover-tooltip cm-lsp-documentation gmd-hover';
      for (const { d } of diags) {
        const raw = rawOf.get(d);
        const row = document.createElement('div');
        row.className = `gmd-hover-problem gmd-sev-${d.severity}`;
        const msg = document.createElement('span');
        msg.className = 'gmd-hover-msg';
        msg.textContent = d.message;
        row.appendChild(msg);
        const label = raw ? ruleLabel(raw) : d.source ?? '';
        if (label) {
          const href = raw?.codeDescription?.href;
          const rule = document.createElement(href ? 'a' : 'span');
          rule.className = 'gmd-hover-rule';
          rule.textContent = label;
          if (href && /^https?:/.test(href)) { (rule as HTMLAnchorElement).href = href; (rule as HTMLAnchorElement).target = '_blank'; (rule as HTMLAnchorElement).rel = 'noopener noreferrer'; }
          row.append(' ', rule);
        }
        dom.appendChild(row);
      }
      if (hover) {
        if (diags.length) dom.appendChild(document.createElement('hr'));
        const body = document.createElement('div');
        body.className = 'gmd-hover-body';
        body.innerHTML = renderHover(plugin, hover.contents);
        dom.appendChild(body);
      }
      if (diags.length) {
        const bar = document.createElement('div');
        bar.className = 'gmd-hover-actions';
        bar.append(
          btn('View Problem', 'Alt+F8', () => { view.dispatch({ selection: { anchor: diags[0].from } }); openLintPanel(view); }),
          btn('Quick Fix...', 'Ctrl+.', () => { view.dispatch({ selection: { anchor: diags[0].from } }); view.focus(); quickFix(view); }),
        );
        const best = (fixes as CodeAction[]).find((f) => f.isPreferred) ?? (fixes as CodeAction[])[0];
        if (best && !best.disabled) bar.append(btn(best.title, null, () => void runAction(plugin.client, best)));
        dom.appendChild(bar);
      }
      return { dom };
    },
  };
}, { hideOn: (tr) => tr.docChanged });

// --- light bulb ----------------------------------------------------------------

class Bulb extends GutterMarker {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'gmd-bulb';
    s.title = 'Show Code Actions (Ctrl+.)';
    s.textContent = '\u{1F4A1}';
    return s;
  }
}
const bulb = new Bulb();

// Shown on the cursor line when it has a problem; the server is asked only on click.
const bulbGutter = gutter({
  class: 'gmd-bulb-gutter',
  lineMarker(view, line) {
    const head = view.state.selection.main.head;
    if (head < line.from || head > line.to) return null;
    return lineHasDiagnostic(view.state, line.from) ? bulb : null;
  },
  lineMarkerChange: (u) => u.selectionSet || u.docChanged || u.transactions.some((t) => t.effects.length > 0),
  domEventHandlers: {
    mousedown(view, line) {
      view.dispatch({ selection: { anchor: Math.max(line.from, Math.min(view.state.selection.main.head, line.to)) } });
      quickFix(view);
      return true;
    },
  },
});

const theme = EditorView.baseTheme({
  '.gmd-hover-problem': { padding: '2px 0' },
  '.gmd-hover-rule': { opacity: '0.75', marginLeft: '4px' },
  'a.gmd-hover-rule': { color: '#3794ff', textDecoration: 'none' },
  'a.gmd-hover-rule:hover': { textDecoration: 'underline' },
  '.gmd-hover-actions': {
    display: 'flex', gap: '12px', flexWrap: 'wrap', borderTop: '1px solid rgba(128,128,128,0.35)',
    margin: '6px 0 0 !important', padding: '4px 10px',
  },
  '.gmd-hover-actions button': {
    background: 'none', border: 'none', color: '#3794ff', cursor: 'pointer', padding: '2px 0', font: 'inherit',
  },
  '.gmd-hover-actions kbd': { opacity: '0.7', fontSize: '11px' },
  '.gmd-bulb-gutter': { width: '16px' },
  '.gmd-bulb': { cursor: 'pointer', fontSize: '11px' },
  '.cm-lsp-unnecessary': { opacity: '0.6' },
});

// Floating menus live on <body>, outside every editor theme.
if (typeof document !== 'undefined' && !document.getElementById('gmd-lsp-float-style')) {
  const s = document.createElement('style');
  s.id = 'gmd-lsp-float-style';
  s.textContent = `
.gmd-lsp-float{position:fixed;z-index:1000;background:#252526;color:#ccc;border:1px solid #454545;border-radius:4px;
  box-shadow:0 2px 8px rgba(0,0,0,.36);font:13px system-ui,sans-serif;padding:4px 0;min-width:180px;max-width:520px}
.gmd-lsp-actions{display:flex;flex-direction:column}
.gmd-lsp-actions:not(:has(button)){padding:4px 10px;opacity:.8}
.gmd-lsp-actions button{background:none;border:none;color:inherit;text-align:left;padding:4px 10px;font:inherit;cursor:pointer}
.gmd-lsp-actions button:hover,.gmd-lsp-actions button:focus{background:#04395e;outline:none}
.gmd-lsp-rename{padding:4px}
.gmd-lsp-rename input{background:#3c3c3c;color:#ccc;border:1px solid #007fd4;padding:3px 6px;font:13px monospace;min-width:220px;outline:none}`;
  document.head.appendChild(s);
}

/** Everything above, for one server, as an LSPClient extension. */
export function lspFeatures(serverId: string): LSPClientExtension {
  return {
    clientCapabilities: {
      textDocument: {
        publishDiagnostics: { versionSupport: true, relatedInformation: true, codeDescriptionSupport: true, dataSupport: true, tagSupport: { valueSet: [1, 2] } },
        codeAction: {
          dataSupport: true, isPreferredSupport: true, disabledSupport: true,
          resolveSupport: { properties: ['edit'] },
          codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } },
        },
        rename: { prepareSupport: false },
      },
      workspace: { applyEdit: true, workspaceEdit: { documentChanges: true } },
    },
    notificationHandlers: {
      'textDocument/publishDiagnostics': (_client, params: { uri: string; diagnostics: LspDiagnostic[] }) => {
        const path = pathForUri(params.uri);
        if (path != null) publish(serverId, path, params.diagnostics ?? []);
        return true;
      },
    },
    editorExtension: [
      storeSync(serverId),
      // Squiggles only; the hover card below replaces lint's own tooltip.
      linter(null, { tooltipFilter: () => [] }),
      hoverCard,
      bulbGutter,
      theme,
      Prec.high(keymap.of([
        { key: 'Mod-.', run: quickFix, preventDefault: true },
        { key: 'F2', run: renameSymbol, preventDefault: true },
        { key: 'Shift-Alt-f', run: formatViaServer },
        { key: 'F8', run: nextDiagnostic, preventDefault: true },
        { key: 'Shift-F8', run: previousDiagnostic, preventDefault: true },
        { key: 'Alt-F8', run: viewProblem, preventDefault: true },
      ])),
    ] as Extension,
  };
}
