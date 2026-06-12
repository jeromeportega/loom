import Database from 'better-sqlite3';
import os from 'node:os';
import crypto from 'node:crypto';
import { processAlive } from './GlobalLimiter.js';

/**
 * A lease whose heartbeat is older than this is reclaimable even if its holder
 * pid still looks alive — a backstop against a wedged (alive but stuck)
 * supervisor. Generous on purpose: a healthy supervisor blocks on a worker for
 * many minutes between dispatch decisions and must not have its lease stolen.
 * Same-host crashes are reclaimed faster via the pid-liveness probe.
 */
const DEFAULT_STALE_MS = 60 * 60 * 1000;

export interface LeaseInfo {
  epicId: string;
  owner: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface LeaseStoreOptions {
  /**
   * Unique identity of THIS holder. Two LeaseStores in the same process get
   * distinct owners, so an MCP in-process dispatch and a same-process retry
   * are still mutually exclusive (pid alone would not distinguish them).
   * Defaults to a random uuid.
   */
  owner?: string;
  /** This holder's pid — for crash reclaim, not identity. Defaults to process.pid. */
  pid?: number;
  /** This holder's hostname — scopes the pid-liveness probe. Defaults to os.hostname(). */
  hostname?: string;
  /** Heartbeat age past which a lease is reclaimed. Defaults to 60 min. */
  staleMs?: number;
  /** Liveness probe, injectable for tests. Defaults to `processAlive`. */
  isAlive?: (pid: number) => boolean;
}

/**
 * A per-epic dispatch lease. Exactly one supervisor may dispatch a given epic's
 * stories at a time, so an MCP in-process supervisor and a `loom run` subprocess
 * (or a retry racing a live run) cannot double-dispatch the same story into its
 * idempotent worktree. Independent epics still run fully in parallel — the lease
 * is keyed by `epic_id`, not global.
 *
 * Identity is the per-instance `owner` token, not the pid: two supervisors in
 * one process hold distinct owners and so still exclude each other. The pid +
 * hostname are recorded only so a crashed holder's lease can be reclaimed
 * (same-host pid probe) or expired (stale heartbeat). Reclaim + take happen in
 * one IMMEDIATE transaction so two supervisors cannot both believe they hold it.
 */
export class LeaseStore {
  private readonly owner: string;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly staleMs: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(
    private db: Database.Database,
    opts: LeaseStoreOptions = {}
  ) {
    this.owner = opts.owner ?? crypto.randomUUID();
    this.pid = opts.pid ?? process.pid;
    this.hostname = opts.hostname ?? os.hostname();
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.isAlive = opts.isAlive ?? processAlive;
  }

  /**
   * Tries to take the lease for `epicId`. Returns true if acquired (we are now
   * the sole dispatcher) or already held by us, false if another live holder
   * owns it. The reclaim-then-take runs in one IMMEDIATE transaction so
   * concurrent loom processes cannot both win.
   */
  acquire(epicId: string): boolean {
    const take = this.db.transaction((id: string): boolean => {
      const row = this.read(id);
      if (row && !this.reclaimable(row)) {
        return row.owner === this.owner;
      }
      this.db
        .prepare(
          `INSERT INTO loom_lease (epic_id, owner, pid, hostname, acquired_at, heartbeat_at)
           VALUES (@epic, @owner, @pid, @host,
                   strftime('%Y-%m-%d %H:%M:%f','now'),
                   strftime('%Y-%m-%d %H:%M:%f','now'))
           ON CONFLICT(epic_id) DO UPDATE SET
             owner = excluded.owner,
             pid = excluded.pid,
             hostname = excluded.hostname,
             acquired_at = excluded.acquired_at,
             heartbeat_at = excluded.heartbeat_at`
        )
        .run({ epic: id, owner: this.owner, pid: this.pid, host: this.hostname });
      return true;
    });
    return take.immediate(epicId);
  }

  /** Refreshes our lease heartbeat so it is not reclaimed. No-op if not ours. */
  heartbeat(epicId: string): void {
    this.db
      .prepare(
        `UPDATE loom_lease SET heartbeat_at = strftime('%Y-%m-%d %H:%M:%f','now')
         WHERE epic_id = ? AND owner = ?`
      )
      .run(epicId, this.owner);
  }

  /** Releases our lease. No-op if another holder owns it. */
  release(epicId: string): void {
    this.db
      .prepare('DELETE FROM loom_lease WHERE epic_id = ? AND owner = ?')
      .run(epicId, this.owner);
  }

  /** The live holder of an epic's lease, or null if free/reclaimable. */
  holder(epicId: string): LeaseInfo | null {
    const row = this.read(epicId);
    if (!row || this.reclaimable(row)) return null;
    return row;
  }

  /** True if a live holder other than us owns the lease. */
  heldByOther(epicId: string): boolean {
    const h = this.holder(epicId);
    return h !== null && h.owner !== this.owner;
  }

  private read(epicId: string): (LeaseInfo & { ageMs: number }) | null {
    const row = this.db
      .prepare(
        `SELECT epic_id AS epicId, owner, pid, hostname,
                acquired_at AS acquiredAt, heartbeat_at AS heartbeatAt,
                (julianday('now') - julianday(heartbeat_at)) * 86400000 AS ageMs
         FROM loom_lease WHERE epic_id = ?`
      )
      .get(epicId) as (LeaseInfo & { ageMs: number }) | undefined;
    return row ?? null;
  }

  /**
   * A lease is reclaimable if its heartbeat is stale, or (same host) its holder
   * process is gone. Cross-host leases fall back to staleness only.
   */
  private reclaimable(row: LeaseInfo & { ageMs?: number }): boolean {
    const ageMs = row.ageMs ?? Number.POSITIVE_INFINITY;
    if (ageMs > this.staleMs) return true;
    if (row.hostname === this.hostname && !this.isAlive(row.pid)) return true;
    return false;
  }
}
