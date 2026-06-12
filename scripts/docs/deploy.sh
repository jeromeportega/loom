#!/usr/bin/env bash
# Build and deploy the loom docs to GitHub Pages.
#
# Mirrors a standard docs-publish CI flow but runnable from a
# developer machine. Builds with `mkdocs build --strict` (fails on
# broken links / nav references) and publishes to the `gh-pages`
# branch via `mkdocs gh-deploy`.
#
# Requires push access to the repo. Site lands at the GitHub Pages URL
# configured in mkdocs.yml (site_url).
#
# Usage:
#   deploy.sh             # build + deploy
#   deploy.sh --dry-run   # build only (no push); useful for CI sanity check

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "  uv not found. Install: brew install uv" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Refuse to deploy with uncommitted changes to TRACKED files — the
# gh-deploy commit message embeds the current SHA, and an uncommitted
# tracked change makes that SHA misleading. Untracked files are fine
# (the runtime .loom/ dir routinely lives here, gitignored).
if [[ "$DRY_RUN" -eq 0 ]] && ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "  Working tree has uncommitted changes to tracked files. Commit or stash before deploying." >&2
  echo "  (Untracked files are ignored — only modified/staged tracked files block deploy.)" >&2
  exit 1
fi

echo "  Building docs (strict mode)…"
uv run --with mkdocs --with pymdown-extensions \
  mkdocs build --strict

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  --dry-run: built into ${ROOT}/site, not deploying."
  exit 0
fi

echo "  Deploying to the gh-pages branch…"
uv run --with mkdocs --with pymdown-extensions \
  mkdocs gh-deploy --clean --force

echo ""
echo "  Deployed. Site URL: $(grep site_url mkdocs.yml | head -1 | sed 's/.*"\(.*\)"/\1/')"
