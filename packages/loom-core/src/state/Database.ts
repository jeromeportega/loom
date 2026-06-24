import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export const SCHEMA_VERSION = 27;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS epics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  brief_path TEXT,
  prd_path TEXT,
  yaml_path TEXT,
  reason TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  planner_tokens_input INTEGER,
  planner_tokens_output INTEGER,
  planner_tokens_cached INTEGER,
  planner_ms INTEGER,
  base_sha TEXT,
  archived_at DATETIME
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL REFERENCES epics(id),
  story_id TEXT NOT NULL,
  story_title TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  worktree_path TEXT,
  branch_name TEXT,
  pr_url TEXT,
  log_tail TEXT,
  started_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  worker_pid INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT REFERENCES agents(id),
  action TEXT NOT NULL,
  command TEXT,
  allowed INTEGER,
  policy_rule TEXT,
  detail TEXT,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- v3: skill provenance — which skill was injected into which story, and the outcome.
CREATE TABLE IF NOT EXISTS skill_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  outcome TEXT,
  injected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- v5: a single-row control table — lets "loom stop" signal a running supervisor.
CREATE TABLE IF NOT EXISTS loom_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT 'running'
);

-- v13: per-epic supervisor lease. Prevents two supervisors (e.g. an MCP
-- in-process dispatch and a "loom run" subprocess, or a retry racing a live
-- run) from dispatching the same epic's stories into the idempotent worktrees
-- concurrently. A lease is "live" while its heartbeat is recent; a stale lease
-- (crashed supervisor) is reclaimable.
CREATE TABLE IF NOT EXISTS loom_lease (
  epic_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  pid INTEGER NOT NULL,
  hostname TEXT,
  acquired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- v4: eval runs — one row per "loom eval" invocation, for drift detection.
CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite TEXT NOT NULL,
  score REAL NOT NULL,
  passed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  ran_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS audit_log_fts USING fts5(
  command,
  action,
  content=audit_log,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS audit_log_ai AFTER INSERT ON audit_log BEGIN
  INSERT INTO audit_log_fts(rowid, command, action)
  VALUES (new.id, new.command, new.action);
END;

-- v11: decision_traces — first-class capture of agent reasoning. The
-- audit_log records WHAT an agent did; this table records WHY. Populated
-- by the worker's stream-json parser when claude emits thinking blocks.
-- See docs/architecture/decision-traces.md.
CREATE TABLE IF NOT EXISTS decision_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  epic_id TEXT,
  story_id TEXT,
  kind TEXT NOT NULL,
  subject TEXT,
  rationale TEXT NOT NULL,
  metadata TEXT,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_decision_traces_agent ON decision_traces(agent_id);
CREATE INDEX IF NOT EXISTS idx_decision_traces_story ON decision_traces(story_id);

-- v17: signals — scanner-emitted work items with UPSERT-on-key dedup semantics.
-- Rows are never deleted (ADR-004); stale status marks un-re-observed signals.
CREATE TABLE IF NOT EXISTS signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL UNIQUE,
  source       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  evidence_url TEXT,
  weight       REAL NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'open',
  first_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata     TEXT
);

CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source);

-- v17: opportunities — LLM-clustered signal groups ranked by score.
-- scoped_epic_id set when an operator promotes an opportunity to a planned epic.
-- Rows are never deleted (ADR-004); status tracks open/scoped/dismissed lifecycle.
CREATE TABLE IF NOT EXISTS opportunities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  impact          REAL NOT NULL,
  effort          REAL NOT NULL,
  confidence      REAL NOT NULL,
  score           REAL NOT NULL,
  rank            INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  signal_count    INTEGER NOT NULL DEFAULT 0,
  member_keys     TEXT NOT NULL DEFAULT '[]',
  evidence        TEXT NOT NULL DEFAULT '[]',
  scoped_epic_id  TEXT REFERENCES epics(id),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- v18: lessons — extracted learnings from epic retrospectives, persisted for
