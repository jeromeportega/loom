import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { loadMachineConfig } from './MachineConfig.js';
import { loomHome } from './paths.js';

/** A slot a supervisor holds for one in-flight worker agent. */
export interface LimiterSlot {
  id: number;
}

/** The default limiter database location: `<loomHome>/limiter.db`. */
export function defaultLimiterPath(): string {
  return path.join(loomHome(), 'limiter.db');
}

/**
 * A slot whose heartbeat is older than this is reclaimed even if its holder pid
 * still looks alive — a backstop against a wedged (alive but stuck) supervisor.
 * Generous on purpose: a healthy supervisor blocks on a worker for many minutes
 * between heartbeats, and must not have its slots stolen.
 */
const STALE_MS = 60 * 60 * 1000;

/** True if a process with this pid exists (signal 0 probes without killing). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but is owned by another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A machine-level semaphore. Caps the total worker agents running concurrently
 * across *every* loom run on the machine, so several products do not
 * collectively exhaust the developer's shared Claude session rate limits.
 *
 * Backed by a small SQLite file under `~/.loom` so the count is shared across
 * processes. Crash-safe: every slot records its holder pid, and a slot whose
 * pid is gone (or whose heartbeat is very stale) is reclaimed on the next
 * acquire — a crashed run never leaks its slots permanently.
 */
export class GlobalLimiter {
  private readonly db: Database.Database;

  constructor(
    /** Machine-wide cap on concurrent workers, from `~/.loom/config.json`. */
    readonly capacity: number,
    opts: { path?: string } = {}
  ) {
    const file = opts.path ?? defaultLimiterPath();
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid INTEGER NOT NULL,
        label TEXT,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Tries to take a slot. Returns it if the machine-wide live count is below
   * capacity (dead holders are reclaimed first), or null if the cap is reached.
   * The read-count-then-insert runs in an IMMEDIATE transaction so concurrent
   * loom processes cannot both slip past the cap.
   */
  acquire(label: string): LimiterSlot | null {
    const take = this.db.transaction((lbl: string): LimiterSlot | null => {
      this.prune();
      const { n } = this.db
        .prepare('SELECT COUNT(*) AS n FROM slots')
        .get() as { n: number };
      if (n >= this.capacity) return null;
      const now = Date.now();
      const info = this.db
        .prepare(
          'INSERT INTO slots (pid, label, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?)'
        )
        .run(process.pid, lbl, now, now);
      return { id: Number(info.lastInsertRowid) };
    });
    return take.immediate(label);
  }

  /** Releases a slot back to the pool. */
  release(slot: LimiterSlot): void {
    this.db.prepare('DELETE FROM slots WHERE id = ?').run(slot.id);
  }

  /** Refreshes the heartbeat of held slots so they are not reclaimed. */
  heartbeat(slots: LimiterSlot[]): void {
    if (slots.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE slots SET heartbeat_at = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const slot of slots) stmt.run(now, slot.id);
    })();
  }

  /** Live slot count across the machine, after reclaiming dead holders. */
  activeCount(): number {
    this.prune();
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM slots').get() as { n: number }
    ).n;
  }

  close(): void {
    this.db.close();
  }

  /** Deletes slots whose holder process is gone or whose heartbeat is stale. */
  private prune(): void {
    const rows = this.db
      .prepare('SELECT id, pid, heartbeat_at FROM slots')
      .all() as { id: number; pid: number; heartbeat_at: number }[];
    const cutoff = Date.now() - STALE_MS;
    const del = this.db.prepare('DELETE FROM slots WHERE id = ?');
    for (const row of rows) {
      if (!processAlive(row.pid) || row.heartbeat_at < cutoff) del.run(row.id);
    }
  }
}

/**
 * Builds a GlobalLimiter from the machine config, with an optional fallback
 * cap. When `~/.loom/config.json` sets `max_global_workers`, that wins.
 * Otherwise — when a `fallback` is supplied (typically the supervisor's
 * `policy.agents.max_concurrent`) — the per-supervisor cap is also applied
 * machine-wide, so several parallel `loom run`s on one machine don't
 * collectively run N × max_concurrent workers (the operator-pain pattern
 * from the multi-epic shared-client run). Returns undefined only when no
 * fallback is supplied AND no machine cap is set — preserves the explicit-
 * opt-out path for tests.
 */
export function createGlobalLimiter(
  fallback?: number
): GlobalLimiter | undefined {
  const cap = loadMachineConfig().maxGlobalWorkers ?? fallback;
  return cap ? new GlobalLimiter(cap) : undefined;
}
