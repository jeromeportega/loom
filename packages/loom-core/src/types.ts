import { z } from 'zod';
import type { AttemptClass } from './orchestrator/resilience/types.js';

// ─── Autonomy ────────────────────────────────────────────────────────────────

export const AutonomyLevelSchema = z.enum(['full-auto', 'checkpoint', 'manual']);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

// ─── Standalone story container kind (v24, epic-047) ─────────────────────────

export const STANDALONE_KIND = 'standalone' as const;
export type EpicKind = 'epic' | 'standalone';

// ─── Agent / Epic Status ────────────────────────────────────────────────────

export const AgentStatusSchema = z.enum([
  'pending',
  'running',
  'blocked',
  'pr_open',
  'done',
  'failed',
  // Transient: the worker finished but the rolling integrator is folding the
  // story into epic/<id> (or auto-resolving a merge conflict). Set inside
  // integrateStory, cleared back to the prior terminal status on success or
  // 'blocked' on failure. Lets `loom_get_status` distinguish "still working"
  // from "truly done" during the 10-min integrator window.
  'integrating',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const EpicStatusSchema = z.enum([
  // Lifecycle order. `planning` is the new initial state: the planner has
  // started but Analyst / PM / Architect haven't all finished yet. The
  // epic appears in `loom web` immediately, with its planning_phase
  // updated as each persona completes. Status flips to `planned` when the
  // architect finishes and the epic structure is committed to the DB.
  'planning',
  'planned',
  'approved',
  'rejected',
  'in_progress',
  // The EpicFinalizer is folding the story branches into epic/<id>, running
  // the gate, and opening the epic PR. finalize_phase carries the live step.
  'finalizing',
  // Work complete but publish step remains (e.g. push was rejected, remote
  // disallowed, or PR-open failed). Recoverable, non-terminal. Resolved by
  // `loom publish <epic-id>`. DB-only — never a plan-time status.
  'publish_pending',
  // Terminal infra/runtime failure (finalize blew up, push was rejected, etc).
  // Distinct from the human 'rejected' verdict; `error` carries the message.
  // DB-only — not a plan-time status, so it stays out of EpicYamlSchema.
  'failed',
  'done',
]);
export type EpicStatus = z.infer<typeof EpicStatusSchema>;

/** Phase within the `planning` status — which persona is currently running. */
export type PlanningPhase = 'analyst' | 'pm' | 'architect';

/**
 * Phase within the `finalizing` status — which step of the EpicFinalizer is
 * live. A second overlay parallel to PlanningPhase (ADR-1): kept as its own
 * column/type rather than generalized so the PlanningPhase typing stays intact.
 */
export type FinalizePhase =
  | 'merging'
  | 'gate'
  | 'review'
  | 'pushing'
  | 'opening_pr';

export interface AgentRecord {
  id: string;
  epic_id: string;
  story_id: string;
  story_title: string | null;
  status: AgentStatus;
  worktree_path: string | null;
  branch_name: string | null;
  pr_url: string | null;
  log_tail: string | null;
  started_at: string | null;
  updated_at: string;
  /** OS pid of the running worker subprocess; null when not running. */
  worker_pid: number | null;
  /**
   * Outcome of the CodeReviewAgent pass for this story (Epic 18 story-018-002).
   * NULL = no review configured / not yet run. Surface to operators via
   * `loom status`, the pi dashboard, and the loom_get_status MCP response.
   */
  review_status: 'pending' | 'passed' | 'commented' | 'blocked' | 'skipped' | 'errored' | null;
  /** One-line review summary for status/dashboard rendering. */
  review_summary: string | null;
  /** Worker token usage parsed from claude --output-format stream-json (Epic 16). */
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cached: number | null;
  tokens_cache_creation: number | null;
  cost_usd: number | null;
  /**
   * Number of LLM requests this worker made. Counts every `complete()` call
   * for planning/review/skill paths; for worker spawns it's the count surfaced
   * by the CLI's JSON output (cursor-agent) or `1` per spawn when the CLI
   * exposes nothing. Cursor's organizational pricing is per-request, so this
   * — not cost_usd — is the meaningful spend signal for cursor-cli runs.
   */
  request_count: number | null;
  /**
   * How this agent's last attempt ended, on an axis orthogonal to `status`
   * (ADR-1, epic-006): 'infra_failure' (a transient environmental fault worth
   * an auto-retry), 'work_failure' (the agent ran and produced a real,
   * non-retryable outcome), or NULL (unclassified / not a failure). NOT a
   * status enum value — the sibling lifecycle epic owns `status`.
   */
  attempt_class: AttemptClass | null;
  /**
   * The model id the worker actually executed under, as reported by the
   * system/init stream event. NULL for rows created before v20 (never
   * backfilled — a plausible-but-wrong model is worse than unknown).
   */
  model: string | null;
  /**
   * Durable post-redaction byte length of the on-disk log file under
   * <loomdir>/logs/<story-id>.log. Equals file size at the last flushTails
   * write; NULL for rows predating v22. 0 when absent.
   */
  log_bytes: number | null;
}

export interface EpicRecord {
  id: string;
  title: string;
  status: EpicStatus;
  brief_path: string | null;
  prd_path: string | null;
  yaml_path: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  /** Planner token usage for the run that produced this epic. */
  planner_tokens_input: number | null;
  planner_tokens_output: number | null;
  planner_tokens_cached: number | null;
  /** Number of LLM requests the planning step made (Analyst+PM+Architect, plus
      shared_contract / qa_planning when enabled). Per-request signal for the
      cursor-cli backend whose org pricing is per-request, not per-token. */
  planner_request_count: number | null;
  /** Planner wall-clock time in milliseconds. */
  planner_ms: number | null;
  /**
   * SHA the epic's story branches diverged from — captured on first dispatch
   * so the EpicFinalizer can build `epic/<id>` from a stable base.
   */
  base_sha: string | null;
  /**
   * The user's original brief verbatim — what they typed into `loom epic`
   * or `loom_start_epic`. Captured at planner start so `loom web` can
   * show "what kicked off this job?" even before planning completes.
   */
  user_brief: string | null;
  /**
   * Which planning persona is currently running. Set when status='planning';
   * cleared (null) once status flips to 'planned'.
   */
  planning_phase: PlanningPhase | null;
  /**
   * Which finalize step is currently running. Set when status='finalizing';
   * cleared (null) on a terminal status. A second overlay parallel to
   * planning_phase (ADR-1) — mirror its nullability and read-mapping exactly.
   */
  finalize_phase: FinalizePhase | null;
  /**
   * The epic PR URL of record (distinct from agents.pr_url, which is per
   * story). Recorded by the finalizer and MUST be durable before any
   * status='done' write. NULL until the epic PR is opened.
   */
  epic_pr_url: string | null;
  /**
   * Runtime failure message — set iff status='failed' (an infra/runtime
   * failure, distinct from a human 'rejected' with its `reason`). NULL
   * otherwise.
   */
  error: string | null;
  /**
   * The full policy snapshot (JSON-stringified) captured at
   * `loom_approve_plan`. Lets the supervisor diff against the live
   * policy.yaml at finalize/integrate time so mid-run edits to late-bound
   * fields (allowed_remotes, test_command, integrator, etc.) actually take
   * effect — and so an `epic_policy_rebound` audit row records exactly what
   * changed. NULL for epics approved before this column existed.
   */
  policy_snapshot: string | null;
  /**
   * When set, the epic is archived: hidden from the default `loom status`,
   * web dashboard, and `loom_get_status` views, and skipped by supervisor
   * selection. NULL means active. Archiving is non-destructive — the row,
   * its agents, and its audit trail are all preserved.
   */
  archived_at: string | null;
  /** Autonomy level for this epic. DEFAULT 'manual' for all pre-v16 rows. */
  autonomy_level: AutonomyLevel;
  /** ISO8601 timestamp set when the epic is checkpoint-paused; null otherwise. */
  paused_at: string | null;
  /** The story_id after which the epic paused in checkpoint mode. */
  paused_after_story: string | null;
  /**
   * The finalizer-owned ref that was pushed (e.g. `loom/finalize/<id>-<sha>`).
   * Set by publishPending(); read by EpicPublisher to locate the branch for
   * `gh pr create`. NULL until the finalizer records a publish-pending transition.
   */
  finalize_ref: string | null;
  /**
   * Human-readable reason the publish step is pending (push rejected, remote
   * disallowed, PR-open failure, etc). Set alongside finalize_ref; NULL otherwise.
   */
  publish_note: string | null;
  /**
   * The resolved model id used by the planner (Analyst+PM+Architect). NULL for
   * epics created before v20 (never backfilled — additive-only per NFR-1).
   */
  planner_model: string | null;
  /**
   * Rolling tail of planning persona stdout, bounded to <= 4096 chars. Set
   * during planning and readable after planning completes. NULL until the
   * planner emits its first text chunk (or on pre-migration rows).
   */
  planning_log_tail: string | null;
  /**
   * JSON-serialised IntakeVerdict from `loom weave` classification. NULL for
   * all `loom epic` rows, pre-v23 rows, and any run where classification failed.
   * Never read by planning, gate, or execution code (NFR-1).
   */
  intake_verdict: string | null;
  /**
   * Container kind marker (v24, epic-047). NULL or 'epic' = normal epic;
   * 'standalone' = internal single-story container. Never compare inline
   * literals — import STANDALONE_KIND from types.ts instead.
   */
  kind?: EpicKind | null;
  /**
   * Loom-home artifact commit status (v25, epic-050). 'committed' means the
   * artifacts for this epic are committed to loom-home; 'pending' means the
   * commit failed and will be retried. NULL for pre-migration rows and epics
   * that have not yet been finalized.
   */
  loom_home_status: 'committed' | 'pending' | null;
  /** The commit SHA in loom-home where this epic's artifacts are stored. NULL until committed. */
  loom_home_sha: string | null;
}

export interface AuditLogEntry {
  id: number;
  agent_id: string | null;
  action: string;
  command: string | null;
  allowed: boolean | null;
  policy_rule: string | null;
  detail: string | null;
  timestamp: string;
}

// ─── Adaptive cost-control signals (epic: adaptive review) ───────────────────

export type SignalLevel = 'low' | 'medium' | 'high';
export type CostTier = 'light' | 'standard' | 'heavy';

/** Cheap pre-dispatch LLM rating of a story (B0). */
export interface TriageSignal {
  risk: SignalLevel;
  predicted_complexity: SignalLevel;
  rationale: string;
}

/** The worker's post-work self-rating (B1), parsed from its LOOM_SELF_ASSESSMENT marker. */
export interface SelfAssessment {
  confidence: SignalLevel;
  complexity: SignalLevel;
  note?: string;
}

/** Free, computed-from-state signals (B2). */
export interface HeuristicSignals {
  diff_lines: number;
  diff_files: number;
  /** null = unknown (no first-try test signal available). */
  tests_green_first_try: boolean | null;
  /** Changed files matching policy.agents.risky_paths. */
  risky_paths_touched: string[];
}

/** Per-story signal record persisted to the ledger and read back by the EpicFinalizer. */
export interface StorySignals {
  triage?: TriageSignal;
  self_assessment?: SelfAssessment;
  heuristics?: HeuristicSignals;
  tier: CostTier;
  /** What the tier actually gated — recorded so the epic review can audit the calls. */
  steps: { reviewers: number; verify_phase: boolean; skill_gen: boolean };
}

// ─── Policy Schema ──────────────────────────────────────────────────────────

export const PolicySchema = z.object({
  git: z
    .object({
      allowed_remotes: z.array(z.string()).default([]),
      protected_branches: z.array(z.string()).default(['main', 'master']),
      forbidden_flags: z
        .array(z.string())
        .default(['--force', '--force-with-lease', '--hard']),
      agents_must_use_pr: z.boolean().default(true),
    })
    .default({}),
  filesystem: z
    .object({
      protected_paths: z
        .array(z.string())
        .default([
          '~/.ssh',
          '~/.aws',
          '~/.gnupg',
          '/etc',
          '/usr',
          '/bin',
          '/sbin',
          '.git',
        ]),
      allowed_write_root: z.string().default('.'),
    })
    .default({}),
  agents: z
    .object({
      max_concurrent: z.number().int().min(1).max(10).default(5),
      worktree_isolation: z.boolean().default(true),
      require_human_pr_merge: z.boolean().default(true),
      // LLM backend for planning. Both are session-based (no API key, no API
      // billing) and use the developer's existing Claude Code or Cursor login.
      llm_backend: z.enum(['claude-cli', 'cursor-cli']).default('claude-cli'),
      // Worker backend: which agent runs story implementation.
      worker_backend: z.enum(['claude-code', 'cursor-cli']).default('claude-code'),
      // PR strategy: one PR per epic. The EpicFinalizer merges story
      // branches in dependency order onto epic/<id> and opens a single PR.
      // (Legacy per-story / both modes were removed from the user-facing
      // surface; only per-epic is accepted.)
      pr_strategy: z.enum(['per-epic']).default('per-epic'),
      model: z.string().default('claude-sonnet-4-6'),
      planning_model: z.string().default('claude-opus-4-7'),
      // Model id for the Cursor backend (Cursor uses its own ids, e.g. sonnet-4).
      cursor_model: z.string().default('sonnet-4'),
      skill_gen_model: z.string().default('claude-haiku-4-5-20251001'),
      budget_tokens_per_story: z.number().optional(),
      // Cost guard for the planning step (Analyst + PM + Architect). When set,
      // `loom epic` warns at the end of a planning run if total tokens
      // (input + output) exceeded this number.
      planning_token_budget: z.number().int().min(1).optional(),
      // Review strategy applied to every worker before it opens a PR
      // (Epic 18 story-018-002):
      //   'off'              — no review pass; the worker opens the PR immediately
      //   'comment'          — review runs and findings attach as a PR comment
      //   'block-and-revise' — blockers re-prompt the worker up to N times
      review_strategy: z
        .enum(['off', 'comment', 'block-and-revise'])
        .default('comment'),
      // Max worker revision passes under 'block-and-revise' before loom stops
      // re-prompting and marks the story blocked. Replaces the former hardcoded
      // cap of 2 — lower it to forcefully limit review cost, raise it to let a
      // worker keep self-correcting. 0 disables revision (review once, no
      // re-prompt). Ignored unless review_strategy='block-and-revise'.
      review_max_passes: z.number().int().min(0).default(2),
      // Adaptive cost control (epic: adaptive review). When 'on' (default), loom
      // sizes the expensive steps (reviewer count, verify-phase spawn, skill-gen)
      // per story from cheap signals — triage, the worker's self-assessment, and
      // heuristics — never EXCEEDING what the static flags above already allow
      // (the ceiling rule). 'off' = every enabled step runs on every story.
      adaptive_cost: z.enum(['on', 'off']).default('on'),
      // Cheap model for the per-story triage call (one call/story: risk +
      // complexity rating). Defaults to Haiku — triage is meta-work.
      triage_model: z.string().default('claude-haiku-4-5-20251001'),
      // Globs that force the heavy review tier when a story touches them,
      // regardless of confidence — a safety floor for sensitive surface area.
      risky_paths: z
        .array(z.string())
        .default([
          '**/auth/**',
          '**/migrations/**',
          '**/payment/**',
          '**/payments/**',
          '**/.github/workflows/**',
        ]),
      // Controls when SkillGenerator runs after a successful story:
      //   'on'      — every successful story (default)
      //   'off'     — never (cost-conscious teams)
      //   'sampled' — every Nth successful story (engine-tuned sample)
      skill_generation: z.enum(['on', 'off', 'sampled']).default('on'),
      // Auto-propose generated candidates to their target source repo via a
      // PR (#18 story-cloud-004). Default OFF — operator runs
      // `loom skills propose <name>` by hand.
      //   'off'     — never auto-propose. Operator-initiated only.
      //   'sampled' — auto-propose when a candidate clears the engine-tuned
      //               judge threshold AND we're under the per-epic cap.
      //   'always'  — every passing candidate gets a PR. No cap.
      skill_auto_propose: z.enum(['off', 'sampled', 'always']).default('off'),
      // PR attribution — prepend a "Loom built this" block to every epic
      // PR body so reviewers can tell loom generated it and inspect the
      // brief / planning chain. Default OFF — operators opt in per repo.
      // Honors the user's 2026-05-26 product-direction call (opt-in for now).
      pr_attribution: z.enum(['off', 'on']).default('off'),
      // Diff-preview gate. When 'confirm', EpicFinalizer stops at the local
      // merge — doesn't push, doesn't open the PR. Operator eyeballs the
      // diff (`git diff main..epic/<id>`) and runs the printed push +
      // gh pr create commands themselves. Default OFF (push immediately
      // after merge, the existing behavior).
      //
      // Use when you don't yet trust loom enough to land a PR unattended,
      // or when the diff is unusually large (django-11019-class — 458-line
      // patch with nobody between the worker and a public PR).
      push_gate: z.enum(['off', 'confirm']).default('off'),
      // Integration gate (PR 1 of the epic-quality plan). After the
      // EpicFinalizer merges every story branch onto epic/<id>, run the repo's
      // build/test suite on the INTEGRATED tree before opening the PR — the
      // objective check that a feature isn't broken once all its stories live
      // together. Also fails when a story was dropped by a merge conflict
      // (amputation), regardless of tests.
      //   off   — never run the gate (legacy behavior)
      //   warn  — run it; annotate the PR + audit on failure but still open the
      //           PR (default — non-blocking until an operator trusts it)
      //   block — run it; on failure leave epic/<id> local, skip the PR, and
      //           flip the epic back to in_progress for a fix-up run
      integration_gate: z.enum(['off', 'warn', 'block']).default('warn'),
      // Explicit gate command. When unset, the gate auto-detects (npm test /
      // make test / pytest). loom never auto-installs deps, so if the suite
      // needs a fresh install encode it here, e.g. "npm ci && npm test".
      test_command: z.string().optional(),
      // Rolling integration branch (PR 3a of the epic-quality plan). 'off'
      // (default) keeps today's topology: workers branch from their first
      // dependency and the EpicFinalizer big-bang-merges every story branch at
      // the end. 'rolling' creates epic/<id> up front, branches every worker
      // from its live tip, and merges each story back the moment it completes —
      // so parallel agents build on real prior code instead of colliding at
      // finalize. Only meaningful with pr_strategy='per-epic'; ignored (with a
      // warning) under 'per-story'. Off is byte-identical to the bench baseline.
      integration_branch: z.enum(['off', 'rolling']).default('off'),
      // Bounded integrator (PR 3b). When 'on' (and integration_branch='rolling'),
      // a story whose merge-back conflicts is handed to a bounded agent that
      // resolves the conflict markers in the integration worktree; loom then
      // commits the merge and re-runs the integration gate. The story is only
      // integrated on a green gate — otherwise the merge is rolled back and the
      // story falls through to the loud-block path (never a silent drop). 'off'
      // (default) keeps 3a behavior: a conflict blocks the story immediately.
      integrator: z.enum(['off', 'on']).default('off'),
      // Operator guidance side-channel. When 'on', the worker prompt
      // includes the contents of .loom/guidance/<story-id>.md when the
      // file exists, treating it as priority instructions from the
      // operator. Default OFF so the bench baseline is uncontaminated;
      // bench runs don't inject guidance anyway, but the flag keeps the
      // worker prompt template identical when off.
      //
      // The operator writes guidance via `loom guide <story-id> "..."`
      // (CLI) or loom_guide_agent (MCP). Both append to the same file
      // so the worker sees the layered history on the next revision /
      // dispatch.
      operator_guidance: z.enum(['off', 'on']).default('off'),
      // Architect shared-contract injection (PR 2 of the epic-quality plan).
      // When 'on', Winston emits an epic-wide implementation contract at plan
      // time — the shared interfaces/types parallel stories must agree on plus
      // a per-story file-ownership map — and every worker prompt for the epic
      // is prefixed with it so isolated agents stop inventing conflicting seams
      // and editing each other's files. Default flipped to 'on' in v0.5.0
      // after the multi-epic shared-client run, where sibling stories appending
      // to the same client.py file caused rolling-merge conflicts on every
      // epic with >2 stories. The contract's file-ownership map removes those
      // conflicts at the source; cost is one extra planning LLM call per run.
      shared_contract: z.enum(['off', 'on']).default('on'),
      // Cross-story context notes (PR 5 of the epic-quality plan). When 'on',
      // a "what I built" note is written to .loom/context/<story-id>.md when a
      // story succeeds (and integrates, under the rolling branch), and each
      // dependent worker's prompt is appended with its dependencies' notes — the
      // upstream decisions + files touched, in narrative form. Complements the
      // rolling branch (which carries the code) and the shared contract (the
      // plan-time interfaces). 'off' (default) writes nothing and keeps the
      // worker prompt byte-identical to the bench baseline.
      context_notes: z.enum(['off', 'on']).default('off'),
      // Epic-cumulative build-up context (epic-029). When 'on', completed-story
      // summaries and discovered conventions are injected into subsequent worker
      // prompts at dispatch time. 'off' (default) writes nothing and keeps the
      // worker prompt byte-identical to the bench baseline.
      epic_buildup: z.enum(['off', 'on']).default('off'),
      // QA test planning (PR 4 of the epic-quality plan). When 'advisory',
      // a QA persona (Tessa) runs after the Architect at plan time and writes
      // a concrete, risk-based test_plan onto every story — the test levels,
      // the happy/error/edge cases to cover, and the verification bar. Each
      // worker prompt then carries its story's plan so agents build tests-first
      // against an explicit definition of "verified" instead of guessing.
      // 'off' (default) skips the extra planning call AND the injection,
      // keeping the worker prompt byte-identical to the bench baseline.
      qa_planning: z.enum(['off', 'advisory']).default('off'),
      // Cross-model review (#20). When 'cross', the reviewer
      // (block-and-revise / comment) runs through a DIFFERENT model than
      // the worker — same-session via Cursor CLI's multi-model targeting,
      // so the session-only constraint stays intact. 'same' (default)
      // keeps today's behavior of reviewer == worker LLM.
      //
      // Methodology: this is a real intervention hypothesis. Its impact
      // on resolution rate has to clear the Gate 3 promote rule (tuning
      // improves, ≤1 regression, holdout doesn't drop) before going on
      // by default. Until then operators opt in.
      review_model: z.enum(['same', 'cross']).default('same'),
      // Model id for cross-model review. Required when review_model='cross'.
      // No MAX mode — pass a specific model id per
      // [[feedback-cross-model-review-cursor-only]].
      review_model_id: z.string().optional(),
      // Wall-clock bound for the CodeReviewAgent's claude/cursor-cli call.
      // The default 10 min was a hardcoded ClaudeCliClient timeout that
      // silently dropped large-story reviews (story-007-003 in the multi-
      // epic shared-client run shipped unreviewed because of this). Default
      // 10 keeps prior behavior; raise it for repos with sizable diffs.
      review_timeout_minutes: z.number().int().min(1).max(60).default(10),
      // Wall-clock budget for the intake classifier call (`classifyIntake`).
      // Raised from the old 20s cap to accommodate the session-subprocess
      // backend's real ~100s latency. The call is best-effort and off the
      // critical path — a hung call burns up to this budget before failing.
      intake_timeout_ms: z.number().int().min(1000).default(120_000),
      // Intake-routing mode. Controls whether the classifier verdict influences
      // how the PM agent sizes the work:
      //   'off'     — classifier runs observe-only; verdict recorded but never
      //               reaches PlannerOptions. Planning path byte-identical to
      //               today. (default)
      //   'advisory' — verdict surfaced and injected as a sizing constraint
      //               into the PM prompt; operator not asked to confirm.
      //   'confirm'  — operator prompted to accept/override the verdict before
      //               the PM prompt is built; degrades to advisory on non-TTY.
      intake_routing: z.enum(['off', 'advisory', 'confirm']).default('off'),
      // Brief-quality gate. Every `loom epic` and `loom_start_epic` runs
      // the BriefRefiner before the planner and refuses briefs whose
      // quality_score is below this threshold, returning the critique so
      // the operator can tighten the prompt before paying the planner.
      // Threshold is tunable per repo (0–10). Setting 0 effectively
      // disables the gate (since BriefRefiner saturates at 0 on its
      // floor), which is what the SWE-bench harness wants — the
      // refiner over-critiques GitHub-issue-shaped briefs and the bench
      // is meant to measure planner+worker quality, not refiner
      // judgement. Default 6 keeps real-user behaviour unchanged.
      min_brief_quality_score: z.number().int().min(0).max(10).default(6),
      // Severity threshold that triggers a block-and-revise revision.
      // - 'blockers' (default, baseline): only blocker-severity findings
      //   re-prompt the worker. Non-blocker findings attach as comments.
      // - 'any': any non-empty review finding re-prompts. Use when a
      //   cross-model reviewer (or generally a smarter reviewer) is
      //   surfacing correctness concerns at comment severity that the
      //   pipeline ought to act on. Bounded by review_max_revisions so
      //   "any" can't soft-lock.
      //
      // Run 10b finding: cross-model review identified a read-path
      // near-miss but logged it as a comment, so block-and-revise didn't
      // trigger. 'any' is the lever that lets the pipeline act on those.
      review_revise_trigger: z.enum(['blockers', 'any']).default('blockers'),
      // Worker-watchdog — kills a worker that goes too long with zero
      // Edit/Write/MultiEdit calls (the analysis-only failure mode that
      // produces empty patches in bench runs and "handoff died" reports
      // in real use). Default OFF — bench baseline preserved.
      //
      // When 'on', the supervisor monitors decision_traces live for
      // edit-class calls. After analysis_only_watchdog_warn_sec with
      // zero edits, emits a worker_watchdog_warn audit row. After
      // analysis_only_watchdog_kill_sec with zero edits, SIGTERMs the
      // worker and marks the story failed with reason
      // 'analysis-only-watchdog' (audit-logged).
      //
      // Suggested timings: warn at 600s (10 min), kill at 1200s
      // (20 min). The thresholds are wallclock from worker start, not
      // tool-call count.
      analysis_only_watchdog: z.enum(['off', 'on']).default('off'),
      // Story timeout budget (progress-aware). The worker is killed after
      // `story_stall_minutes` of ZERO output activity (genuinely stuck — resets
      // on any stdout/stderr) OR after `story_absolute_cap_minutes` total
      // regardless. Per-complexity scaling lives in the source (engineer-tuned).
      story_stall_minutes: z.number().int().min(1).default(12),
      story_absolute_cap_minutes: z.number().int().min(1).default(60),
      // Tighter liveness bound (epic-030). After a worker emits
      // `system/status status=requesting` with no subsequent stream activity for
      // this many SECONDS, the guard concludes the LLM call has hung and kills
      // the worker. 0 disables the check (today's behavior). Distinct unit from
      // the minute-based stall/cap knobs above — intentionally kept in seconds
      // for a finer-grained, sub-minute threshold.
      hung_request_seconds: z.number().int().min(0).default(45),
      // Per-story automatic-resume cap (epic-030). When a worker is killed by the
      // stall or hung-request guard AND it left a checkpoint commit, the
      // supervisor auto-resumes it up to this many times within one `loom run`.
      // 0 disables auto-resume (today's behavior). Volatile: counted per run,
      // not persisted to the DB.
      auto_resume_attempts: z.number().int().min(0).default(2),
      // Phased worker pipeline. When 'on', a story runs as discrete agent
      // spawns — implement, then verify (full build/test suite) — each with
      // its OWN fresh stall/cap timer and a checkpoint commit + handoff
      // refresh at the boundary. This lets a long-but-productive story survive
      // by giving each phase a clean budget instead of one shared wall-clock,
      // and makes a crash mid-verify resumable from the committed implement
      // work. Default 'off' keeps the single-spawn bench baseline.
      phases: z.enum(['off', 'on']).default('off'),
      // Worker subprocess auth. 'inherit' (default) passes the parent env
      // through unchanged. 'session' strips ANTHROPIC_API_KEY /
      // ANTHROPIC_AUTH_TOKEN from the worker spawn so the CLI falls back to
      // the operator's `claude login` session — lets an outer agent run on
      // API credits while workers stay on the session (NEVER put the key
      // here; it lives in the outer agent's environment).
      worker_auth: z.enum(['inherit', 'session']).default('inherit'),
    })
    .default({}),
  mcp: z
    .object({
      // Path to an approved-MCP registry checkout (a directory of
      // servers/<name>/server.json). Unset = `loom mcp` is disabled.
      registry: z.string().optional(),
    })
    .default({}),
  cross_repo: z
    .object({
      // Opt-in; single-repo workspaces never enter the cross-repo path.
      enabled: z.boolean().default(false),
      bounds: z
        .object({
          max_line_window: z.number().int().min(1).default(200),
          max_file_bytes: z.number().int().min(1).default(262144),
          max_files: z.number().int().min(1).default(20),
          max_matches_per_file: z.number().int().min(1).default(10),
        })
        .default({}),
      secret_globs: z
        .array(z.string())
        .default([
          '**/.env',
          '**/.env.*',
          '**/*.pem',
          '**/*.key',
          '**/id_rsa*',
          '**/secrets/**',
          '**/*.tfstate',
        ]),
    })
    .default({}),
  // Absolute or ~-expandable path to the loom-home repository. Omit to use
  // the default sibling directory (parent of projectRoot + '/loom-home').
  loom_home: z.string().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

// ─── Policy check result ────────────────────────────────────────────────────

export interface PolicyCheckResult {
  allowed: boolean;
  rule?: string;
  reason?: string;
}

// ─── MCP tool response shapes ───────────────────────────────────────────────

export interface StatusTree {
  epics: Array<{
    id: string;
    title: string;
    status: string;
    stories: Array<{
      id: string;
      title: string;
      status: string;
      pr_url?: string;
      started_at?: string;
      review_status?: 'pending' | 'passed' | 'commented' | 'blocked' | 'skipped' | 'errored';
      review_summary?: string;
    }>;
  }>;
}

// ─── Epic/Story YAML schema ─────────────────────────────────────────────────

export const StorySchema = z.object({
  id: z.string().regex(/^story-\d{3}(-\d{3})?$/),
  title: z.string().min(5).max(100),
  description: z.string(),
  acceptance_criteria: z.array(z.string()).min(1),
  estimated_complexity: z.enum(['trivial', 'small', 'medium', 'large']),
  dependencies: z.array(z.string()),
  tech_notes: z.string().optional(),
  test_plan: z.string().optional(),
  /**
   * Optional reference image paths for this story. Reserved field; not
   * populated today.
   */
  images: z.array(z.string()).optional(),
  /**
   * Machine-readable provenance for dependency edges added by the same-file
   * conflict serializer. Each entry corresponds to an entry in `dependencies`
   * and records WHY that edge was derived. Optional — existing plans that
   * predate serialization parse successfully without it (ADR-002, NFR-2).
   */
  dependency_reasons: z
    .array(
      z.object({
        depends_on: z.string(),
        reason: z.literal('same-file-conflict-avoidance'),
        path: z.string().optional(),
      })
    )
    .optional(),
});
export type Story = z.infer<typeof StorySchema>;

export const EpicYamlSchema = z.object({
  epic_id: z.string().regex(/^epic-\d{3}$/),
  title: z.string().min(5).max(100),
  // Plan-time status. The DB epics table is the source of truth for runtime
  // status; this field defaults to 'planned' when the PM agent omits it.
  status: z
    .enum(['planned', 'approved', 'in_progress', 'done', 'rejected'])
    .default('planned'),
  priority: z.enum(['must-have', 'should-have', 'nice-to-have']),
  prd_ref: z.string(),
  requirements: z.array(z.string()),
  stories: z.array(StorySchema).min(1),
});
export type EpicYaml = z.infer<typeof EpicYamlSchema>;
