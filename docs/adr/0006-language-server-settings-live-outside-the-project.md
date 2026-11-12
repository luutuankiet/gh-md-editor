# Language server settings live outside the project

Per-workspace language server choices (which servers to start again, the Python
interpreter, schema picks for YAML and JSON files) are stored in the user's config
folder, never inside the project being edited.

Verified: 2026-11-12, against `LSP_CONFIG_HOME` and `lspSettingsFile` in
`server/index.mjs`.

## Where

- `$GH_MD_EDITOR_HOME/config` when `GH_MD_EDITOR_HOME` is set, otherwise
  `$XDG_CONFIG_HOME/gh-md-editor`, otherwise `~/.config/gh-md-editor`.
- One file per workspace: `workspaces/<first 16 hex of sha256(absolute path)>.json`.
- Caches such as the SchemaStore catalog and the generated dbt `profiles.yml`
  wrapper schema go under `cache/` in the same folder.

## Considered options

**A `.vscode/settings.json` style file in the project** was rejected. The editor
serves any folder, often a repository other people own; writing into it dirties
their git status and leaks one person's interpreter path or choices into a shared
tree.

**Browser storage only** was rejected. The node server is what starts language
servers and pushes their settings, and the same workspace opened from two browsers
(or after browser storage is cleared) must get the same choices. A browser asks
the server to start the remembered servers with `POST /api/lsp/autostart` when it
opens a file.

## Cost

Moving or renaming a project folder loses its settings, because the key is its
absolute path. Setting `GH_MD_EDITOR_HOME` is the way to keep a test or sandbox
run away from your real settings.
