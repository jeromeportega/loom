#!/usr/bin/env bash
# Quick read-only inspection of a loom predictions.json — works without
# uv / swebench / Docker. Lets you see what loom produced before paying
# for the official scorer run.
#
# Usage:
#   inspect.sh <predictions.json>
#   inspect.sh <predictions.json> <instance_id>  # show one patch in full

set -euo pipefail

FILE="${1:-}"
INSTANCE="${2:-}"

if [ -z "$FILE" ]; then
  echo "Usage: $0 <predictions.json> [instance_id]" >&2
  exit 1
fi
if [ ! -f "$FILE" ]; then
  echo "  No such file: $FILE" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "  jq not found. Install: brew install jq" >&2
  exit 1
fi

if [ -n "$INSTANCE" ]; then
  jq -r --arg id "$INSTANCE" '
    .[] | select(.instance_id == $id) |
    "─── \(.instance_id) ───\nmodel: \(.model_name_or_path)\n\n\(.model_patch)"
  ' "$FILE"
  exit 0
fi

TOTAL=$(jq 'length' "$FILE")
NONEMPTY=$(jq '[.[] | select(.model_patch != "")] | length' "$FILE")
EMPTY=$((TOTAL - NONEMPTY))

echo ""
echo "  ${FILE}"
echo "  total predictions: ${TOTAL}"
echo "  non-empty patches: ${NONEMPTY}"
echo "  empty patches:     ${EMPTY}"
echo ""
echo "  per-task summary:"
jq -r '
  .[] |
  if .model_patch == "" then
    "    – \(.instance_id)  (empty)"
  else
    "    ✓ \(.instance_id)  (\(.model_patch | length) bytes)"
  end
' "$FILE"
echo ""
echo "  See one task in full:  $0 ${FILE} <instance_id>"
echo ""
