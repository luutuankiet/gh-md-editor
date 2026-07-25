#!/usr/bin/env bash
#
# ship.sh - build and release the two deliverables in this repo.
#
#   web app   root package.json    -> dist/ -> GitHub Pages (Actions deploys on push to main)
#   extension vscode/package.json  -> .vsix -> VS Code Marketplace
#
# They carry independent version numbers on purpose. Most feature work lives in
# src/components/* and src/lib/*, which BOTH deliverables compile from, so one
# source edit usually wants one release on each side.
#
# Usage
#   ./scripts/ship.sh build                    build web dist + extension vsix
#   ./scripts/ship.sh build web
#   ./scripts/ship.sh build ext
#   ./scripts/ship.sh check                    run the safety gates against staged files
#   ./scripts/ship.sh status                   show both current versions + git state
#
#   ./scripts/ship.sh release web 0.8.2        bump, build, gate, commit, tag, push
#   ./scripts/ship.sh release ext 0.2.7        bump, build, package vsix, commit, push
#   ./scripts/ship.sh release ext 0.2.7 --publish     ...and publish to the Marketplace
#   ./scripts/ship.sh publish ext              publish an already-built vsix (no rebuild)
#
# Flags
#   --yes        skip the confirmation prompt (required when stdin is not a terminal)
#   --publish    ext only: run vsce publish after packaging (needs VSCE_PAT or vsce login)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------- output --
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '   \033[33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[31mfailed: %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ node --
# node/npm live under nvm here and are NOT on a non-interactive shell's default
# PATH. Find the newest install and prepend it rather than failing with the
# famously unhelpful "sh: 1: npm: not found".
ensure_node() {
  if command -v node >/dev/null 2>&1; then return; fi
  local bin
  bin="$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$bin" ] && [ -x "$bin/node" ] || die "node is not on PATH and no nvm install was found"
  export PATH="$bin:$PATH"
  info "using node $(node -v) from nvm"
}

# --------------------------------------------------------------- versions --
read_version() {
  node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$1"
}

# Rewrites only the FIRST "version" key so the rest of the manifest keeps its
# exact formatting (a JSON round-trip would reflow the whole file).
set_version() {
  sed -i -E "0,/\"version\"/s/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\\1$2\\2/" "$1"
  [ "$(read_version "$1")" = "$2" ] || die "version bump did not take effect in $1"
}

valid_semver() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# ------------------------------------------------------------------ gates --
# Two things must never reach the public remote:
#   1. the private project journal + agent config directories
#   2. internal note identifiers, which mean nothing to a reader of this repo
gates() {
  bold "Safety gates"
  local staged
  staged="$(git diff --cached --name-only)"
  [ -n "$staged" ] || die "nothing is staged, so there is nothing to check"

  if printf '%s\n' "$staged" | rg -q 'gsd-lite/|\.claude/'; then
    printf '%s\n' "$staged" | rg 'gsd-lite/|\.claude/' >&2
    die "private files are staged. Fix .gitignore, unstage them, and retry."
  fi
  ok "no private directories staged"

  local hits
  hits="$(printf '%s\n' "$staged" | xargs -r rg -l '\bLOG-[0-9]|\bTASK-[0-9]' 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" >&2
    if [ "${SKIP_NOTATION_GATE:-0}" = "1" ]; then
      warn "internal note ids found, continuing because SKIP_NOTATION_GATE=1"
    else
      die "internal note ids found in the files above. Replace them with the actual finding, or re-run with SKIP_NOTATION_GATE=1."
    fi
  else
    ok "no internal note ids in shipped files"
  fi
}

# ------------------------------------------------------------------ build --
build_web() {
  bold "Building web app"
  npm run build
  ok "dist/ written"
}

