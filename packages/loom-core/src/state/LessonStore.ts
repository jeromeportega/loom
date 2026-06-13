import Database from 'better-sqlite3';
import { Lesson, type LessonRow } from '../findings/lesson.js';

export class LessonStore {
  constructor(private db: Database.Database) {}

  insert(lessons: Lesson[]): LessonRow[] {
    if (lessons.length === 0) return [];

    const stmt = this.db.prepare(`
      INSERT INTO lessons
        (epic_id, category, observation, root_cause, general_rule, evidence,
         applied_as, applied_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const results: LessonRow[] = [];
    const run = this.db.transaction(() => {
      for (const lesson of lessons) {
        const parsed = Lesson.parse(lesson);
        const info = stmt.run(
          parsed.epic_id,
          parsed.category,
          parsed.observation,
          parsed.root_cause ?? null,
          parsed.general_rule,
          parsed.evidence ?? null,
          parsed.applied_as,
          parsed.applied_ref,
          parsed.created_at,
        );
        results.push({ ...parsed, id: info.lastInsertRowid as number });
      }
    });
    run();

    return results;
  }

  getByEpic(epicId: string): LessonRow[] {
    const rows = this.db
      .prepare('SELECT * FROM lessons WHERE epic_id = ? ORDER BY id ASC')
      .all(epicId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  list(opts?: { category?: string; appliedOnly?: boolean; limit?: number }): LessonRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.category) {
      conditions.push('category = ?');
      params.push(opts.category);
    }
    if (opts?.appliedOnly) {
      conditions.push('applied_as IS NOT NULL');
    }

    let query = 'SELECT * FROM lessons';
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY id ASC';

    if (opts?.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  markApplied(
    id: number,
    applied_as: 'worker_guidance' | 'policy_suggestion',
    applied_ref: string,
  ): void {
    this.db
      .prepare('UPDATE lessons SET applied_as = ?, applied_ref = ? WHERE id = ?')
      .run(applied_as, applied_ref, id);
  }

  private mapRow(row: Record<string, unknown>): LessonRow {
    return {
      id: row.id as number,
      epic_id: row.epic_id as string,
      category: row.category as string,
      observation: row.observation as string,
      root_cause: row.root_cause != null ? (row.root_cause as string) : undefined,
      general_rule: row.general_rule as string,
      evidence: row.evidence != null ? (row.evidence as string) : undefined,
      applied_as: row.applied_as as 'worker_guidance' | 'policy_suggestion' | null,
      applied_ref: row.applied_ref as string | null,
      created_at: row.created_at as string,
    };
  }
}
