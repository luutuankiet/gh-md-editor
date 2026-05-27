<script lang="ts">
  import { untrack } from 'svelte';
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
  import Splitter from './Splitter.svelte';
  import Outline from './Outline.svelte';
  import ShortcutsDialog from './ShortcutsDialog.svelte';
  import { parseMarkdown, extractOutline, type OutlineNode } from '../lib/markdown';
  import { revealPreview, revealEditor } from '../lib/reveal';
  import {
    loadTheme, saveTheme, cycleTheme, systemPrefersDark, onSystemThemeChange,
    type ThemeChoice, type EffectiveTheme,
  } from '../lib/theme';
  import { EditorView } from '@codemirror/view';

  // === VS Code custom editor host bridge ===
  // The webview entry (vscode/webview/main.ts) waits for the host's `init`
  // message, then mounts this component with `initial` as a prop. Subsequent
  // edits flow back to the host via postMessage; the host applies them to the
  // underlying TextDocument via WorkspaceEdit (which feeds Cmd+S, dirty marker,
  // undo history, etc. — VS Code owns the document lifecycle).
  type VsCodeApi = {
    postMessage: (msg: unknown) => void;
    getState: <T = unknown>() => T | undefined;
    setState: <T = unknown>(state: T) => void;
  };
  declare const acquireVsCodeApi: () => VsCodeApi;
  const vscodeApi: VsCodeApi = (globalThis as any).__vscodeApi ?? acquireVsCodeApi();

  let { initial }: {
    initial: {
      content: string;
      widths?: { splitPct: number; outlineSplitterPct: number };
      appZoom?: number;
      themes?: { editor: ThemeChoice; preview: ThemeChoice; outline: ThemeChoice };
      uri: string;
      languageId: string;
    };
  } = $props();

  // Track the last text we sent so we don't echo our own change back when the
  // host's onDidChangeTextDocument fires (suppressNextEcho on the host side
  // covers the immediate round-trip; this guard covers the reactive cascade
  // where Svelte's $effect on `doc` fires after CM6 updates value via $bindable).
  let lastSentDoc = untrack(() => initial.content);
  let editorChangeTimer: ReturnType<typeof setTimeout> | null = null;
  function postEditorChange(text: string): void {
    if (text === lastSentDoc) return;
    if (editorChangeTimer) clearTimeout(editorChangeTimer);
    editorChangeTimer = setTimeout(() => {
      lastSentDoc = text;
      vscodeApi.postMessage({ type: 'editorChange', text });
    }, 100);
  }

  // Persist splitter widths to host globalState on change. Skip the first
  // reactive tick (which fires on mount with the initial values — nothing to
  // save).
  let _widthsMounted = false;
  $effect(() => {
    const sp = splitPct;
    const op = outlineSplitterPct;
    if (!_widthsMounted) { _widthsMounted = true; return; }
    const t = setTimeout(() => {
      vscodeApi.postMessage({ type: 'widthsChange', splitPct: sp, outlineSplitterPct: op });
    }, 300);
    return () => clearTimeout(t);
  });

  // Receive external edits (other editor on same doc, programmatic edit) from
  // the host and forward to CM6 via direct dispatch — preserves cursor better
  // than re-setting the $bindable value (CM6 doesn't watch its value prop
  // reactively for re-dispatch; that direction is one-way: CM6 → parent).
  if (typeof window !== 'undefined') {
    window.addEventListener('message', (event: MessageEvent) => {
      const msg = (event as any).data;
      if (msg?.type === 'externalUpdate' && typeof msg.text === 'string') {
        if (msg.text === doc) return;
        if (editorView) {
          editorView.dispatch({
            changes: { from: 0, to: editorView.state.doc.length, insert: msg.text },
          });
          // CM6 updateListener will write back via $bindable -> doc; mark
          // lastSentDoc so postEditorChange in the cascade skips re-posting.
          lastSentDoc = msg.text;
        } else {
          doc = msg.text;
          lastSentDoc = msg.text;
        }
        return;
      }
      if (msg?.type === 'settingsUpdate' && msg.themes) {
        // VS Code settings changed (user edited settings.json OR cycle-button
        // writeback round-tripped). Settings is source of truth; re-derive pane
        // choices. Same-value reassignments are no-ops for $derived dependents.
        if (msg.themes.editor) editorChoice = msg.themes.editor;
        if (msg.themes.preview) previewChoice = msg.themes.preview;
        if (msg.themes.outline) outlineChoice = msg.themes.outline;
        return;
      }
      if (msg?.type === 'appZoomDelta' && typeof msg.delta === 'number') {
        // Cmd+=/- via contributes.keybindings -> command handler -> postMessage.
        // Focus guard: if cursor is inside CM6, skip — CM6's own Mod-Equal keymap
        // already handled this as editor-only font-size. Without the guard, events
        // that bubble out of the iframe (some Chromium versions) would double-fire.
        if (document.activeElement?.closest('.cm-editor')) return;
        const next = Math.max(0.5, Math.min(3.0, appZoom + msg.delta));
        appZoom = Math.round(next * 100) / 100;
        return;
      }
      if (msg?.type === 'appZoomReset') {
        // Cmd+0 — unambiguous reset, bypass focus guard.
        appZoom = 1.0;
        return;
      }
    });

    // v0.2.0: VS Code webview sandbox blocks window.open and silently no-ops
    // <a target="_blank"> clicks. Intercept clicks on external links here and
    // route them through the extension host -> vscode.env.openExternal.
    // Covers the GitHub icon in the outline header + any other external link
    // a markdown doc renders. Mermaid's 'open in mermaid.live' button uses
    // its own webview detection in mermaid.ts since it's a programmatic
    // window.open, not an anchor click.
    window.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement | null)?.closest('a');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      if (!/^https?:\/\//.test(href)) return;
      e.preventDefault();
      vscodeApi.postMessage({ type: 'openExternal', url: href });
    });

    // v0.2.1: in-webview Cmd+= / Cmd+- / Cmd+0 handler. VS Code webview iframe
    // doesn't propagate the BARE Cmd+= variant to chrome, so the extension's
    // contributes.keybindings entry for plain `cmd+=` never fires for that
    // physical key. The Cmd+Shift+= variant DOES propagate -> contributes.keybindings
    // handles it via the appZoomDelta message path. To avoid double-bumping the
    // shifted variant, skip when shiftKey is held (let chrome's keybinding own it).
    // event.code is layout-independent: 'Equal'/'Minus'/'Digit0' cover Mac + Win + Linux.
    window.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.altKey) return;
      if (e.shiftKey) return; // chrome keybinding handles Cmd+Shift+= variants
      // Editor pane has its own font-size shortcut at the CM6 DOM level
      // (Editor.svelte's domEventHandlers.keydown -> bumpFontSize); skip if
      // focus is in CM6 so we don't steal its event when the user is typing.
      if (document.activeElement?.closest('.cm-editor')) return;
      if (e.code === 'Equal') {
        e.preventDefault();
        bumpAppZoom(0.1);
      } else if (e.code === 'Minus') {
        e.preventDefault();
        bumpAppZoom(-0.1);
      } else if (e.code === 'Digit0') {
        e.preventDefault();
        resetAppZoom();
      }
    });
  }

  // v0.2.0 (VS Code): per-pane theme is driven by VS Code workspace settings,
  // not solely by localStorage. init.themes carries the user's current settings;
  // cycle buttons postMessage back to host which writes settings.json; settings
  // change round-trips back as a settingsUpdate message which re-assigns these.
  // localStorage is a parallel cache so the panes render instantly before the
  // settings round-trip completes; it's also the fallback if init.themes is
  // somehow absent (defensive, shouldn't happen in v0.2.0+).
  let editorChoice = $state<ThemeChoice>(untrack(() => initial.themes?.editor ?? loadTheme('editor')));
  let previewChoice = $state<ThemeChoice>(untrack(() => initial.themes?.preview ?? loadTheme('preview')));
  let outlineChoice = $state<ThemeChoice>(untrack(() => initial.themes?.outline ?? loadTheme('outline')));
  let systemDark = $state(systemPrefersDark());
  $effect(() => onSystemThemeChange((dark) => { systemDark = dark; }));

  function resolve(c: ThemeChoice): EffectiveTheme {
    if (c === 'light') return 'light';
    if (c === 'dark') return 'dark';
    return systemDark ? 'dark' : 'light';
  }
  let editorEffective = $derived<EffectiveTheme>(resolve(editorChoice));
  let previewEffective = $derived<EffectiveTheme>(resolve(previewChoice));
  let outlineEffective = $derived<EffectiveTheme>(resolve(outlineChoice));

  function cycleEditor() {
    editorChoice = cycleTheme(editorChoice);
    saveTheme('editor', editorChoice);
    vscodeApi.postMessage({ type: 'paneThemeChange', pane: 'editor', value: editorChoice });
  }
  function cyclePreview() {
    previewChoice = cycleTheme(previewChoice);
    saveTheme('preview', previewChoice);
    vscodeApi.postMessage({ type: 'paneThemeChange', pane: 'preview', value: previewChoice });
  }
  function cycleOutline() {
    outlineChoice = cycleTheme(outlineChoice);
    saveTheme('outline', outlineChoice);
    vscodeApi.postMessage({ type: 'paneThemeChange', pane: 'outline', value: outlineChoice });
  }

  // v0.2.0: whole-app zoom. Cmd+= / Cmd+- / Cmd+0 routed via
  // contributes.keybindings (which shadows VS Code's workbench.action.zoomIn
  // so chrome doesn't resize) -> ghMdEditor.zoom* command -> postMessage
  // appZoomDelta / appZoomReset. Initial value from globalState via init.appZoom;
  // every change persists back via appZoomChange (debounced).
  let appZoom = $state(untrack(() => initial.appZoom ?? 1.0));
  let _appZoomMounted = false;
  $effect(() => {
    const z = appZoom;
    if (!_appZoomMounted) { _appZoomMounted = true; return; }
    const t = setTimeout(() => {
      vscodeApi.postMessage({ type: 'appZoomChange', value: z });
    }, 200);
    return () => clearTimeout(t);
  });

  // v0.2.1: shared zoom helpers. Used by:
  //   1. The in-webview keydown listener (plain Cmd+= / Cmd+- / Cmd+0 — chrome
  //      keybindings don't fire for these because the webview iframe doesn't
  //      forward them).
  //   2. The +/- buttons rendered on Editor + Preview panes (keyboard fallback).
  // Focus guard: skip when CM6 has focus — its DOM-level keydown handler in
  // Editor.svelte already calls bumpFontSize for the editor pane and called
  // preventDefault; we just need to not also bump the app-level zoom.
  function bumpAppZoom(delta: number) {
    if (document.activeElement?.closest('.cm-editor')) return;
    const next = Math.max(0.5, Math.min(3.0, appZoom + delta));
    appZoom = Math.round(next * 100) / 100;
  }
  function resetAppZoom() {
    appZoom = 1.0;
  }

  let doc = $state(untrack(() => initial.content));
  let html = $state(untrack(() => parseMarkdown(doc)));
  let splitPct = $state(untrack(() => initial.widths?.splitPct ?? 50));
  // outlineSplitterPct = splitter position from LEFT of shell, %. Outline pane is
  // RIGHT of splitter, so its width = 100 - outlineSplitterPct.
  let outlineSplitterPct = $state(untrack(() => initial.widths?.outlineSplitterPct ?? 80));
  let editorView: EditorView | null = $state(null);
  let previewHost: HTMLElement | null = $state(null);
  let showShortcuts = $state(false);

  let outline = $derived<OutlineNode[]>(extractOutline(doc));
  let activeHeadingLine = $state(0);
  let editorTopLine = $state(1);
  // v0.5.1: track preview scrollTop so we can hide the sticky stack when the
  // user is at the very top (parity with editor's `topLine > 1` suppression).
  let previewScrollTop = $state(0);

  // Path of headings (root -> deepest) whose .line <= editorTopLine.
  // At each level pick the LAST heading (closest to topLine) and recurse.
  function computeBreadcrumb(roots: OutlineNode[], topLine: number): OutlineNode[] {
    const out: OutlineNode[] = [];
    let level = roots;
    while (true) {
      let best: OutlineNode | null = null;
      for (const n of level) {
        if (n.line <= topLine && (!best || n.line > best.line)) best = n;
      }
      if (!best) break;
      out.push(best);
      level = best.children;
    }
    return out;
  }

  // Hide sticky-header stack at the very top of the document — the first
  // heading is already visible, no point duplicating it.
  let editorBreadcrumb = $derived<OutlineNode[]>(
    editorTopLine > 1 ? computeBreadcrumb(outline, editorTopLine) : []
  );

  // v0.5.1: preview pane gets the same sticky-header treatment. Drives off
  // activeHeadingLine (already tracked via the existing scroll listener) and
  // hides when scrolled near the top.
  let previewBreadcrumb = $derived<OutlineNode[]>(
    previewScrollTop > 20 && activeHeadingLine > 0
      ? computeBreadcrumb(outline, activeHeadingLine)
      : []
  );

  let parseTimer: ReturnType<typeof setTimeout> | null = null;
  let firstRun = true;
  $effect(() => {
    const current = doc;
    if (firstRun) {
      firstRun = false;
      return;
    }
    if (parseTimer) clearTimeout(parseTimer);
    parseTimer = setTimeout(() => {
      html = parseMarkdown(current);
    }, 80);
    return () => {
      if (parseTimer) clearTimeout(parseTimer);
    };
  });

  $effect(() => {
    postEditorChange(doc);
  });

  // Track which heading is currently visible at the top of the preview pane.
  // CRITICAL bug fix in v0.4.0: skip elements whose `offsetParent === null` —
  // those are inside closed <details> (display:none). Their getBoundingClientRect()
  // returns zeros, which the previous code interpreted as 'above threshold' and
  // set as active, causing the outline highlight to wrongly jump to headings
  // inside collapsed sections while the user had actually scrolled past them.
  $effect(() => {
    if (!previewHost) return;
    const ph = previewHost;

    const compute = () => {
      const flatLines: number[] = [];
      const flatten = (ns: OutlineNode[]) => {
        for (const n of ns) {
          flatLines.push(n.line);
          flatten(n.children);
        }
      };
      flatten(outline);

      if (flatLines.length === 0) {
        activeHeadingLine = 0;
        return;
      }
      const flatSet = new Set(flatLines);
      const hostRect = ph.getBoundingClientRect();
      const threshold = hostRect.top + 30;
      const all = ph.querySelectorAll<HTMLElement>('[data-source-line]');
      let active = 0;
      for (const el of all) {
        const ln = Number(el.dataset.sourceLine);
        if (!Number.isFinite(ln) || !flatSet.has(ln)) continue;
        // Skip headings inside closed <details>. offsetParent is null when
        // an ancestor has display:none, which is exactly what closed <details>
        // does to its non-summary children. Their bounding rect would be (0,0)
        // and falsely satisfy top <= threshold.
        if (el.offsetParent === null) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= threshold) active = ln;
        else break;
      }
      activeHeadingLine = active || flatLines[0];
    };

    const onScroll = () => {
      previewScrollTop = ph.scrollTop;
      requestAnimationFrame(compute);
    };
    ph.addEventListener('scroll', onScroll, { passive: true });

    let scheduleTimer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(scheduleTimer);
      scheduleTimer = setTimeout(compute, 100);
    };
    schedule();

    // Observe the article's DIRECT children (not the whole subtree). subtree:true
    // used to fire hundreds of mutation records per morphdom diff (one per
    // text-node tweak inside a code block or SVG); childList on the article is
    // enough since every heading we care about is a top-level child.
    //
    // We ALSO subtree-watch the `open` attribute on <details>: when the user
    // expands a previously-collapsed section, headings inside flip from
    // offsetParent === null to visible, so the active-heading calculation
    // needs to re-run. attributeFilter:['open'] keeps the mutation traffic
    // bounded — only user clicks on <summary> fire it; morphdom doesn't
    // touch `open` because Preview.svelte's onBeforeElUpdated aligns it first.
    const article = ph.querySelector<HTMLElement>('article.markdown-body') ?? ph;
    const mo = new MutationObserver(schedule);
    mo.observe(article, {
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
      subtree: true,
    });

    return () => {
      clearTimeout(scheduleTimer);
      mo.disconnect();
      ph.removeEventListener('scroll', onScroll);
    };
  });

  function handleEditorReveal(line: number) {
    if (previewHost) revealPreview(previewHost, line);
  }

  function handlePreviewReveal(node: HTMLElement) {
    if (editorView) revealEditor(editorView, node);
  }

  function handleOutlineJump(line: number) {
    if (previewHost) revealPreview(previewHost, line);
    if (editorView) {
      const docState = editorView.state.doc;
      if (line >= 1 && line <= docState.lines) {
        const lineObj = docState.line(line);
        editorView.dispatch({
          selection: { anchor: lineObj.from },
          effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
        });
      }
    }
  }

  function sampleDoc(): string {
    return [
      '# gh-md-editor — markdown that follows you',
      '',
      'A side-by-side markdown editor with the one thing every other side-by-side',
      'markdown editor refuses to do: **never lose your place when switching panes**.',
      '',
      '**Why this exists.** Writing markdown blind in a plain textarea is a guessing',
      'game (does that table align? is that actually a heading?). Writing in WYSIWYG',
      'locks you out of your own source. This sits in the middle: every keystroke',
      'renders next to its source, and the outline + sticky breadcrumb keep you',
      'oriented in long documents.',
      '',
      '**Drive it like VS Code.** `Cmd/Ctrl+F` finds in either pane, `Cmd/Ctrl+Shift+→`',
      'grows the selection, **right-click in either pane jumps the other** (the novel',
      'feature this editor exists for). `Cmd+D` spawns a cursor at the next match;',
      '`Alt+Click` drops one wherever you point. Full shortcut sheet behind the `?`',
      'in the outline header — the **VS Code** badges flag muscle-memory bindings.',
      '',
      '**What it is NOT.** No collaboration, no cloud sync, no account. Your draft',
      'lives in this browser localStorage. Refresh — still here. Close the laptop —',
      'still here when you come back. Append `?reset=1` to the URL to restore THIS',
      'sample doc at any time.',
      '',
      '---',
      '',
      '## Try these first',
      '',
      '1. **Right-click any line in the editor** → preview flashes the matching block (auto-expanding `<details>` if needed). Then right-click any paragraph in the preview → editor caret jumps. THIS is the feature this app exists for.',
      '2. Press `Cmd/Ctrl+F` in either pane → search overlay opens. The **preview** one is the VS Code muscle-memory port via the CSS Custom Highlight API.',
      '3. Click any word in the preview → matching occurrences light up faintly, both inline and on the scrollbar (now an 18px gutter, visible from across the room).',
      '4. Press `Cmd/Ctrl+Shift+→` repeatedly → selection grows: word → fence → MARKDOWN SECTION → ENCLOSING PARENT SECTION → document. Mac: `Ctrl+Shift+→` also bound.',
      '5. Select a word and press `Cmd/Ctrl+D` repeatedly → spawn cursors at every next match. Type once, type everywhere.',
      '6. Hold `Alt/Opt` and left-click anywhere → drop another cursor at the click point.',
      '7. Click the trash icon in the outline header (top-right) → wipes localStorage and reloads, restoring this tour.',
      '',
      '## Headings stack as you scroll — both panes',
      '',
      '> [!TIP]',
      '> Scroll either pane down a few headings. The top of the pane stacks',
      '> `# → ## → ###` translucently so you always see where you are. Click any sticky',
      '> row to jump back. **New in v0.5.1:** the preview pane gets the same treatment',
      '> — sticky breadcrumb mirrors what the editor pane has always done.',
      '',
      '### A nested third-level heading',
      '',
      '#### A fourth, for the road',
      '',
      '…and back to the top of the section.',
      '',
      '## Outline tracks what you read — and auto-expands',
      '',
      'The outline on the right highlights the heading you are currently scrolled to.',
      '**New in v0.5.1:** if that heading is inside a collapsed branch, the outline',
      'walks ancestors and auto-expands them so the active row stays visible. No more',
      'hunting collapsed parents to find where the highlight went.',
      '',
      '## Alerts, the GitHub way',
      '',
      'Five flavors — same syntax GitHub uses on issues and PRs.',
      '',
      '> [!NOTE]',
      '> A friendly aside. Useful but not urgent.',
      '',
      '> [!TIP]',
      '> A keyboard shortcut, or a better way to do something.',
      '',
      '> [!IMPORTANT]',
      '> Something the reader genuinely needs to know.',
      '',
      '> [!WARNING]',
      '> Something that can go wrong if ignored.',
      '',
      '> [!CAUTION]',
      '> Something that WILL go wrong. Stop and read.',
      '',
      '## Collapsible sections',
      '',
      '<details>',
      '<summary>Click to expand — try right-clicking on a line inside</summary>',
      '',
      'The load-bearing trick here: right-clicking an editor line that lives inside a',
      'closed `<details>` block makes the preview auto-open the block before scrolling',
      'to the target. No more "where did my reveal go?"',
      '',
      '### A heading hidden inside',
      '',
      'Nested headings inside a collapsed section stay correctly tracked — the outline',
      'on the right does NOT mark them as active while they are invisible.',
      '',
      '</details>',
      '',
      '## Diagrams (mermaid)',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Source markdown] --> B[parse]',
      '  B --> C[morphdom diff]',
      '  C --> D[Preview DOM]',
      '  D -.->|right-click| A',
      '```',
      '',
      'Source-content keying means edits elsewhere on the page never force the diagram',
      'to re-render. Only changes to THIS fenced block touch the SVG.',
      '',
      '## Fenced code, syntax-highlighted',
      '',
      'SQL — new in v0.5.0. The grammar was not loaded before, so SQL fences rendered',
      'as plain black text. Try it with Postgres, Snowflake, BigQuery:',
      '',
      '```sql',
      'WITH recent AS (',
      '  SELECT user_id, MAX(created_at) AS last_seen',
      '  FROM events',
      "  WHERE created_at > CURRENT_DATE - INTERVAL '30 days'",
      '  GROUP BY 1',
      ')',
      'SELECT u.id, u.email, r.last_seen',
      'FROM users u',
      'LEFT JOIN recent r ON r.user_id = u.id',
      'WHERE r.last_seen IS NULL;',
      '```',
      '',
      'TypeScript:',
      '',
      '```ts',
      'async function greet(name: string): Promise<void> {',
      '  const greeting = `Hello, ${name}!`;',
      '  console.log(greeting);',
      '}',
      '```',
      '',
      'Bash:',
      '',
      '```bash',
      'git log --oneline -10 | rg "feat:" | wc -l',
      '```',
      '',
      '## Tables — now flash by row',
      '',
      '| Feature | Editor pane | Preview pane |',
      '|---|---|---|',
      '| Right-click reveal | flashes matching block on the other side | flashes matching line in editor |',
      '| Search overlay (Cmd+F) | floating panel top-right (CodeMirror) | floating panel top-right (custom) |',
      '| Scrollbar match ticks | 18px gutter, yellow query / blue word-at-cursor | same shades, same gutter |',
      '| Click a word | grows selection via `Cmd+Shift+→` | implicit highlight (inline + scrollbar) |',
      '| Multi-cursor | `Cmd+D` at next match; `Alt+Click` at pointer | n/a — preview is read-only |',
      '| Sticky breadcrumb | yes | yes (new in v0.5.1) |',
      '',
      'Right-click any row above. v0.5.0 added per-row reveal; before, you got the',
      'whole table flashed instead of just the line you pointed at.',
      '',
      '## Private GitHub attachments (NEW v0.6.0)',
      '',
      'Paste a screenshot into a GitHub PR body and GitHub emits',
      '`<img src="https://github.com/user-attachments/assets/...">`. For PRIVATE / org',
      'repos this URL needs your session cookie, which a static SPA cannot send',
      'cross-origin. v0.6.0 ships a **Tampermonkey companion userscript** that runs on',
      'YOUR machine, has access to your github.com session, and resolves the bytes via',
      '`GM.xmlHttpRequest`. The preview pane swaps the `<img>` to the resolved blob URL.',
      '',
      'Install once at [./userscript-installer.html](./userscript-installer.html).',
      'Without it, each user-attachments tag renders as a `[View on GitHub →]` link',
      'instead of a broken image. Graceful degradation, no PAT required.',
      '',
      '## Auto-pairs',
      '',
      'Select any text in this paragraph and press `` ` ``, `*`, `_`, `(`, `[`, `{`, `"` or `\'`:',
      'the selection gets wrapped with the matching pair. Selecting "auto-pairs" above',
      'and pressing `` ` `` turns it into `` `auto-pairs` ``.',
      '',
      '## Selection growth, VS Code-style',
      '',
      'Put the cursor inside the SQL block earlier and press `Cmd/Ctrl+Shift+→`',
      'repeatedly:',
      '',
      '1. token → SQL identifier',
      '2. → expression',
      '3. → statement',
      '4. → whole fenced block',
      '5. → the WHOLE `## Fenced code…` section',
      '6. → the ENCLOSING parent section (`# gh-md-editor`)',
      '7. → the entire document',
      '',
      'Step 5 is the v0.5.0 fix (clamp to section). Step 6 is the v0.5.1 fix: after',
      'clamping, the NEXT press ascends to the enclosing parent section instead of',
      'walking sideways to the next sibling.',
      '',
      'Mac users: `Ctrl+Shift+→` works the same as `Cmd+Shift+→` — both bound.',
      '',
      '---',
      '',
      '> Your changes persist in localStorage. Refresh — they are still here. The',
      '> keyboard cheat-sheet lives behind the `?` in the outline header (top-right).',
      '> The **trash icon** next to it wipes the draft and restores this tour at any',
      '> time. `?reset=1` in the URL does the same thing.',
      '',
    ].join('\n');
  }
