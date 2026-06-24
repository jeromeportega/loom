import Database from 'better-sqlite3';

/**
 * Durable per-story auto-recovery accounting. Keyed by story_id (not agent/attempt)
 * so the retry budget survives process restarts and spans all attempts for a story.
 */
export class RecoveryStore {
  constructor(private db: Database.Database) {}

  /** Returns the current recovery count for a story, or 0 if no row exists. */
  getRecoveryCount(storyId: string): number {
    const row = this.db
      .prepare('SELECT recovery_count FROM story_recovery WHERE story_id = ?')
      .get(storyId) as { recovery_count: number } | undefined;
    return row?.recovery_count ?? 0;
  }

  /**
   * Atomically increments (or initializes to 1) the recovery count for a story.
   * Returns the new count (1-based) after the increment.
   */
  incrementRecoveryCount(storyId: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO story_recovery (story_id, recovery_count, updated_at)
         VALUES (?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(story_id) DO UPDATE SET
           recovery_count = recovery_count + 1,
           updated_at = CURRENT_TIMESTAMP
         RETURNING recovery_count`
      )
      .get(storyId) as { recovery_count: number };
    return row.recovery_count;
  }
}
