import Database from 'better-sqlite3';
import type { AuditLogEntry } from '../types.js';
import { AGENT_ID_RANDOM_HEX_LEN } from './AgentStore.js';
import type {
  AttemptClass,
  InfraSignature,
} from '../orchestrator/resilience/types.js';
import {
  AUDIT_GENESIS_HASH,
  canonicalPayload,
  computeEntryHash,
} from './auditHash.js';

export interface VerifyChainResult {
  ok:          boolean;
  hashedRows:  number;
  legacyRows:  number;
  fromId:      number | null;
  toId:        number | null;
  brokenAtId?: number;
  reason?:     string;
}

type RawAuditRow = {
  id:            number;
  agent_id:      string | null;
  action:        string;
  command:       string | null;
  allowed:       number | null;
  policy_rule:   string | null;
  detail:        string | null;
  timestamp:     string;
  prev_hash:     string | null;
  entry_hash:    string | null;
  contract_hash: string | null;
};

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
    const getHead = this.db.prepare(
      'SELECT entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1'
    );
    const insertRow = this.db.prepare(
      `INSERT INTO audit_log (agent_id, action, command, allowed, policy_rule, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const getRow = this.db.prepare(
      `SELECT id, agent_id, action, command, allowed, policy_rule, detail, timestamp
       FROM audit_log WHERE id = ?`
    );
    const updateHashes = this.db.prepare(
      'UPDATE audit_log SET prev_hash = ?, entry_hash = ? WHERE id = ?'
    );
    // contract_hash MUST remain NULL until the payload format is versioned (future epic).
    const updateAnchor = this.db.prepare(
      `UPDATE audit_chain_head
       SET hashed_row_count = hashed_row_count + 1,
           cutover_id = COALESCE(cutover_id, ?),
           last_id = ?,
           last_entry_hash = ?
       WHERE id = 1`
    );

    const allowedVal =
      entry.allowed !== undefined ? (entry.allowed ? 1 : 0) : null;
    const detailVal = entry.detail ? JSON.stringify(entry.detail) : null;

    const txn = this.db.transaction(() => {
      const head = getHead.get() as { entry_hash: string } | undefined;
      const prevHash = head?.entry_hash ?? AUDIT_GENESIS_HASH;

      const result = insertRow.run(
        entry.agent_id ?? null,
        entry.action,
        entry.command ?? null,
        allowedVal,
        entry.policy_rule ?? null,
        detailVal
      );

      const rowId = Number(result.lastInsertRowid);
      const row = getRow.get(rowId) as {
        id: number;
        agent_id: string | null;
        action: string;
        command: string | null;
        allowed: number | null;
        policy_rule: string | null;
        detail: string | null;
        timestamp: string;
      };

      const payload = canonicalPayload(
        row.id,
        row.agent_id,
        row.action,
        row.command,
        row.allowed,
        row.policy_rule,
        row.detail,
        null, // contract_hash MUST remain NULL until the payload format is versioned (future epic).
        row.timestamp,
        prevHash
      );
      const entryHash = computeEntryHash(payload);

      updateHashes.run(prevHash, entryHash, row.id);
      const anchorInfo = updateAnchor.run(rowId, rowId, entryHash);
      if (anchorInfo.changes !== 1) {
        throw new Error('audit_chain_head anchor row missing (id=1); transaction will roll back');
      }
    });

    txn.immediate();
  }

  verifyChain(): VerifyChainResult {
    const rows = this.db
      .prepare('SELECT * FROM audit_log ORDER BY id ASC')
      .all() as RawAuditRow[];

    let hashedRows = 0;
    let legacyRows = 0;
    let fromId: number | null = null;
    let toId: number | null = null;
    let expectedPrev = AUDIT_GENESIS_HASH;

    for (const row of rows) {
      if (row.entry_hash === null) {
        legacyRows++;
        continue;
      }

      hashedRows++;
      if (fromId === null) fromId = row.id;
      toId = row.id;

      const payload = canonicalPayload(
        row.id,
        row.agent_id,
        row.action,
        row.command,
        row.allowed,
        row.policy_rule,
        row.detail,
        null,
        row.timestamp,
        row.prev_hash as string
      );
      const recomputed = computeEntryHash(payload);

      if (recomputed !== row.entry_hash) {
        return {
          ok: false,
          hashedRows,
          legacyRows,
          fromId,
          toId,
          brokenAtId: row.id,
          reason: 'entry-hash-mismatch',
        };
      }

      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          hashedRows,
          legacyRows,
          fromId,
          toId,
          brokenAtId: row.id,
          reason: 'broken-link',
        };
      }

      expectedPrev = row.entry_hash;
    }

    return { ok: true, hashedRows, legacyRows, fromId, toId };
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
