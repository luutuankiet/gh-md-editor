# Release Notes Index

Append-only narrative release notes for `gh-md-editor`.

## Authoring

- **One file per release.** Name: `vX.Y.Z.md`. No overwrites.
- **Audience:** a future agent reconstructing how the project grew — not a human reading a pitch.
- **Format:** title line + short bullets, one per change (`**what** — why`). Scannable in ~10 seconds. No prose paragraphs, no diagrams, ~8 bullets max.
- **This format wins over the older entries here.** v0.8.1 and earlier run long and pitchy; reuse them only for file-naming and index conventions, never for length or tone.
- **Voice:** plain and factual. Long reasoning belongs in the commit body, not here.

## Publishing

For now, release bodies are created manually:

```bash
gh release create vX.Y.Z --notes-file releases/vX.Y.Z.md
```

This can be wired into `.github/workflows/deploy.yml` on tag push — see `.claude/skills/release/SKILL.md` (Pattern C) for the template that fails loudly if the notes file is missing.

## Index

| Version | Date | Theme |
|---|---|---|
| [v0.13.0](./v0.13.0.md) | 2026-07-31 | Find is an overlay instead of a layout insert, so the scrollbar ticks stop lying; `Escape` clears match highlights. Quick open and the command palette get a real fuzzy modal with recents and `@` symbols. Selection expand/shrink works in every highlighted language, and Mac `Cmd+Shift+Arrow` selects to line boundary again. Outline double-click reveals the full node, refreshes, and resizes. `code-gh` opens workspaces and files from the integrated terminal. vscode-icons file icons, Monokai Dimmed, JSON Format Document. Workspaces can be anchored anywhere on disk — paths outside the served folder stay absolute through open, search, git and titles. |
| [v0.12.1](./v0.12.1.md) | 2026-07-31 | The git repository picker anchors to the open workspace rather than the directory the server was started in, resolved through `?base=`; refresh re-anchors instead of only refetching status; an anchor with no repository shows an empty picker instead of falling back to an unrelated project. |
| [v0.12.0](./v0.12.0.md) | 2026-07-31 | Background servers: `up` spawns a detached session leader that survives the ssh logout that started it and prints url, pid and log path; `list-servers` and `down` manage them through a registry under `~/.cache/gh-md-editor/servers`. |
| [v0.11.1](./v0.11.1.md) | 2026-07-31 | An Outline section in the explorer — symbol icons, indent guides, per-workspace collapse state — including JSON outlines with no language server. Outline parsing bounded above 400KB so large files stay responsive. Collapse-all toggles in the explorer and the outline, an explorer refresh button, context-menu delete and shift-range selection, workspace-relative terminals, folder search and open-workspace commands in the palette, and a workspace-wide markdown split ratio. |
| [v0.11.0](./v0.11.0.md) | 2026-07-30 | `--tunnel` downloads cloudflared into a user cache on first use, making the public-URL flag zero-setup; `--tunnel funnel` explains the Tailscale daemon requirement instead of failing. Missing ripgrep / git named at startup with install lines, and a README table of optional host tools. Quick open reports a missing ripgrep instead of returning nothing. Editor tabs show their containing folder; the explorer expands to and highlights the active file; both trees draw indent guides with the active file's ancestor trail lit. |
| [v0.10.0](./v0.10.0.md) | 2026-07-30 | `--tunnel` exposes the server over public HTTPS via a cloudflared quick tunnel (or Tailscale Funnel), force-enabling a server-minted auth token. Editor sessions (tabs, splits, diffs, panels, unsaved drafts) persist across a browser close. `Alt/Opt+N` blank buffers with a click-through Save As dialog. Explorer multi-select, absolute paths in copied context, copy-full-path and open-terminal-here context items. |
| [v0.9.1](./v0.9.1.md) | 2026-07-30 | Server mode — `npx @luutuankiet/gh-md-editor` serves any folder in the browser: file tree, tabs, terminal, ripgrep search, git source control, quick open, ports panel. `.md` opens the three-pane cockpit, everything else a plain syntax-highlighted editor. Editor gains a double-click word-highlight layer. First npm release via OIDC trusted publishing. |
| [v0.8.1](./v0.8.1.md) | 2026-07-25 | Preview pane drops click-word highlighting, matching v0.8.0's editor-side removal. Clicking a word in the reading pane no longer shades every occurrence or paints blue scrollbar ticks; `Cmd/Ctrl+F` search is unchanged. |
| [v0.8.0](./v0.8.0.md) | 2026-07-17 | Resolved GitHub-attachment images stop flickering / re-resolving on every keystroke (morphdom node preservation, same trick as mermaid blocks). Editor drops the eager cursor-word highlight — inline green + scrollbar implicit ticks removed; Cmd+F is the only word-find now. |
| [v0.7.0](./v0.7.0.md) | 2026-05-24 | Per-pane dark mode toggle (editor / preview / outline), persisted to localStorage. Editor pane finally gets a real GitHub-dark `HighlightStyle` + EditorView chrome — fixes the washed-out tokens that appeared whenever the OS was dark pre-v0.7. Hot-swap via CodeMirror `Compartment`; `github-markdown-{light,dark}.css` scope-prefixed at runtime so panes can disagree. |
| [v0.5.2](./v0.5.2.md) | 2026-05-21 | hotfix | Alt+Left-click multi-cursor: explicit DOM-level mousedown handler for cross-browser parity (Mac Firefox fix). |
| [v0.5.1](./v0.5.1.md) | 2026-05-21 | Preview sticky-header parity + multi-cursor (`Cmd+D` / `Alt+Click`). Section-grow ascend fix. Outline auto-expand. Trash-button storage clear. Scrollbar gutters bumped to 18 px. Shortcuts dialog highlights VS Code muscle-memory bindings. Mac `Ctrl+Shift+→` parity. |
| [v0.5.0](./v0.5.0.md) | 2026-05-21 | Find in either pane (Cmd+F overlay + scrollbar match ticks + click-word implicit highlight). SQL fenced code finally highlights. Mod+Shift+→ clamps to heading sections. Table-row reveal flash. Mac Opt+Z fix. Sample doc rewritten as feature tour. `?reset=1` URL recovery. |
| [v0.4.2](./v0.4.2.md) | 2026-05-20 | Stop the preview flicker (morphdom + paint containment + source-content keying for mermaid). Bundles sticky-scroll, alerts, autopairs, smart-select, shortcuts dialog, fork-me icon. |
| v0.3.0 | 2026-05-20 | Outline on right, code-fence syntax both panes, GH `<details>`, sticky breadcrumb |
| v0.2.0 | 2026-05-20 | Phase 3 outline sidebar (viewport-follow, fold/unfold) |
| v0.1.0 | 2026-05-20 | First release — editor + preview + reveal + mermaid + localStorage |
