/**
 * Baked policy constants (knob-hardening, phase 1).
 *
 * loom is a single-user tool, so its quality/engineering policy knobs were
 * unjustified configuration surface. These constants replace the former
 * tunable `policy.agents.*` / `policy.cross_repo.*` knobs at their MOST ROBUST
 * value. The corresponding fields are being removed from PolicySchema; every
 * consumption site imports the constant here instead of reading the policy
 * object.
 *
 * This is the single source of truth for the baked values. Consumers keep any
 * unit conversion they already did (e.g. `STORY_STALL_MINUTES * 60_000`) — the
 * constants carry the SAME units as the policy fields they replace, so each is
 * a 1:1 drop-in for its former `policy.agents.<field>` read.
 *
 * NOT baked (still tunable in policy.yaml): max_concurrent, the model-id and
 * backend/auth knobs, test/smoke commands, the entire git.* and filesystem.*
 * security sections, cross_repo.secret_globs, loom_home, and mcp.registry.
 */

// ─── Review ──────────────────────────────────────────────────────────────────
/** Every worker runs block-and-revise before opening a PR. */
export const REVIEW_STRATEGY = 'block-and-revise' as const;
/** Max block-and-revise revision passes before a story is marked blocked. */
export const REVIEW_MAX_PASSES = 3;
/** Any non-empty review finding re-prompts the worker (not just blockers). */
export const REVIEW_REVISE_TRIGGER = 'any' as const;
/** Wall-clock bound (minutes) for a reviewer call — generous so large diffs are never silently dropped. */
export const REVIEW_TIMEOUT_MINUTES = 30;
/** Reviewer runs on the same model as the worker (cross-model is cursor-only, opt-in). */
export const REVIEW_MODEL = 'same' as const;

// ─── Cost / skills ───────────────────────────────────────────────────────────
/** Off: every enabled step runs on every story (no per-story down-sizing). */
export const ADAPTIVE_COST = 'off' as const;
/** SkillGenerator runs after every successful story. */
export const SKILL_GENERATION = 'on' as const;
/** Generated skills are operator-proposed by hand, never auto-PR'd. */
export const SKILL_AUTO_PROPOSE = 'off' as const;
/** Minimum judge score for SkillGenerator to accept a candidate (0-10). */
export const SKILL_JUDGE_MIN_SCORE = 6;

// ─── Planning / QA / intake ──────────────────────────────────────────────────
/** QA persona (Tessa) always writes a risk-based test_plan onto every story. */
export const QA_PLANNING = 'advisory' as const;
/** Intake classifier verdict is surfaced and injected as a sizing constraint. */
export const INTAKE_ROUTING = 'advisory' as const;
/** Wall-clock budget (ms) for the intake classifier call. */
export const INTAKE_TIMEOUT_MS = 120_000;
/** Brief-quality gate threshold (0-10); the gate is always on. */
export const MIN_BRIEF_QUALITY_SCORE = 6;

// ─── Integration / finalize ──────────────────────────────────────────────────
/** On gate failure, withhold the PR and flip the epic back to in_progress. */
export const INTEGRATION_GATE = 'block' as const;
/** Rolling integration branch: workers build on real prior code. */
export const INTEGRATION_BRANCH = 'rolling' as const;
/** Bounded integrator resolves merge-back conflicts (requires rolling). */
export const INTEGRATOR = 'on' as const;
/** Lag (commits) at which the integration branch warns it has drifted. */
export const INTEGRATION_BRANCH_LAG_THRESHOLD = 10;
/** Push + open the PR immediately after merge (no manual diff-preview gate). */
export const PUSH_GATE = 'off' as const;
/** No "Loom built this" attribution block on epic PRs. */
export const PR_ATTRIBUTION = 'off' as const;
/** One PR per epic. */
export const PR_STRATEGY = 'per-epic' as const;

