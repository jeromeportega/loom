import Database from 'better-sqlite3';
import type { AgentStatus } from '../types.js';

export interface SkillTrackRecord {
  skillName: string;
  /** Times the skill was injected into a story. */
  injected: number;
  /** Stories that succeeded (done / pr_open) with the skill injected. */
  succeeded: number;
  /** Stories that failed or were blocked with the skill injected. */
  failed: number;
}

export interface SkillInjectionRow {
  storyId: string;
  agentId: string;
  outcome: AgentStatus | null;
  injectedAt: string;
}

/**
 * Records skill provenance — every time a skill is injected into a story, and
 * the outcome of that story. This is the measurement substrate for the skill
 * lifecycle (promotion / demotion) and the anti-degradation loop.
 */
export class SkillUsageStore {
  constructor(private db: Database.Database) {}

  /** Records that a skill was injected into a story (outcome unknown yet). */
  recordInjection(skillName: string, agentId: string, storyId: string): void {
    this.db
      .prepare(
        `INSERT INTO skill_usage (skill_name, agent_id, story_id)
         VALUES (?, ?, ?)`
      )
      .run(skillName, agentId, storyId);
  }

  /** Stamps the story outcome onto every skill injected into that agent's story. */
  recordOutcome(agentId: string, outcome: AgentStatus): void {
    this.db
      .prepare('UPDATE skill_usage SET outcome = ? WHERE agent_id = ? AND outcome IS NULL')
      .run(outcome, agentId);
  }

  /**
   * Forces the outcome onto every skill injected into that agent's story,
   * overwriting one already stamped by recordOutcome. Needed when a story that
   * first completed successfully is later downgraded — e.g. a worker that
   * succeeds but whose merge conflicts under the rolling integration branch is
   * marked `blocked`. Without this the skill would be permanently counted as a
   * success in trackRecord(), inflating its rate and shielding it from demotion.
   */
  overrideOutcome(agentId: string, outcome: AgentStatus): void {
    this.db
      .prepare('UPDATE skill_usage SET outcome = ? WHERE agent_id = ?')
      .run(outcome, agentId);
  }

  /**
   * Returns every injection of a skill in chronological order — the substrate
   * `loom skills history` renders as a timeline alongside lifecycle changes.
   */
  history(skillName: string, limit = 200): SkillInjectionRow[] {
    const rows = this.db
      .prepare(
        `SELECT story_id AS storyId, agent_id AS agentId, outcome,
                injected_at AS injectedAt
         FROM skill_usage WHERE skill_name = ?
         ORDER BY injected_at ASC LIMIT ?`
      )
      .all(skillName, limit) as Array<{
        storyId: string;
        agentId: string;
        outcome: AgentStatus | null;
        injectedAt: string;
      }>;
    return rows;
  }

  /** Returns the success/failure record for one skill. */
  trackRecord(skillName: string): SkillTrackRecord {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS injected,
           SUM(CASE WHEN outcome IN ('done','pr_open') THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN outcome IN ('failed','blocked') THEN 1 ELSE 0 END) AS failed
         FROM skill_usage WHERE skill_name = ?`
      )
      .get(skillName) as { injected: number; succeeded: number | null; failed: number | null };
    return {
      skillName,
      injected: row.injected,
      succeeded: row.succeeded ?? 0,
      failed: row.failed ?? 0,
    };
  }
}
