import Database from 'better-sqlite3';
import type { AuditLogEntry } from '../types.js';
import { AGENT_ID_RANDOM_HEX_LEN } from './AgentStore.js';
import type {
  AttemptClass,
  InfraSignature,
} from '../orchestrator/resilience/types.js';

export class AuditLog {
  constructor(private db: Database.Database) {}

  record(entry: {
    agent_id?: string;
    action: string;
    command?: string;
    allowed?: boolean;
    policy_rule?: string;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (agent_id, action, command, allowed, policy_rule, detail)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.agent_id ?? null,
        entry.action,
        entry.command ?? null,
        entry.allowed !== undefined ? (entry.allowed ? 1 : 0) : null,
        entry.policy_rule ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null
      );
  }

  /**
   * Records the canonical `attempt_classified` audit row (epic-006). The story
   * id goes in `command` (so `getByStory` picks it up across retries) and the
   * cause lands in the existing JSON `detail` column — no audit schema change.
   * `agentId`, when known, attributes the row to the specific attempt.
   */
  recordAttemptClassified(
    storyId: string,
    info: {
      attempt_class: AttemptClass;
      signature?: InfraSignature;
      retry_attempt?: number;
      produced_output: boolean;
    },
    agentId?: string
  ): void {
    const detail: Record<string, unknown> = {
      attempt_class: info.attempt_class,
      produced_output: info.produced_output,
    };
    if (info.signature !== undefined) detail.signature = info.signature;
    if (info.retry_attempt !== undefined)
      detail.retry_attempt = info.retry_attempt;

    this.record({
      agent_id: agentId,
      action: 'attempt_classified',
      command: storyId,
      detail,
    });
  }

  getByAgent(agentId: string, limit = 50): AuditLogEntry[] {
    return this.db
      .prepare(
        'SELECT * FROM audit_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?'
      )
      .all(agentId, limit) as AuditLogEntry[];
  }

  /**
   * Returns audit rows for a story across every retry attempt. Matches both
   * shapes the audit log uses: agent-id rows for worker-attributed events
   * AND `command = <storyId>` for rolling-integrator rows that put the story
   * id in `command` and may have `agent_id` unset.
   *
   * Agent-id match is length-guarded: the bare LIKE pattern
   * `agent-<storyId>-%` would match a story id that's a prefix of another
   * (`story-001` against `agent-story-001-002-...`). Loom's `agent-<storyId>-
   * <hex>` ids use a fixed 8-hex-char random suffix from
   * `crypto.randomBytes(4).toString('hex')`, so anchoring on the total
   * length (`agent-<storyId>-` plus exactly 8 chars) collapses the
   * collision regardless of how callers shape the storyId argument.
   */
  getByStory(storyId: string, limit = 50): AuditLogEntry[] {
    const prefix = `agent-${storyId}-`;
    // Suffix length is the single source of truth in `AgentStore` —
    // bumping `AGENT_ID_RANDOM_BYTES` there transparently updates this
    // length guard, so the LIKE match doesn't silently lose every row.
    const expectedLength = prefix.length + AGENT_ID_RANDOM_HEX_LEN;
    return this.db
      .prepare(
        `SELECT * FROM audit_log
         WHERE (agent_id LIKE ? AND length(agent_id) = ?)
            OR command = ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(`${prefix}%`, expectedLength, storyId, limit) as AuditLogEntry[];
  }

  /**
   * Returns the most recent audit entry for an agent whose action is in the
   * given set, or undefined. Used to derive a story's "stalled" flag for status
   * views — e.g. the latest `worker_timeout_warn` / `worker_watchdog_warn` row
   * tells us a running worker is approaching (or being killed at) a deadline.
   */
  latestActionForAgent(agentId: string, actions: string[]): AuditLogEntry | undefined {
    if (actions.length === 0) return undefined;
    const placeholders = actions.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM audit_log
         WHERE agent_id = ? AND action IN (${placeholders})
         ORDER BY timestamp DESC LIMIT 1`
      )
      .get(agentId, ...actions) as AuditLogEntry | undefined;
  }

  /**
   * Most recent audit row matching one of `actions` for a given `command`
   * value (e.g. an epic id). Mirrors `latestActionForAgent` for rows that key
   * on `command` rather than `agent_id` — the epic-level integration gate is
   * recorded with `command = epicId` and `agent_id` unset.
   */
  latestActionByCommand(command: string, actions: string[]): AuditLogEntry | undefined {
    if (actions.length === 0) return undefined;
    const placeholders = actions.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM audit_log
         WHERE command = ? AND action IN (${placeholders})
         ORDER BY timestamp DESC LIMIT 1`
      )
      .get(command, ...actions) as AuditLogEntry | undefined;
  }

  search(query: string, limit = 50): AuditLogEntry[] {
    // FTS5 match via the virtual table
    const rows = this.db
      .prepare(
        `SELECT audit_log.* FROM audit_log
         JOIN audit_log_fts ON audit_log.id = audit_log_fts.rowid
         WHERE audit_log_fts MATCH ?
         ORDER BY audit_log.timestamp DESC
         LIMIT ?`
      )
      .all(query, limit) as AuditLogEntry[];
    return rows;
  }

  recent(limit = 20): AuditLogEntry[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as AuditLogEntry[];
  }

  /**
   * Returns audit entries where `command` equals the given value, optionally
   * filtered to a set of action names. Used by `loom skills history` to
   * fetch every skill_generated / skill_lifecycle_change row for one skill
   * (the skill name is stored in `command` for those actions).
   */
  getByCommand(command: string, actions?: string[], limit = 200): AuditLogEntry[] {
    if (actions && actions.length > 0) {
      const placeholders = actions.map(() => '?').join(',');
      return this.db
        .prepare(
          `SELECT * FROM audit_log
           WHERE command = ? AND action IN (${placeholders})
           ORDER BY timestamp ASC LIMIT ?`
        )
        .all(command, ...actions, limit) as AuditLogEntry[];
    }
    return this.db
      .prepare(
        'SELECT * FROM audit_log WHERE command = ? ORDER BY timestamp ASC LIMIT ?'
      )
      .all(command, limit) as AuditLogEntry[];
  }
}
