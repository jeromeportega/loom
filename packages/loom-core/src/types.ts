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
  /**
   * Number of review-driven revision cycles this agent attempt has completed.
   * Incremented by the block-and-revise loop at the start of each new revision
   * round; 0 until the first revision begins (added in schema v30).
   */
  revise_round: number;
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

export interface TestCommandEntry {
  name:    string;
  command: string;
  paths:   string[];
}

const TestCommandEntrySchema = z.object({
  name:    z.string().min(1),
  command: z.string().min(1),
  paths:   z.array(z.string().min(1)).min(1),
});

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
      allowed_read_root: z.string().default('.'),   // '.' = repo root, resolved relative to the worktree at hook time (not on init); on-by-default; independent of cross_repo.enabled
    })
    .default({}),
  agents: z
    .object({
      max_concurrent: z.number().int().min(1).default(5),
      // LLM backend for planning. Both are session-based (no API key, no API
      // billing) and use the developer's existing Claude Code or Cursor login.
      llm_backend: z.enum(['claude-cli', 'cursor-cli']).default('claude-cli'),
      // Worker backend: which agent runs story implementation.
      worker_backend: z.enum(['claude-code', 'cursor-cli']).default('claude-code'),
      model: z.string().default('claude-sonnet-4-6'),
      planning_model: z.string().default('claude-opus-4-7'),
      // Model id for the Cursor backend (Cursor uses its own ids, e.g. sonnet-4).
      cursor_model: z.string().default('sonnet-4'),
      skill_gen_model: z.string().default('claude-haiku-4-5-20251001'),
      // Explicit gate command. When unset, the gate auto-detects (npm test /
      // make test / pytest). loom never auto-installs deps, so if the suite
      // needs a fresh install encode it here, e.g. "npm ci && npm test".
      test_command: z.string().optional(),
      // Per-path test commands for polyglot repos. Each entry selects via
      // minimatch globs over changed file paths; only matching entries run.
      // Ignored when test_command is set (test_command takes precedence).
      test_commands: z.array(TestCommandEntrySchema).optional(),
      // Worker subprocess auth. 'inherit' (default) passes the parent env
      // through unchanged. 'session' strips ANTHROPIC_API_KEY /
      // ANTHROPIC_AUTH_TOKEN from the worker spawn so the CLI falls back to
      // the operator's `claude login` session — lets an outer agent run on
      // API credits while workers stay on the session (NEVER put the key
      // here; it lives in the outer agent's environment).
      worker_auth: z.enum(['inherit', 'session']).default('inherit'),
      // Smoke command for the post-finalize smoke gate (epic-079). When set,
      // EpicFinalizer runs this command on the integrated tree before opening
      // the PR. Unset = resolver auto-detects from package.json scripts.
      smoke_command: z.string().optional(),
      adversarial_review_model: z.string().optional(),
    })
    .default({}),
  mcp: z
    .object({
      // Path to an approved-MCP registry checkout (a directory of
      // servers/<name>/server.json). Unset = `loom mcp` is disabled.
      registry: z.string().optional(),
    })
    .default({}),
  // Absolute or ~-expandable path to the loom-home repository. Omit to use
  // the default sibling directory (parent of projectRoot + '/loom-home').
  loom_home: z.string().optional(),
  cross_repo: z
    .object({
      // Paths excluded from BOTH search results and reads (FR-7).
      // Security denylist — union-merged across layers (ADR-004).
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
}).strip();
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
  /** Registered manifest slug for the target repo; absent → resolves to the epic's primary repo. */
  repo: z.string().optional(),
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
  // Accepts both epic-NNN (regular) and story-NNN (standalone after story-059-002).
  epic_id: z.string().regex(/^(?:epic|story)-\d{3}$/),
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
