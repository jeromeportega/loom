#!/usr/bin/env bash
# Local-preview the loom docs site via mkdocs.
#
# Uses uv to avoid polluting the system Python — no pip, no venv to manage.
# Default: serves at http://127.0.0.1:8000/ with live reload.
#
# Usage:
#   serve.sh                # default port
#   serve.sh 8080           # custom port

set -euo pipefail

PORT="${1:-8000}"

if ! command -v uv >/dev/null 2>&1; then
  echo "  uv not found. Install: brew install uv" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "  Serving docs at http://127.0.0.1:${PORT}/ (Ctrl-C to stop)"
uv run --with mkdocs --with pymdown-extensions \
  mkdocs serve --dev-addr "127.0.0.1:${PORT}"
