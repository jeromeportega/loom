import Database from 'better-sqlite3';
import type { Finding, Severity } from '../findings/schema.js';

export interface StoredFinding {
  id: number;
  agent_id: string;
  story_id: string;
  severity: 'blocking' | 'medium' | 'low' | 'info';
  file: string;
  line: number | null;
  message: string;
  suggestion: string | null;
  recorded_at: string; // ISO 8601
}

// Map the production Review-Forge severity vocabulary (findings/schema.ts) onto
// the stored display severity. `high` folds into `blocking` because loom already
// treats blocker+high as the blocking tier (see BaseCliWorker.blockerCount).
export const SEVERITY_MAP: Record<Severity, StoredFinding['severity']> = {
  blocker: 'blocking',
  high:    'blocking',
  medium:  'medium',
  low:     'low',
  info:    'info',
};

// Severity rank used for ordering findings by importance.
const SEVERITY_RANK: Record<StoredFinding['severity'], number> = {
  blocking: 0,
  medium:   1,
  low:      2,
  info:     3,
};

export class FindingStore {
  constructor(private db: Database.Database) {}

  /**
   * Deletes all prior rows for `agentId`, then inserts one row per finding.
   * Maps ReviewFinding.severity → StoredFinding.severity via SEVERITY_MAP.
   * Wrapped in a single transaction.
   */
  saveFindings(agentId: string, storyId: string, findings: Finding[]): void {
    const del = this.db.prepare('DELETE FROM review_findings WHERE agent_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO review_findings (agent_id, story_id, severity, file, line, message, suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const run = this.db.transaction(() => {
      del.run(agentId);
      for (const f of findings) {
        ins.run(
          agentId,
          storyId,
          SEVERITY_MAP[f.severity],
          f.location.file,
          f.location.line ?? null,
          f.description,
          f.suggested_fix ?? null,
        );
      }
    });

    run();
  }

  /**
   * Returns findings for the latest agent attempt for a story.
   * "Latest" = agent_id whose MAX(recorded_at) is highest for this story_id.
   * Ordered by severity rank, then recorded_at ASC.
   */
  getByStory(storyId: string): StoredFinding[] {
    const rows = this.db.prepare(`
      SELECT rf.*
      FROM review_findings rf
      INNER JOIN (
        SELECT agent_id
        FROM review_findings
        WHERE story_id = ?
        ORDER BY recorded_at DESC
        LIMIT 1
      ) latest ON rf.agent_id = latest.agent_id
      WHERE rf.story_id = ?
      ORDER BY rf.recorded_at ASC
    `).all(storyId, storyId) as StoredFinding[];

    return rows.sort((a, b) => {
      const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rankDiff !== 0) return rankDiff;
      return a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : 0;
    });
  }

  /** Returns all findings for a specific agent attempt. For tests. */
  getByAgent(agentId: string): StoredFinding[] {
    return this.db.prepare(`
      SELECT * FROM review_findings WHERE agent_id = ? ORDER BY recorded_at ASC
    `).all(agentId) as StoredFinding[];
  }
}
