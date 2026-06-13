import Database from 'better-sqlite3';
import type { Signal, SignalRecord, SignalSource } from './types.js';

export class SignalStore {
  constructor(private db: Database.Database) {}

  upsertMany(signals: Signal[]): { inserted: number; refreshed: number } {
    if (signals.length === 0) return { inserted: 0, refreshed: 0 };

    const keys = signals.map((s) => s.key);
    const placeholders = keys.map(() => '?').join(',');
    const existingRows = this.db
      .prepare(`SELECT key FROM signals WHERE key IN (${placeholders})`)
      .all(...keys) as { key: string }[];
    const existingKeys = new Set(existingRows.map((r) => r.key));

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO signals (key, source, kind, title, detail, evidence_url, weight, status, first_seen, last_seen, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        last_seen    = excluded.last_seen,
        status       = 'open',
        source       = excluded.source,
        kind         = excluded.kind,
        title        = excluded.title,
        detail       = excluded.detail,
        evidence_url = excluded.evidence_url,
        weight       = excluded.weight,
        metadata     = excluded.metadata
    `);

    const runAll = this.db.transaction(() => {
      for (const signal of signals) {
        stmt.run(
          signal.key,
          signal.source,
          signal.kind,
          signal.title,
          signal.detail ?? null,
          signal.evidenceUrl ?? null,
          signal.weight ?? 1,
          now,
          now,
          signal.metadata !== undefined ? JSON.stringify(signal.metadata) : null
        );
      }
    });
    runAll();

    let inserted = 0;
    let refreshed = 0;
    for (const signal of signals) {
      if (existingKeys.has(signal.key)) {
        refreshed++;
      } else {
        inserted++;
      }
    }
    return { inserted, refreshed };
  }

  /** Flips open signals not in observedKeys to 'stale'. Returns count changed. */
  reconcile(observedKeys: string[]): number {
    if (observedKeys.length === 0) {
      return this.db
        .prepare("UPDATE signals SET status = 'stale' WHERE status = 'open'")
        .run().changes;
    }
    const placeholders = observedKeys.map(() => '?').join(',');
    return this.db
      .prepare(
        `UPDATE signals SET status = 'stale' WHERE status = 'open' AND key NOT IN (${placeholders})`
      )
      .run(...observedKeys).changes;
  }

  listOpen(limit?: number): SignalRecord[] {
    const rows =
      limit !== undefined
        ? (this.db
            .prepare(
              "SELECT * FROM signals WHERE status = 'open' ORDER BY weight DESC, last_seen DESC, id ASC LIMIT ?"
            )
            .all(limit) as Record<string, unknown>[])
        : (this.db
            .prepare(
              "SELECT * FROM signals WHERE status = 'open' ORDER BY weight DESC, last_seen DESC, id ASC"
            )
            .all() as Record<string, unknown>[]);
    return rows.map((row) => this.mapRow(row));
  }

  getByKeys(keys: string[]): SignalRecord[] {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM signals WHERE key IN (${placeholders})`)
      .all(...keys) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): SignalRecord {
    return {
      id: row.id as number,
      key: row.key as string,
      source: row.source as SignalSource,
      kind: row.kind as string,
      title: row.title as string,
      detail: row.detail as string | undefined,
      evidenceUrl: row.evidence_url as string | undefined,
      weight: row.weight as number | undefined,
      metadata:
        row.metadata !== null && row.metadata !== undefined
          ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
          : undefined,
      status: row.status as 'open' | 'stale',
      first_seen: row.first_seen as string,
      last_seen: row.last_seen as string,
    };
  }
}
