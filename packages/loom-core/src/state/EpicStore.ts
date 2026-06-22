import Database from 'better-sqlite3';
import type {
  AutonomyLevel,
  EpicRecord,
  EpicStatus,
  FinalizePhase,
  PlanningPhase,
} from '../types.js';
import { AutonomyLevelSchema, STANDALONE_KIND } from '../types.js';
import { LIVE_TAIL_CHARS } from '../planner/constants.js';
import {
  IntakeVerdictSchema,
  type IntakeVerdict,
} from '../intake/IntakeClassifier.js';

export class EpicStore {
  constructor(private db: Database.Database) {}

  create(id: string, title: string, yamlPath?: string): EpicRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO epics (id, title, status, yaml_path, created_at, updated_at)
         VALUES (?, ?, 'planned', ?, ?, ?)`
      )
      .run(id, title, yamlPath ?? null, now, now);
    return this.get(id)!;
  }

  /**
   * Inserts an internal container row for a standalone story (v24, epic-047).
   * The row has kind='standalone' so list() and presentation sites can exclude
   * or render it separately. The FK agents.epic_id points to this container id,
   * keeping the agents schema unchanged (ADR-002).
   */
  createStandalone(epicId: string, title: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO epics (id, title, status, kind, created_at, updated_at)
         VALUES (?, ?, 'planned', ?, ?, ?)`
      )
      .run(epicId, title, STANDALONE_KIND, now, now);
  }

  /** Returns true iff the given epic row is a standalone story container. */
  isStandalone(epicId: string): boolean {
    const row = this.db
      .prepare('SELECT kind FROM epics WHERE id = ?')
      .get(epicId) as { kind: string | null } | undefined;
    return row?.kind === STANDALONE_KIND;
  }

  /**
   * Reserves an epic row at the START of planning so `loom web` can show
   * "what kicked off this job?" before Analyst → PM → Architect finishes.
   * Stores the user's original brief and sets status='planning' / phase='analyst'.
   * The placeholder is updated through the phases and finally flipped to
   * 'planned' once the architect commits the epic structure.
   */
  beginPlanning(id: string, userBrief: string): EpicRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO epics
           (id, title, status, planning_phase, user_brief, created_at, updated_at)
         VALUES (?, '(planning…)', 'planning', 'analyst', ?, ?, ?)`
      )
      .run(id, userBrief, now, now);
    return this.get(id)!;
  }

  /**
   * Writes a title onto the reserved row WITHOUT touching status or phase.
   * Used by `runEpic` to replace the `(planning…)` placeholder with a derived
   * title (first Markdown heading, else the brief's first 60 chars) the instant
   * the epic is reserved — so `loom status` shows something meaningful before
   * the planner produces the real title. The real title replaces this later via
   * `completePlanning`.
   */
  setTitle(id: string, title: string): void {
    this.db
      .prepare(`UPDATE epics SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, new Date().toISOString(), id);
  }

  /** Advances the planning_phase marker; status stays 'planning'. */
  updatePlanningPhase(id: string, phase: PlanningPhase): void {
    this.db
      .prepare(
        `UPDATE epics SET planning_phase = ?, updated_at = ? WHERE id = ?`
      )
      .run(phase, new Date().toISOString(), id);
  }

  /** Marks planning complete — clears phase, optionally updates title. */
  completePlanning(id: string, title?: string): void {
    const now = new Date().toISOString();
    if (title !== undefined) {
      this.db
        .prepare(
          `UPDATE epics SET status = 'planned', planning_phase = NULL,
                            title = ?, updated_at = ? WHERE id = ?`
        )
        .run(title, now, id);
    } else {
      this.db
        .prepare(
          `UPDATE epics SET status = 'planned', planning_phase = NULL,
                            updated_at = ? WHERE id = ?`
        )
        .run(now, id);
    }
  }

  get(id: string): EpicRecord | undefined {
    return this.db
      .prepare('SELECT * FROM epics WHERE id = ?')
      .get(id) as EpicRecord | undefined;
  }

  /**
   * Lists epics newest-first. Archived and standalone-container rows are
   * EXCLUDED by default so the status / web / MCP views stay scoped to the
   * runs an operator still cares about. Pass opts to override:
   * - `{ includeArchived: true }` — include archived epics
   * - `{ includeStandalone: true }` — include kind='standalone' containers
   */
  list(opts?: { includeArchived?: boolean; includeStandalone?: boolean }): EpicRecord[] {
    const clauses: string[] = [];
    if (!opts?.includeArchived) clauses.push('archived_at IS NULL');
    if (!opts?.includeStandalone) clauses.push(`(kind IS NULL OR kind != '${STANDALONE_KIND}')`);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM epics ${where} ORDER BY created_at DESC`)
      .all() as EpicRecord[];
  }

  /** Only archived epics, newest-first. Powers the dedicated archive view. */
  listArchived(): EpicRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM epics WHERE archived_at IS NOT NULL ORDER BY created_at DESC'
      )
      .all() as EpicRecord[];
  }

  /**
   * Epics in a given status, newest-first. Archived epics are excluded by
   * default — this keeps the supervisor (which selects `approved` /
   * `in_progress` epics to dispatch) and the approval gate from acting on a
   * run the operator has archived.
   */
  listByStatus(
    status: EpicStatus,
    opts?: { includeArchived?: boolean }
  ): EpicRecord[] {
    const archivedClause = opts?.includeArchived ? '' : 'AND archived_at IS NULL';
    return this.db
      .prepare(
        `SELECT * FROM epics WHERE status = ? ${archivedClause} ORDER BY created_at DESC`
      )
      .all(status) as EpicRecord[];
  }

  /** Marks an epic archived (idempotent). Returns false if the epic is unknown. */
  archive(id: string): boolean {
    // Single timestamp for both columns — archived_at and updated_at name the
    // same instant, so two `new Date()` calls (submillisecond apart) made the
    // audit trail confusing for no benefit.
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE epics SET archived_at = ?, updated_at = ?
         WHERE id = ? AND archived_at IS NULL`
      )
      .run(now, now, id);
    if (info.changes > 0) return true;
    // Already archived (or unknown) — distinguish so callers can report noop
    // vs not-found.
    return this.get(id) !== undefined;
  }

  /** Clears the archived flag (idempotent). Returns false if the epic is unknown. */
  unarchive(id: string): boolean {
    this.db
      .prepare(
        `UPDATE epics SET archived_at = NULL, updated_at = ? WHERE id = ?`
      )
      .run(new Date().toISOString(), id);
    return this.get(id) !== undefined;
  }

  updateStatus(id: string, status: EpicStatus, reason?: string): void {
    this.db
      .prepare(
        `UPDATE epics SET status = ?, reason = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, reason ?? null, new Date().toISOString(), id);
  }

  updatePaths(
    id: string,
    paths: Partial<Pick<EpicRecord, 'brief_path' | 'prd_path' | 'yaml_path'>>
  ): void {
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];
    if (paths.brief_path !== undefined) {
      fields.push('brief_path = ?');
      values.push(paths.brief_path);
    }
    if (paths.prd_path !== undefined) {
      fields.push('prd_path = ?');
      values.push(paths.prd_path);
    }
    if (paths.yaml_path !== undefined) {
      fields.push('yaml_path = ?');
      values.push(paths.yaml_path);
    }
    values.push(id);
    this.db.prepare(`UPDATE epics SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Records the SHA the epic's story branches diverged from. Captured by the
   * Supervisor on the first dispatch for an epic; the EpicFinalizer reads it
   * to build `epic/<epic-id>` from a stable base.
   */
  updateBaseSha(id: string, sha: string): void {
    this.db
      .prepare('UPDATE epics SET base_sha = ?, updated_at = ? WHERE id = ?')
      .run(sha, new Date().toISOString(), id);
  }

  /**
   * Records planner token usage and wall-clock time for the run that produced
   * this epic. When a run produces multiple epics, the same totals are stored
   * on each — aggregate by run-id later if you need to dedupe.
   */
  updateTokens(
    id: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      requestCount?: number;
    },
    durationMs: number
  ): void {
    this.db
      .prepare(
        `UPDATE epics
         SET planner_tokens_input = ?, planner_tokens_output = ?,
             planner_tokens_cached = ?, planner_request_count = ?,
             planner_ms = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.requestCount ?? null,
        durationMs,
        new Date().toISOString(),
        id
      );
  }

  /**
   * Persists the policy snapshot taken at `loom_approve_plan` so the
   * supervisor can diff it against the live policy.yaml at finalize/
   * integrate time. Mid-run edits to late-bound fields (allowed_remotes,
   * test_command, integrator, etc.) actually take effect, and an
   * `epic_policy_rebound` audit row records exactly what changed.
   */
  setPolicySnapshot(id: string, snapshotJson: string): void {
    this.db
      .prepare(
        `UPDATE epics SET policy_snapshot = ?, updated_at = ? WHERE id = ?`
      )
      .run(snapshotJson, new Date().toISOString(), id);
  }

  /**
   * Enters the finalize overlay: status='finalizing' with the live phase set.
   * Parallel to beginPlanning — the finalize overlay (ADR-1) mirrors the
   * planning overlay rather than sharing one generic phase column.
   */
  beginFinalizing(id: string, phase: FinalizePhase): void {
    this.db
      .prepare(
        `UPDATE epics SET status = 'finalizing', finalize_phase = ?,
                          updated_at = ? WHERE id = ?`
      )
      .run(phase, new Date().toISOString(), id);
  }

  /** Advances the finalize_phase marker; status stays 'finalizing'. */
  updateFinalizePhase(id: string, phase: FinalizePhase): void {
    this.db
      .prepare(
        `UPDATE epics SET finalize_phase = ?, updated_at = ? WHERE id = ?`
      )
      .run(phase, new Date().toISOString(), id);
  }

  /**
   * Sets finalize_phase = NULL without touching status. Needed for the ordered
   * reconcile write — updateFinalizePhase() only sets a non-null phase; fail()/reject()
   * clear it but also change status.
   */
  clearFinalizePhase(id: string): void {
    this.db
      .prepare(`UPDATE epics SET finalize_phase = NULL, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /**
   * Persists the epic PR URL of record. MUST be durable before any
   * status='done' write — the Supervisor gates `done` on this column.
   */
  recordPrUrl(id: string, url: string): void {
    this.db
      .prepare(`UPDATE epics SET epic_pr_url = ?, updated_at = ? WHERE id = ?`)
      .run(url, new Date().toISOString(), id);
  }

  /**
   * Terminal infra/runtime failure: status='failed', store the error message,
   * and clear finalize_phase (the run is no longer in flight). Distinct from a
   * human 'rejected' verdict.
   */
  fail(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE epics SET status = 'failed', error = ?, finalize_phase = NULL,
                          updated_at = ? WHERE id = ?`
      )
      .run(error, new Date().toISOString(), id);
  }

  /**
   * Clean terminal state for a brief-gate rejection: status='rejected' with the
   * machine verdict written to the `error` column, NOT `reason`. A human reject
   * (`updateStatus(id, 'rejected', reason)`) sets `reason` and leaves `error`
   * null; this gate reject inverts that — `error` carries the non-human verdict
   * and `reason` stays null. Both share the 'rejected' status (no schema
   * migration during the freeze), so the error-vs-reason split is the ONLY
   * signal that distinguishes a quality-gate verdict from an operator decision.
   * Keep them apart — don't collapse the verdict into `reason`.
   */
  reject(id: string, verdict: string): void {
    this.db
      .prepare(
        `UPDATE epics SET status = 'rejected', reason = NULL, error = ?,
                          planning_phase = NULL, updated_at = ? WHERE id = ?`
      )
      .run(verdict, new Date().toISOString(), id);
  }

  // ─── Autonomy / checkpoint-pause (v16, epic-003 story-003-001) ────────────

  getAutonomy(id: string): AutonomyLevel {
    const row = this.db
      .prepare('SELECT autonomy_level FROM epics WHERE id = ?')
      .get(id) as { autonomy_level: string } | undefined;
    return AutonomyLevelSchema.parse(row?.autonomy_level ?? 'manual');
  }

  setAutonomy(id: string, level: AutonomyLevel): void {
    this.db
      .prepare('UPDATE epics SET autonomy_level = ?, updated_at = ? WHERE id = ?')
      .run(level, new Date().toISOString(), id);
  }

  /** Sets paused_at to the current timestamp and records which story triggered the pause. */
  pauseAfterStory(id: string, storyId: string): void {
    this.db
      .prepare(
        `UPDATE epics SET paused_at = CURRENT_TIMESTAMP, paused_after_story = ?,
                          updated_at = ? WHERE id = ?`
      )
      .run(storyId, new Date().toISOString(), id);
  }

  /** Clears both paused_at and paused_after_story so the epic can continue dispatching. */
  resume(id: string): void {
    this.db
      .prepare(
        `UPDATE epics SET paused_at = NULL, paused_after_story = NULL,
                          updated_at = ? WHERE id = ?`
      )
      .run(new Date().toISOString(), id);
  }

  isPaused(id: string): boolean {
    const row = this.db
      .prepare('SELECT paused_at FROM epics WHERE id = ?')
      .get(id) as { paused_at: string | null } | undefined;
    return row?.paused_at != null;
  }

  /**
   * Stamps `proposed_by='loom'` on the epic row. Called by proposeNextEpic
   * after the planner produces a planned epic so the inbox + dashboard can
   * distinguish loom-initiated proposals from human-submitted plans.
   * NULL = human-initiated (the default, no backfill needed).
   */
  setProposedBy(epicId: string, proposedBy: 'loom'): void {
    this.db
      .prepare('UPDATE epics SET proposed_by = ?, updated_at = ? WHERE id = ?')
      .run(proposedBy, new Date().toISOString(), epicId);
  }

  // ─── Publish-pending lifecycle (v19, epic-005 story-005-002) ─────────────

  /**
   * Transitions the epic to the recoverable `publish_pending` state after the
   * finalizer successfully pushed the branch but the PR step failed. Mirrors the
   * shape of `fail()` and `recordPrUrl()` — one atomic write covering the status
   * change, the finalizer-owned ref, and the human-readable reason. The
   * finalize_phase overlay is cleared because the finalize run is no longer
   * in flight; it will be resolved by `loom publish`.
   *
   * Called exclusively by the EpicFinalizer; never triggered by migration.
   */
  publishPending(id: string, finalizeRef: string, note: string): void {
    this.db
      .prepare(
        `UPDATE epics SET status = 'publish_pending', finalize_ref = ?,
                          publish_note = ?, finalize_phase = NULL,
                          updated_at = ? WHERE id = ?`
      )
      .run(finalizeRef, note, new Date().toISOString(), id);
  }

  /**
   * Records the finalizer-owned ref alone, without changing status. Used when
   * the finalizer pushes the branch and needs to persist the ref before
   * attempting to open the PR (so the ref is durable even if the PR step
   * fails and triggers a `publishPending` write).
   */
  recordFinalizeRef(id: string, ref: string): void {
    this.db
      .prepare('UPDATE epics SET finalize_ref = ?, updated_at = ? WHERE id = ?')
      .run(ref, new Date().toISOString(), id);
  }

  /**
   * Records the resolved planning model for this epic (epic-013). Called once
   * after the planner run completes. NULL for pre-v20 rows — never backfilled.
   */
  setPlannerModel(epicId: string, model: string): void {
    this.db
      .prepare('UPDATE epics SET planner_model = ?, updated_at = ? WHERE id = ?')
      .run(model, new Date().toISOString(), epicId);
  }

  /**
   * Persists the rolling planning-output tail (bounded to <=4096 chars,
   * matching PlanningOutputSink.LIVE_TAIL_CHARS). The defensive slice here
   * guards against direct callers (tests, future CLI commands) that bypass
   * the sink's own cap (ADR-005).
   */
  updatePlanningLogTail(id: string, logTail: string): void {
    const bounded = logTail.length > LIVE_TAIL_CHARS ? logTail.slice(-LIVE_TAIL_CHARS) : logTail;
    this.db
      .prepare(
        `UPDATE epics SET planning_log_tail = ?, updated_at = ? WHERE id = ?`
      )
      .run(bounded, new Date().toISOString(), id);
  }

  // ─── Intake verdict (v23, epic-020 story-020-003) ─────────────────────────

  /**
   * Persists a validated intake verdict on the epic row as JSON TEXT. Called
   * only after classifyIntake succeeds — never on failure (NULL is the
   * canonical "no verdict" state for pre-existing rows and failed runs).
   */
  recordIntakeVerdict(id: string, verdict: IntakeVerdict): void {
    this.db
      .prepare('UPDATE epics SET intake_verdict = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(verdict), new Date().toISOString(), id);
  }

  /**
   * Returns the stored intake verdict for an epic, or null if absent.
   * Re-validates via zod on read so corrupt/garbage JSON degrades to null
   * rather than a default or fabricated class.
   */
  getIntakeVerdict(id: string): IntakeVerdict | null {
    const row = this.db
      .prepare('SELECT intake_verdict FROM epics WHERE id = ?')
      .get(id) as { intake_verdict: string | null } | undefined;
    if (!row || row.intake_verdict === null) return null;
    try {
      const raw = JSON.parse(row.intake_verdict);
      const parsed = IntakeVerdictSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetches intake verdicts for multiple epics in a single query.
   * Returns a Map from epic id to verdict (or null). IDs not found in the
   * database are absent from the Map — callers should treat missing keys as null.
   */
  getIntakeVerdicts(ids: string[]): Map<string, IntakeVerdict | null> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, intake_verdict FROM epics WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string; intake_verdict: string | null }[];
    const out = new Map<string, IntakeVerdict | null>();
    for (const row of rows) {
      if (row.intake_verdict === null) {
        out.set(row.id, null);
        continue;
      }
      try {
        const raw = JSON.parse(row.intake_verdict);
        const parsed = IntakeVerdictSchema.safeParse(raw);
        out.set(row.id, parsed.success ? parsed.data : null);
      } catch {
        out.set(row.id, null);
      }
    }
    return out;
  }
}
