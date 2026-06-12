#!/usr/bin/env bash
# Run loom against SWE-bench Lite tasks and (optionally) score the result.
#
# Defaults to the validated baseline config (promoted in docs/testing/runbook.md
# Run 8 + holdout): block-and-revise review with skill generation off and
# the candidate-skill cache pre-cleared. Override with the flags below to
# test alternative configurations.
#
# Usage:
#   run.sh                          # validated config; 10 tasks; scores
#   run.sh --limit 30               # 30 tasks
#   run.sh --no-score               # loom only, skip the Python scorer
#   run.sh --tasks <path>           # different dataset file
#   run.sh --output-dir <path>      # where to write predictions
#   run.sh --no-clean-skills        # skip pre-run skill cache clear
#   run.sh --review-strategy <m>    # override review_strategy
#   run.sh --skill-generation <m>   # override skill_generation
#   run.sh --preserve-failures      # keep failed-task tempdirs for diagnosis
#   run.sh --preserve-all           # keep every task tempdir (loom-passes-but-bench-fails forensics)
#   run.sh --review-model cross --review-model-id claude-opus-4-7
#                                   # route the reviewer through a different model via Cursor-CLI (#20)
#
# Steps:
#   1. Fetch the dataset if missing (via fetch.sh, unless --no-fetch).
#   2. Move ~/.loom/skills/generated/ aside for clean baseline
#      (unless --no-clean-skills).
#   3. Run `loom-bench swe-bench-lite` with the validated flags.
#   4. Score via `uv run --with swebench` (unless --no-score).

set -euo pipefail

# Defaults — locked to the validated baseline.
TASKS="${HOME}/loom-bench/swe-lite-300.json"
LIMIT=10
OUTPUT_DIR="${HOME}/loom-bench"
NO_SCORE=0
NO_FETCH=0
NO_CLEAN_SKILLS=0
PRESERVE_FAILURES=0
PRESERVE_ALL=0
REVIEW_STRATEGY="block-and-revise"
SKILL_GENERATION="off"
REVIEW_MODEL=""
REVIEW_MODEL_ID=""
REVIEW_REVISE_TRIGGER=""

# Locate the loom-bench binary (dev tool, separate from the user-facing
# `loom` CLI). Prefers the repo-local dist build so a stale global install
# can't spoof the script committed inside this repo; falls back to PATH
# for operators running it from outside a checkout.
find_loom() {
  local script_dir local_bin
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  local_bin="${script_dir}/../../packages/loom-cli/dist/loom-bench.js"
  if [ -f "$local_bin" ]; then
    echo "node ${local_bin}"
    return
  fi
  if command -v loom-bench >/dev/null 2>&1; then
    echo "loom-bench"
    return
  fi
  echo "  loom-bench not on PATH and no repo-local dist found." >&2
  echo "  Run 'npm run build' from the repo root, or 'npm link' inside packages/loom-cli/." >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tasks)             TASKS="$2"; shift 2 ;;
    --limit)             LIMIT="$2"; shift 2 ;;
    --output-dir)        OUTPUT_DIR="$2"; shift 2 ;;
    --no-score)          NO_SCORE=1; shift ;;
    --no-fetch)          NO_FETCH=1; shift ;;
    --no-clean-skills)   NO_CLEAN_SKILLS=1; shift ;;
    --review-strategy)   REVIEW_STRATEGY="$2"; shift 2 ;;
    --skill-generation)  SKILL_GENERATION="$2"; shift 2 ;;
    --preserve-failures) PRESERVE_FAILURES=1; shift ;;
    --preserve-all)      PRESERVE_ALL=1; shift ;;
    --review-model)      REVIEW_MODEL="$2"; shift 2 ;;
    --review-model-id)   REVIEW_MODEL_ID="$2"; shift 2 ;;
    --review-revise-trigger) REVIEW_REVISE_TRIGGER="$2"; shift 2 ;;
    -h|--help)
      head -n 24 "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Step 1: fetch the dataset if missing.
if [ ! -f "$TASKS" ]; then
  if [ "$NO_FETCH" -eq 1 ]; then
    echo "  Dataset not found at ${TASKS} and --no-fetch was set." >&2
    exit 1
  fi
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  "${script_dir}/fetch.sh" 300 "$TASKS"
fi

# Step 2: clean the candidate-skill cache for an isolated bench baseline.
# Skipped with --no-clean-skills if you intentionally want previously-
# generated candidates present (e.g. testing cross-task skill transfer).
if [ "$NO_CLEAN_SKILLS" -eq 0 ]; then
  SKILL_GEN_DIR="${HOME}/.loom/skills/generated"
  if [ -d "$SKILL_GEN_DIR" ] && [ -n "$(ls -A "$SKILL_GEN_DIR" 2>/dev/null)" ]; then
    SNAPSHOT="${SKILL_GEN_DIR%/generated}/generated-pre-bench-$(date +%Y%m%d-%H%M%S)"
    mv "$SKILL_GEN_DIR" "$SNAPSHOT"
    mkdir -p "$SKILL_GEN_DIR"
    echo "  Moved existing candidate skills aside: ${SNAPSHOT}"
  fi
fi

# Step 3: loom bench.
mkdir -p "$OUTPUT_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
PREDICTIONS="${OUTPUT_DIR}/predictions-${TIMESTAMP}.json"
LOOM="$(find_loom)"

echo ""
echo "  ─── loom-bench swe-bench-lite ────────────────────────────"
echo "    tasks:            ${TASKS}"
echo "    limit:            ${LIMIT}"
echo "    review_strategy:  ${REVIEW_STRATEGY}"
echo "    skill_generation: ${SKILL_GENERATION}"
echo "    predictions:      ${PREDICTIONS}"
echo "    loom:            ${LOOM}"
echo ""

# shellcheck disable=SC2086
$LOOM swe-bench-lite \
  --tasks "$TASKS" \
  --limit "$LIMIT" \
  --review-strategy "$REVIEW_STRATEGY" \
  --skill-generation "$SKILL_GENERATION" \
  $([ "$PRESERVE_FAILURES" -eq 1 ] && echo "--preserve-failures") \
  $([ "$PRESERVE_ALL" -eq 1 ] && echo "--preserve-all") \
  $([ -n "$REVIEW_MODEL" ] && echo "--review-model $REVIEW_MODEL") \
  $([ -n "$REVIEW_MODEL_ID" ] && echo "--review-model-id $REVIEW_MODEL_ID") \
  $([ -n "$REVIEW_REVISE_TRIGGER" ] && echo "--review-revise-trigger $REVIEW_REVISE_TRIGGER") \
  --output "$PREDICTIONS"

# Step 3: optional scoring via uv.
if [ "$NO_SCORE" -eq 1 ]; then
  echo "  Skipped scoring. Inspect predictions with:"
  echo "    ${0%/*}/inspect.sh ${PREDICTIONS}"
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "  uv not found — skipping the score step."
  echo "  Install: brew install uv" >&2
  echo "  Predictions are at ${PREDICTIONS}" >&2
  exit 0
fi

echo ""
echo "  ─── score: uv run --with swebench ─────────────────────────"
echo "    run_id: loom-${TIMESTAMP}"
echo ""
uv run --with swebench python -m swebench.harness.run_evaluation \
  --predictions_path "$PREDICTIONS" \
  --max_workers 4 \
  --run_id "loom-${TIMESTAMP}"
