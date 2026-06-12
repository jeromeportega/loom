#!/usr/bin/env bash
# Fetch SWE-bench Lite tasks from the HuggingFace dataset-server.
#
# Usage:
#   fetch.sh                 # 300 tasks (the whole Lite suite) -> ~/loom-bench/swe-lite-300.json
#   fetch.sh 50              # 50 tasks
#   fetch.sh 300 /tmp/x.json # 300 tasks to /tmp/x.json
#
# Requires: curl, jq.

set -euo pipefail

COUNT="${1:-300}"
OUTPUT="${2:-${HOME}/loom-bench/swe-lite-${COUNT}.json}"
DATASET="princeton-nlp/SWE-bench_Lite"
HF_URL_BASE="https://datasets-server.huggingface.co/rows"

if ! command -v jq >/dev/null 2>&1; then
  echo "  jq not found. Install: brew install jq" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"

# HF dataset-server caps each response at 100 rows. Paginate when COUNT > 100
# and merge the `rows` arrays into a single file the loom loader accepts.
PAGE_SIZE=100
if [ "$COUNT" -le "$PAGE_SIZE" ]; then
  echo "  Fetching ${COUNT} task(s) from ${DATASET}..."
  curl -sL --fail \
    "${HF_URL_BASE}?dataset=$(printf '%s' "$DATASET" | jq -rR @uri)&config=default&split=test&offset=0&length=${COUNT}" \
    > "$OUTPUT"
else
  echo "  Fetching ${COUNT} task(s) from ${DATASET} in pages of ${PAGE_SIZE}..."
  TMPDIR="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$TMPDIR'" EXIT

  OFFSET=0
  PAGE=0
  while [ "$OFFSET" -lt "$COUNT" ]; do
    LEN=$((COUNT - OFFSET))
    if [ "$LEN" -gt "$PAGE_SIZE" ]; then LEN="$PAGE_SIZE"; fi
    curl -sL --fail \
      "${HF_URL_BASE}?dataset=$(printf '%s' "$DATASET" | jq -rR @uri)&config=default&split=test&offset=${OFFSET}&length=${LEN}" \
      > "$TMPDIR/page-${PAGE}.json"
    OFFSET=$((OFFSET + LEN))
    PAGE=$((PAGE + 1))
  done

  jq -s '{rows: (map(.rows) | add)}' "$TMPDIR"/page-*.json > "$OUTPUT"
fi

ROWS=$(jq '.rows | length' "$OUTPUT")
echo "  Wrote ${ROWS} task(s) to ${OUTPUT}"
