import Database from 'better-sqlite3';
import type { OpportunityRecord } from './OpportunityEngine.js';

export class OpportunityStore {
  constructor(private db: Database.Database) {}

  upsertRanked(rows: OpportunityRecord[]): { inserted: number; refreshed: number; skipped: number } {
    if (rows.length === 0) return { inserted: 0, refreshed: 0, skipped: 0 };

    // Classify existing keys by status before writing (ADR-004)
    const keys = rows.map((r) => r.key);
    const placeholders = keys.map(() => '?').join(',');
    const existingRows = this.db
      .prepare(`SELECT key, status FROM opportunities WHERE key IN (${placeholders})`)
      .all(...keys) as { key: string; status: string }[];

    const existingByKey = new Map<string, string>(existingRows.map((r) => [r.key, r.status]));

    let inserted = 0;
    let refreshed = 0;
    let skipped = 0;

    const stmt = this.db.prepare(`
      INSERT INTO opportunities
        (key, title, rationale, impact, effort, confidence, score, rank, status,
         signal_count, member_keys, evidence, scoped_epic_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        title        = excluded.title,
        rationale    = excluded.rationale,
        impact       = excluded.impact,
        effort       = excluded.effort,
        confidence   = excluded.confidence,
        score        = excluded.score,
        rank         = excluded.rank,
        signal_count = excluded.signal_count,
        member_keys  = excluded.member_keys,
        evidence     = excluded.evidence,
        updated_at   = excluded.updated_at
    `);

    const runAll = this.db.transaction(() => {
      for (const row of rows) {
        const existingStatus = existingByKey.get(row.key);
        // Never resurface scoped or dismissed opportunities (ADR-004)
        if (existingStatus === 'scoped' || existingStatus === 'dismissed') {
          skipped++;
          continue;
        }
        const now = new Date().toISOString();
        stmt.run(
          row.key,
          row.title,
          row.rationale,
          row.impact,
          row.effort,
          row.confidence,
          row.score,
          row.rank,
          row.signal_count,
          JSON.stringify(row.member_keys),
          JSON.stringify(row.evidence),
          row.created_at || now,
          row.updated_at || now
        );
        if (!existingStatus) {
          inserted++;
        } else {
          refreshed++;
        }
      }
    });
    runAll();

    return { inserted, refreshed, skipped };
  }

  listRanked(opts?: { status?: OpportunityRecord['status']; limit?: number }): OpportunityRecord[] {
    let query = 'SELECT * FROM opportunities';
    const params: unknown[] = [];

    if (opts?.status) {
      query += ' WHERE status = ?';
      params.push(opts.status);
    }

    query += ' ORDER BY rank ASC, score DESC';

    if (opts?.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  get(id: number): OpportunityRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM opportunities WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getByEpicId(epicId: string): OpportunityRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM opportunities WHERE scoped_epic_id = ?')
      .get(epicId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  markScoped(id: number, epicId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE opportunities SET status = 'scoped', scoped_epic_id = ?, updated_at = ? WHERE id = ?"
      )
      .run(epicId, now, id);
  }

  markDismissed(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE opportunities SET status = 'dismissed', updated_at = ? WHERE id = ?")
      .run(now, id);
  }

  reopen(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE opportunities SET status = 'open', scoped_epic_id = NULL, updated_at = ? WHERE id = ?"
      )
      .run(now, id);
  }

  private mapRow(row: Record<string, unknown>): OpportunityRecord {
    return {
      id: row.id as number,
      key: row.key as string,
      title: row.title as string,
      rationale: row.rationale as string,
      impact: row.impact as number,
      effort: row.effort as number,
      confidence: row.confidence as number,
      score: row.score as number,
      rank: row.rank as number,
      status: row.status as 'open' | 'scoped' | 'dismissed',
      signal_count: row.signal_count as number,
      member_keys: JSON.parse(row.member_keys as string) as string[],
      evidence: JSON.parse(row.evidence as string) as { title: string; url: string }[],
      scoped_epic_id: row.scoped_epic_id as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