-- reuse as worker guidance and policy suggestions (ADR-005).
CREATE TABLE IF NOT EXISTS lessons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id      TEXT NOT NULL,
  category     TEXT NOT NULL,
  observation  TEXT NOT NULL,
  root_cause   TEXT,
  general_rule TEXT NOT NULL,
  evidence     TEXT,
  applied_as   TEXT,
  applied_ref  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lessons_epic     ON lessons(epic_id);
CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);

-- v27: coordinated cross-repo landing ledger (epic-060 story-060-002).
-- landing_attempts: one row per coordinated landing initiated by loom.
-- repo_merges: one row per repo per attempt — the revert anchor (FR-5).
-- Only loom-performed merges get a repo_merges row; concurrent human merges
-- are structurally absent from rollback (AC3).
CREATE TABLE IF NOT EXISTS landing_attempts (
  id         TEXT PRIMARY KEY,
  epic_id    TEXT NOT NULL REFERENCES epics(id),
  status     TEXT NOT NULL,
  base_shas  TEXT,
  blocker    TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repo_merges (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id       TEXT NOT NULL REFERENCES landing_attempts(id),
  repo_slug        TEXT NOT NULL,
  depends_on       TEXT,
  pr_number        INTEGER,
  pr_url           TEXT,
  merge_commit_sha TEXT,
  merge_state      TEXT NOT NULL DEFAULT 'pending',
  revert_pr_url    TEXT,
  revert_merge_sha TEXT,
  merged_at        DATETIME,
  reverted_at      DATETIME,
  UNIQUE (attempt_id, repo_slug)
);

CREATE INDEX IF NOT EXISTS idx_repo_merges_attempt ON repo_merges(attempt_id);
`;

let _db: Database.Database | null = null;

/**
 * Creates a fresh, migrated, NON-singleton database. Use for isolation —
 * eval runs and tests that need a database separate from the app's. Pass
 * ':memory:' for an in-memory database.
 */
export function createDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Opens the app's shared (singleton) database under a `.loom` directory. */
export function openDatabase(loomdir: string): Database.Database {
  if (_db) return _db;
  _db = createDatabase(path.join(loomdir, 'loom.db'));
  return _db;
}

/**
 * Migration v26 — repoints existing epic-NNN standalone containers to story-NNN.
 * No schema change (no ALTER TABLE). Idempotent: the predicate
 * `kind='standalone' AND id LIKE 'epic-%'` matches nothing on re-run because
 * migrated rows already have a 'story-' prefix. Runs inside one transaction
 * with PRAGMA defer_foreign_keys=ON so the FK on agents.epic_id is checked only
 * at COMMIT — order-independent, all-or-nothing.
 */
function repointStandaloneIds(db: Database.Database): void {
  // Snapshot ids to repoint BEFORE any mutations (idempotency predicate).
  const toRepoint = db
    .prepare("SELECT id FROM epics WHERE kind = 'standalone' AND id LIKE 'epic-%'")
    .all() as { id: string }[];

  if (toRepoint.length === 0) return;

  const updateEpic   = db.prepare('UPDATE epics           SET id      = ? WHERE id      = ?');
  const updateAgents = db.prepare('UPDATE agents          SET epic_id = ? WHERE epic_id = ?');
  const updateTraces = db.prepare('UPDATE decision_traces SET epic_id = ? WHERE epic_id = ?');
  const updateAudit  = db.prepare('UPDATE audit_log       SET command = ? WHERE command = ?');

  const deferFk = db.prepare('PRAGMA defer_foreign_keys = ON');

  const migrate = db.transaction(() => {
    // Defer FK check (agents.epic_id REFERENCES epics.id) to COMMIT so the
    // UPDATE epics order doesn't matter — checked all-or-nothing at COMMIT.
    deferFk.run();
    for (const { id: oldId } of toRepoint) {
      // substr(id,6) in SQL === .slice(5) in JS: 'epic-047' -> '047'
      const newId = 'story-' + oldId.slice(5);
      updateEpic.run(newId, oldId);
      updateAgents.run(newId, oldId);
      updateTraces.run(newId, oldId);
      updateAudit.run(newId, oldId);
    }
  });

  migrate();
}

export function runMigrations(db: Database.Database): void {
  db.exec(DDL);

  // Per-column migrations for DBs created before these columns existed.
  const agentCols = db.prepare('PRAGMA table_info(agents)').all() as {
    name: string;
  }[];
  if (!agentCols.some((c) => c.name === 'story_title')) {
    db.exec('ALTER TABLE agents ADD COLUMN story_title TEXT');
  }
  // v6: worker_pid — the OS pid of the running worker subprocess, for
  // per-agent cancellation (loom_stop_agent).
  if (!agentCols.some((c) => c.name === 'worker_pid')) {
    db.exec('ALTER TABLE agents ADD COLUMN worker_pid INTEGER');
  }
  // v9: review_status — outcome of the CodeReviewAgent pass for this story
  // (Epic 18 story-018-002). NULL = no review configured / not yet run.
  // Values: 'pending' | 'passed' | 'commented' | 'blocked' | 'skipped'.
  if (!agentCols.some((c) => c.name === 'review_status')) {
    db.exec('ALTER TABLE agents ADD COLUMN review_status TEXT');
  }
  if (!agentCols.some((c) => c.name === 'review_summary')) {
    db.exec('ALTER TABLE agents ADD COLUMN review_summary TEXT');
  }
  // v10: per-worker token usage from stream-json output parsing (Epic 16).
  if (!agentCols.some((c) => c.name === 'tokens_input')) {
    db.exec('ALTER TABLE agents ADD COLUMN tokens_input INTEGER');
  }
  if (!agentCols.some((c) => c.name === 'tokens_output')) {
    db.exec('ALTER TABLE agents ADD COLUMN tokens_output INTEGER');
  }
  if (!agentCols.some((c) => c.name === 'tokens_cached')) {
    db.exec('ALTER TABLE agents ADD COLUMN tokens_cached INTEGER');
  }
  if (!agentCols.some((c) => c.name === 'tokens_cache_creation')) {
    db.exec('ALTER TABLE agents ADD COLUMN tokens_cache_creation INTEGER');
  }
  if (!agentCols.some((c) => c.name === 'cost_usd')) {
    db.exec('ALTER TABLE agents ADD COLUMN cost_usd REAL');
  }
  // v14: per-attempt LLM request count. The cursor-cli backend's org pricing
  // is per-request, not per-token; cost_usd carries the dollar figure for
  // claude-cli (actual from Anthropic metering) but is meaningless under
  // cursor. request_count is the cursor-side spend signal.
  if (!agentCols.some((c) => c.name === 'request_count')) {
    db.exec('ALTER TABLE agents ADD COLUMN request_count INTEGER');
  }
  // v15: attempt_class — how the worker's last attempt ended, on an axis
  // orthogonal to `status` (ADR-1, epic-006). 'infra_failure' = a transient
  // environmental fault worth an auto-retry; 'work_failure' = the agent ran
  // and produced a real, non-retryable outcome; NULL = unclassified / not a
  // failure. Deliberately NOT a status enum value — the sibling lifecycle
  // epic owns `status`, so this stays a separate column.
  if (!agentCols.some((c) => c.name === 'attempt_class')) {
    db.exec('ALTER TABLE agents ADD COLUMN attempt_class TEXT');
  }

  // v7: planner token usage + wall time, per epic — for cost visibility.
  const epicCols = db.prepare('PRAGMA table_info(epics)').all() as {
    name: string;
  }[];
  if (!epicCols.some((c) => c.name === 'planner_tokens_input')) {
    db.exec('ALTER TABLE epics ADD COLUMN planner_tokens_input INTEGER');
  }
  if (!epicCols.some((c) => c.name === 'planner_tokens_output')) {
    db.exec('ALTER TABLE epics ADD COLUMN planner_tokens_output INTEGER');
  }
  if (!epicCols.some((c) => c.name === 'planner_tokens_cached')) {
    db.exec('ALTER TABLE epics ADD COLUMN planner_tokens_cached INTEGER');
  }
  if (!epicCols.some((c) => c.name === 'planner_ms')) {
    db.exec('ALTER TABLE epics ADD COLUMN planner_ms INTEGER');
  }
  // v8: base_sha — the SHA story branches diverged from, used by the
  // EpicFinalizer to build epic/<id> for per-epic PR strategy.
  if (!epicCols.some((c) => c.name === 'base_sha')) {
    db.exec('ALTER TABLE epics ADD COLUMN base_sha TEXT');
  }
  // v12: track the user's original brief verbatim + the live planning
  // phase, so an operator watching `loom web` can see what kicked off
  // a job before the planner finishes writing the epic structure.
  if (!epicCols.some((c) => c.name === 'user_brief')) {
    db.exec('ALTER TABLE epics ADD COLUMN user_brief TEXT');
  }
  if (!epicCols.some((c) => c.name === 'planning_phase')) {
    db.exec('ALTER TABLE epics ADD COLUMN planning_phase TEXT');
  }
  // v14: planner-side LLM request count + the policy snapshot captured at
  // approve time. The snapshot lets the supervisor diff against the live
  // policy.yaml at finalize/integrate so mid-run edits to late-bound fields
  // (allowed_remotes, test_command, integrator) actually take effect — and
  // so an `epic_policy_rebound` audit row records exactly what changed.
  if (!epicCols.some((c) => c.name === 'planner_request_count')) {
    db.exec('ALTER TABLE epics ADD COLUMN planner_request_count INTEGER');
  }
  if (!epicCols.some((c) => c.name === 'policy_snapshot')) {
    db.exec('ALTER TABLE epics ADD COLUMN policy_snapshot TEXT');
  }
  // v14 (archive runs): archived_at — operator-set timestamp that hides a
  // run from the default status / web / MCP views (and from supervisor
  // selection) without deleting it. NULL = active; timestamp = archived.
  if (!epicCols.some((c) => c.name === 'archived_at')) {
    db.exec('ALTER TABLE epics ADD COLUMN archived_at DATETIME');
  }
  // v15: the finalize overlay — a second per-epic phase marker parallel to
  // planning_phase (deliberately NOT generalized into one column; see
  // ADR-1). finalize_phase tracks the live step while status='finalizing'
  // (NULL otherwise). epic_pr_url is the epic PR of record (distinct from
  // agents.pr_url) and MUST be durable before any status='done' write. error
  // carries the runtime failure message, set iff status='failed' (an infra
  // failure, distinct from a human 'rejected').
  if (!epicCols.some((c) => c.name === 'finalize_phase')) {
    db.exec('ALTER TABLE epics ADD COLUMN finalize_phase TEXT');
  }
  if (!epicCols.some((c) => c.name === 'epic_pr_url')) {
    db.exec('ALTER TABLE epics ADD COLUMN epic_pr_url TEXT');
  }
  if (!epicCols.some((c) => c.name === 'error')) {
    db.exec('ALTER TABLE epics ADD COLUMN error TEXT');
  }
  // v16: per-epic autonomy mode and checkpoint-pause indicator (epic-003 story-003-001).
  // autonomy_level defaults to 'manual' so all pre-v16 rows read as manual with no backfill.
  // paused_at and paused_after_story are nullable — non-null paused_at means the epic is
  // checkpoint-paused after the named story.
  if (!epicCols.some((c) => c.name === 'autonomy_level')) {
    db.exec("ALTER TABLE epics ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!epicCols.some((c) => c.name === 'paused_at')) {
    db.exec('ALTER TABLE epics ADD COLUMN paused_at DATETIME');
  }
  if (!epicCols.some((c) => c.name === 'paused_after_story')) {
    db.exec('ALTER TABLE epics ADD COLUMN paused_after_story TEXT');
  }
  // v18: proposed_by — NULL = human-initiated, 'loom' = self-proposed (FR-10)
  if (!epicCols.some((c) => c.name === 'proposed_by')) {
    db.exec('ALTER TABLE epics ADD COLUMN proposed_by TEXT');
  }
  // v19: publish_pending lifecycle support. finalize_ref holds the
  // finalizer-owned git ref pushed before the PR step failed; publish_note
  // carries the human-readable reason. Additive only — no UPDATE/backfill.
  if (!epicCols.some((c) => c.name === 'finalize_ref')) {
    db.exec('ALTER TABLE epics ADD COLUMN finalize_ref TEXT');
  }
  if (!epicCols.some((c) => c.name === 'publish_note')) {
    db.exec('ALTER TABLE epics ADD COLUMN publish_note TEXT');
  }
  // v20: model attribution. agents.model = the executed model id from the
  // worker's system/init stream event; epics.planner_model = the resolved
  // planning_model. Both are additive-only — pre-migration rows stay NULL
  // and must never be backfilled (NFR-1).
  if (!agentCols.some((c) => c.name === 'model')) {
    db.exec('ALTER TABLE agents ADD COLUMN model TEXT');
  }
  if (!epicCols.some((c) => c.name === 'planner_model')) {
    db.exec('ALTER TABLE epics ADD COLUMN planner_model TEXT');
  }
  // v21: rolling tail of planning persona stdout. Bounded to <=4096 chars,
  // nullable. Written during planning; readable after `status` flips to 'planned'.
  // Mirrors the planning_phase pattern — same guard, additive-only (ADR-005).
  if (!epicCols.some((c) => c.name === 'planning_log_tail')) {
    db.exec('ALTER TABLE epics ADD COLUMN planning_log_tail TEXT');
  }
  // v22: durable per-agent log byte offset — the cumulative post-redaction
  // UTF-8 byte length of the on-disk log file under <loomdir>/logs/. NULL for
  // rows predating this migration; 0 treated as no-offset. Written by
  // flushTails alongside log_tail (never backfilled — pre-v22 rows stay NULL).
  if (!agentCols.some((c) => c.name === 'log_bytes')) {
    db.exec('ALTER TABLE agents ADD COLUMN log_bytes INTEGER');
  }

  // v23: observe-only intake verdict. Additive; never DROP/TRUNCATE; never read by planning.
  if (!epicCols.some((c) => c.name === 'intake_verdict')) {
    db.exec('ALTER TABLE epics ADD COLUMN intake_verdict TEXT');
  }
  // v24: standalone story container kind. NULL/'epic'=legacy epic; 'standalone'=internal
  // single-story container. Additive; never DROP/TRUNCATE; never backfilled (NFR-1).
  if (!epicCols.some((c) => c.name === 'kind')) {
    db.exec('ALTER TABLE epics ADD COLUMN kind TEXT');
  }
  // v25: loom-home artifact commit marker (epic-050 story-050-004). 'committed'
  // means the artifacts for this epic are committed to loom-home; 'pending' means
  // the commit failed and the reconciler should retry. Both NULL for pre-migration
  // rows and epics that have not yet been finalized.
  if (!epicCols.some((c) => c.name === 'loom_home_status')) {
    db.exec(
      "ALTER TABLE epics ADD COLUMN loom_home_status TEXT CHECK (loom_home_status IN ('committed','pending'))"
    );
  }
  if (!epicCols.some((c) => c.name === 'loom_home_sha')) {
    db.exec('ALTER TABLE epics ADD COLUMN loom_home_sha TEXT');
  }

  // v26: repoint epic-NNN standalone ids to story-NNN (no schema change).
  repointStandaloneIds(db);

  const row = db
    .prepare('SELECT version FROM schema_version LIMIT 1')
    .get() as { version: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
      SCHEMA_VERSION
    );
  } else if (row.version !== SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}

export function resetDatabaseForTest(): void {
  _db = null;
}