</script>

<main class="shell" style="--app-zoom: {appZoom};">
  <div class="editor-preview">
    <div
      class="pane editor-pane theme-{editorEffective}"
      style="flex-basis: {splitPct}%;"
      oncontextmenu={(e) => e.preventDefault()}
      role="presentation"
    >
      {#if editorBreadcrumb.length > 0}
        <div class="sticky-headers" aria-hidden="false">
          {#each editorBreadcrumb as item, i (item.line)}
            <button
              type="button"
              class="sticky-header level-{item.level}"
              style="top: {i * 22}px; z-index: {20 - i}"
              onclick={() => handleOutlineJump(item.line)}
              title={`Jump to line ${item.line}`}
            >{'#'.repeat(item.level)} {item.text}</button>
          {/each}
        </div>
      {/if}
      <Editor
        bind:value={doc}
        bind:view={editorView}
        bind:topLine={editorTopLine}
        onRevealRequest={handleEditorReveal}
        themeChoice={editorChoice}
        effectiveTheme={editorEffective}
        onThemeToggle={cycleEditor}
        onZoomIn={() => bumpAppZoom(0.1)}
        onZoomOut={() => bumpAppZoom(-0.1)}
      />
    </div>
    <Splitter bind:pct={splitPct} />
    <div class="pane" style="flex-basis: {100 - splitPct}%;">
      <Preview
        {html}
        bind:host={previewHost}
        onRevealRequest={handlePreviewReveal}
        breadcrumb={previewBreadcrumb}
        onHeaderJump={handleOutlineJump}
        themeChoice={previewChoice}
        effectiveTheme={previewEffective}
        onThemeToggle={cyclePreview}
        onZoomIn={() => bumpAppZoom(0.1)}
        onZoomOut={() => bumpAppZoom(-0.1)}
      />
    </div>
  </div>
  <Splitter bind:pct={outlineSplitterPct} />
  <div class="pane outline-host" style="flex-basis: {100 - outlineSplitterPct}%;">
    <Outline
      nodes={outline}
      activeLine={activeHeadingLine}
      onJump={handleOutlineJump}
      onHelp={() => (showShortcuts = true)}
      onClear={() => { /* no-op: VS Code owns document lifecycle */ }}
      themeChoice={outlineChoice}
      effectiveTheme={outlineEffective}
      onThemeToggle={cycleOutline}
    />
  </div>
</main>

<ShortcutsDialog bind:open={showShortcuts} />


<style>
  .shell {
    display: flex;
    flex-direction: row;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .pane {
    flex-grow: 0;
    flex-shrink: 0;
    height: 100%;
    overflow: hidden;
    min-width: 0;
  }
  .editor-preview {
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }
  .editor-pane {
    position: relative;
  }
  /* Sticky-header stack: one absolute row per breadcrumb level, cascading 22px each.
     Each row is translucent + blurred so the editor content underneath stays dimly
     visible (VS Code parity). The wrapper is pointer-events:none so the EMPTY space
     between rows passes clicks through to the editor; individual rows re-enable it. */
  .sticky-headers {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    pointer-events: none;
  }
  .sticky-header {
    position: absolute;
    left: 0;
    right: 0;
    height: 22px;
    pointer-events: auto;
    background: rgba(246, 248, 250, 0.86);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-top: none;
    border-left: none;
    border-right: none;
    border-bottom: 1px solid rgba(208, 215, 222, 0.5);
    padding: 0 12px;
    display: flex;
    align-items: center;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: calc(13px * var(--app-zoom, 1));
    line-height: 22px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    text-align: left;
    width: 100%;
    box-sizing: border-box;
  }
  .sticky-header:hover { background: rgba(9, 105, 218, 0.10); }
  .sticky-header.level-1 { color: #cf222e; font-weight: 700; }
  .sticky-header.level-2 { color: #0550ae; font-weight: 700; }
  .sticky-header.level-3 { color: #6639ba; font-weight: 600; }
  .sticky-header.level-4 { color: #953800; font-weight: 600; }
  .sticky-header.level-5 { color: #0a3069; font-weight: 500; }
  .sticky-header.level-6,
  .sticky-header.level-7,
  .sticky-header.level-8 { color: #1f2328; font-weight: 500; }

  /* v0.7.0: sticky-header dark variant now keyed off the editor pane's theme
     class (.editor-pane.theme-dark) instead of OS prefers-color-scheme.
     Mirrors the per-pane toggle. */
  .editor-pane.theme-dark .sticky-header {
    background: rgba(13, 17, 23, 0.86);
    border-bottom-color: rgba(48, 54, 61, 0.5);
  }
  .editor-pane.theme-dark .sticky-header:hover { background: rgba(56, 139, 253, 0.12); }
  .editor-pane.theme-dark .sticky-header.level-1 { color: #ff7b72; }
  .editor-pane.theme-dark .sticky-header.level-2 { color: #79c0ff; }
  .editor-pane.theme-dark .sticky-header.level-3 { color: #d2a8ff; }
  .editor-pane.theme-dark .sticky-header.level-4 { color: #ffa657; }
  .editor-pane.theme-dark .sticky-header.level-5 { color: #a5d6ff; }
  .editor-pane.theme-dark .sticky-header.level-6,
  .editor-pane.theme-dark .sticky-header.level-7,
  .editor-pane.theme-dark .sticky-header.level-8 { color: #c9d1d9; }
</style>