build_ext() {
  bold "Building VS Code extension"
  ( cd vscode && rm -f ./*.vsix && npm run build && npx --yes @vscode/vsce package --no-dependencies )
  local vsix
  vsix="$(ls -1 vscode/*.vsix 2>/dev/null | head -1 || true)"
  [ -n "$vsix" ] || die "vsce produced no .vsix"
  ok "$vsix  ($(du -h "$vsix" | cut -f1))"
  info "sha256 $(sha256sum "$vsix" | cut -c1-16)..."
}

# ---------------------------------------------------------------- confirm --
confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  [ -t 0 ] || die "this step is irreversible and stdin is not a terminal. Re-run with --yes."
  printf '\n   %s [y/N] ' "$1"
  local reply; read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || die "aborted"
}

# ---------------------------------------------------------------- release --
release_web() {
  local ver="$1" notes="releases/v$1.md"
  valid_semver "$ver" || die "'$ver' is not a x.y.z version"
  [ -f "$notes" ] || die "write $notes first - it is the release narrative and the index links to it"

  bold "Web app  $(read_version package.json) -> $ver"
  set_version package.json "$ver"
  sed -i -E "s/gh-md-editor v[0-9]+\.[0-9]+\.[0-9]+/gh-md-editor v$ver/" public/userscript-installer.html
  ok "package.json + userscript installer footer bumped"

  build_web
  git add -A
  gates

  bold "Ready to ship v$ver"
  git --no-pager diff --cached --stat
  confirm "commit, tag v$ver and push to origin/main?"

  git commit -q -m "release: v$ver"
  git tag -a "v$ver" -m "v$ver"
  git push origin HEAD
  git push origin "v$ver"
  ok "pushed. GitHub Pages deploys automatically from the push to main."

  if command -v gh >/dev/null 2>&1; then
    gh release create "v$ver" --title "v$ver" --notes-file "$notes" && ok "GitHub release published"
  else
    warn "the gh CLI is not installed here, so the release page was not created."
    info "create it from any machine that has gh:"
    info "  gh release create v$ver --repo luutuankiet/gh-md-editor --notes-file $notes"
  fi
}

release_ext() {
  local ver="$1"
  valid_semver "$ver" || die "'$ver' is not a x.y.z version"

  bold "Extension  $(read_version vscode/package.json) -> $ver"
  set_version vscode/package.json "$ver"
  ok "vscode/package.json bumped"

  build_ext
  git add -A
  gates

  bold "Ready to ship extension v$ver"
  git --no-pager diff --cached --stat
  confirm "commit and push?"

  git commit -q -m "release(vscode): v$ver"
  git push origin HEAD
  ok "pushed"

  if [ "$DO_PUBLISH" = "1" ]; then
    bold "Publishing to the Marketplace"
    publish_ext
  else
    info "not published. Install the vsix locally, or re-run with --publish."
    info "  code --install-extension vscode/gh-md-editor-$ver.vsix"
  fi
}

# ---------------------------------------------------------------- publish --
# Publishing needs an Azure DevOps token with Marketplace:Manage scope, either
# in VSCE_PAT or stored by `vsce login luutuankiet`. Tokens expire, and vsce
# reports that as an opaque TF400813 authorization error - hence the hint below.
publish_ext() {
  local ver vsix
  ver="$(read_version vscode/package.json)"
  vsix="vscode/gh-md-editor-$ver.vsix"
  [ -f "$vsix" ] || die "$vsix not found. Run './scripts/ship.sh build ext' first."

  bold "Publishing $vsix to the Marketplace"
  if ! ( cd vscode && npx --yes @vscode/vsce publish --no-dependencies --packagePath "gh-md-editor-$ver.vsix" ); then
    warn "publish failed. If the error mentions TF400813 or token verification,"
    info "the Azure DevOps token has expired. Issue a new one with the"
    info "Marketplace:Manage scope at https://dev.azure.com/ (User settings ->"
    info "Personal access tokens), then either:"
    info "  export VSCE_PAT=<token> && ./scripts/ship.sh publish ext"
    info "  vsce login luutuankiet   # stores it, then re-run"
    exit 1
  fi
  ok "published - the listing updates a few minutes later"
}

# ------------------------------------------------------------------- main --
ASSUME_YES=0
DO_PUBLISH=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --yes|-y)  ASSUME_YES=1 ;;
    --publish) DO_PUBLISH=1 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *)         ARGS+=("$a") ;;
  esac
done

cmd="${ARGS[0]:-help}"
target="${ARGS[1]:-all}"
version="${ARGS[2]:-}"

ensure_node

case "$cmd" in
  build)
    case "$target" in
      web) build_web ;;
      ext) build_ext ;;
      all) build_web; build_ext ;;
      *)   die "unknown build target '$target' (want: web, ext, all)" ;;
    esac
    ;;
  check)  git add -A; gates ;;
  publish)
    [ "$target" = "ext" ] || die "only the extension is published this way (the web app deploys from a git push)"
    publish_ext
    ;;
  status)
    bold "Versions"
    info "web app    v$(read_version package.json)"
    info "extension  v$(read_version vscode/package.json)"
    bold "Git"
    git --no-pager log --oneline -1
    git status --short || true
    ;;
  release)
    [ -n "$version" ] || die "give a version, e.g. ./scripts/ship.sh release $target 1.2.3"
    case "$target" in
      web) release_web "$version" ;;
      ext) release_ext "$version" ;;
      *)   die "release target must be 'web' or 'ext'" ;;
    esac
    ;;
  help|*) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \?//' ;;
esac
