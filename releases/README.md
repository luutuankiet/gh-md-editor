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
