import Database from 'better-sqlite3';

export interface EvalRunRecord {
  id: number;
  suite: string;
  score: number;
  passed: number;
  total: number;
  ran_at: string;
}

/** Stores the score of each `loom eval` run, for drift detection over time. */
export class EvalRunStore {
  constructor(private db: Database.Database) {}

  record(suite: string, passed: number, total: number): EvalRunRecord {
    const score = total > 0 ? passed / total : 0;
    const result = this.db
      .prepare(
        'INSERT INTO eval_runs (suite, score, passed, total) VALUES (?, ?, ?, ?)'
      )
      .run(suite, score, passed, total);
    return this.db
      .prepare('SELECT * FROM eval_runs WHERE id = ?')
      .get(result.lastInsertRowid) as EvalRunRecord;
  }

  /** The most recent prior run of a suite, excluding a given run id. */
  previous(suite: string, excludeId?: number): EvalRunRecord | undefined {
    return this.db
      .prepare(
        `SELECT * FROM eval_runs
         WHERE suite = ? AND id != ?
         ORDER BY ran_at DESC, id DESC LIMIT 1`
      )
      .get(suite, excludeId ?? -1) as EvalRunRecord | undefined;
  }

  history(suite: string, limit = 10): EvalRunRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM eval_runs WHERE suite = ? ORDER BY ran_at DESC, id DESC LIMIT ?'
      )
      .all(suite, limit) as EvalRunRecord[];
  }
}
