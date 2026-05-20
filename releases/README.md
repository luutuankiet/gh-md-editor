# Release Notes Index

Append-only narrative release notes for `gh-md-editor`.

## Authoring

- **One file per release.** Name: `vX.Y.Z.md`. No overwrites.
- **Audience:** human first, then agents picking up context later.
- **Structure:** TL;DR → Why this release exists → Highlights table → Mermaid diagram → Before/After → Files changed → (optional) Hard truths.
- **Voice:** pitch, not changelog. If a line could be a commit subject, cut it.
- **Diagrams:** Mermaid only — GitHub renders it natively in release bodies. Use `<br/>` (not `\n`) inside node labels. Avoid parentheses inside labels.

## Publishing

For now, release bodies are created manually:

```bash
gh release create vX.Y.Z --notes-file releases/vX.Y.Z.md
```

This can be wired into `.github/workflows/deploy.yml` on tag push — see `.claude/skills/release/SKILL.md` (Pattern C) for the template that fails loudly if the notes file is missing.

## Index

| Version | Date | Theme |
|---|---|---|
| [v0.5.0](./v0.5.0.md) | 2026-05-21 | Find in either pane (Cmd+F overlay + scrollbar match ticks + click-word implicit highlight). SQL fenced code finally highlights. Mod+Shift+→ clamps to heading sections. Table-row reveal flash. Mac Opt+Z fix. Sample doc rewritten as feature tour. `?reset=1` URL recovery. |
| [v0.4.2](./v0.4.2.md) | 2026-05-20 | Stop the preview flicker (morphdom + paint containment + source-content keying for mermaid). Bundles sticky-scroll, alerts, autopairs, smart-select, shortcuts dialog, fork-me icon. |
| v0.3.0 | 2026-05-20 | Outline on right, code-fence syntax both panes, GH `<details>`, sticky breadcrumb |
| v0.2.0 | 2026-05-20 | Phase 3 outline sidebar (viewport-follow, fold/unfold) |
| v0.1.0 | 2026-05-20 | First release — editor + preview + reveal + mermaid + localStorage |