// ─── Worker context / prompt ─────────────────────────────────────────────────
/** Worker prompts include .loom/guidance/<story-id>.md when present. */
export const OPERATOR_GUIDANCE = 'on' as const;
/** Architect emits an epic-wide shared implementation contract at plan time. */
export const SHARED_CONTRACT = 'on' as const;
/** Cross-story "what I built" notes are written and injected into dependents. */
export const CONTEXT_NOTES = 'on' as const;
/** Single-spawn worker pipeline (no implement/verify phase split). */
export const PHASES = 'off' as const;

// ─── Timeouts / liveness ─────────────────────────────────────────────────────
/** Kill a worker after this many minutes of ZERO output activity. */
export const STORY_STALL_MINUTES = 12;
/** Absolute per-story wall-clock cap (minutes). */
export const STORY_ABSOLUTE_CAP_MINUTES = 60;
/** Kill a worker whose LLM request hangs this many seconds with no stream activity. */
export const HUNG_REQUEST_SECONDS = 45;
/** Per-story budget of automatic clean-retries on a no-output stall. */
export const STALL_RECOVERY_BUDGET = 2;
/** Watchdog kills a worker that runs too long with zero edit-class calls. */
export const ANALYSIS_ONLY_WATCHDOG = 'on' as const;
/** Minutes after which a still-planning epic is flagged stale in `loom status`. */
export const STALE_PLANNING_MINUTES = 30;

// ─── Smoke ───────────────────────────────────────────────────────────────────
/** Wall-clock budget (minutes) for the post-finalize smoke command. */
export const SMOKE_TIMEOUT_MINUTES = 15;

// ─── Worktrees ───────────────────────────────────────────────────────────────
/** Prune done/merged worktrees at run end. */
export const PRUNE_ORPHAN_WORKTREES = 'on' as const;

// ─── Decomposition-aware orchestration (epic-095) ────────────────────────────
/** Signal a worker emits (on its own line in stdout) to request story re-split. */
export const LOOM_TOO_BIG_SIGNAL = 'LOOM_TOO_BIG' as const;
/** Max re-split attempts per story before the orchestrator gives up and blocks. */
export const MAX_RESPLIT_BUDGET = 2;

/**
 * Single source of truth for BOTH emitting and parsing the too-big signal, so the
 * worker-prompt instruction and the Supervisor's stdout capture can never drift
 * (they did once: the prompt said `LOOM_TOO_BIG: reason` but the parser matched
 * only the space form). Matches the keyword on its own line, optionally followed
 * by `:` and/or whitespace and a payload — and rejects `LOOM_TOO_BIGGER`. Returns
 * the trimmed payload (`''` when bare) or `undefined` when the line is not a signal.
 */
export function matchTooBigSignal(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === LOOM_TOO_BIG_SIGNAL) return '';
  const rest = trimmed.startsWith(LOOM_TOO_BIG_SIGNAL)
    ? trimmed.slice(LOOM_TOO_BIG_SIGNAL.length)
    : undefined;
  // A real signal is the keyword followed by a separator (`:` or whitespace),
  // never an alphanumeric/underscore continuation (which would be a longer word).
  if (rest === undefined || rest.length === 0 || !/^[\s:]/.test(rest)) return undefined;
  return rest.replace(/^[\s:]+/, '').trim();
}

/** The exact line a worker should emit; keeps prompt + parser in lockstep. */
export function formatTooBigSignal(reason: string): string {
  return `${LOOM_TOO_BIG_SIGNAL}: ${reason}`;
}

// ─── Cross-repo retrieval ────────────────────────────────────────────────────
/** Cross-repo read-only retrieval is always enabled. */
export const CROSS_REPO_ENABLED = true;
/** Max line window returned by a single cross-repo read. */
export const CROSS_REPO_MAX_LINE_WINDOW = 200;
/** Max file size (bytes) a cross-repo read will return. */
export const CROSS_REPO_MAX_FILE_BYTES = 262_144;
/** Max files returned by a single cross-repo search. */
export const CROSS_REPO_MAX_FILES = 20;
/** Max matches returned per file by a cross-repo search. */
export const CROSS_REPO_MAX_MATCHES_PER_FILE = 10;
