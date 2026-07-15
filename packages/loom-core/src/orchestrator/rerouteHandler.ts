/**
 * Reroute handler for decomposition-aware orchestration (epic-095 story-095-005).
 *
 * When a worker signals `LOOM_TOO_BIG` or times out at absoluteCapMs, the
 * Supervisor invokes the PM persona to decompose the story into N ≥ 2 sub-stories
 * and injects them into the live DAG atomically.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditLog } from '../state/AuditLog.js';
import { AGENT_ID_RANDOM_BYTES } from '../state/AgentStore.js';
import type { Story } from '../types.js';
import { MAX_RESPLIT_BUDGET } from './constants.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ReroutePayload {
  story:         Story;
  fanOutPayload: string;
  trigger:       'LOOM_TOO_BIG' | 'cap';
}

export class RerouteBudgetExhaustedError extends Error {
  readonly storyId: string;
  readonly resplitCount: number;

  constructor(storyId: string, resplitCount: number) {
    super(
      `Story ${storyId} has exhausted its re-split budget ` +
      `(MAX_RESPLIT_BUDGET=${MAX_RESPLIT_BUDGET}, current count=${resplitCount}). ` +
      `The story cannot be re-split again and has been marked failed.`
    );
    this.name = 'RerouteBudgetExhaustedError';
    this.storyId = storyId;
    this.resplitCount = resplitCount;
  }
}

/**
 * Injectable PM persona interface. The production implementation invokes
 * the loom PM planning persona; tests inject a stub.
 */
export interface PMAgent {
  /**
   * Decomposes an oversized story into N ≥ 2 sub-stories.
   * @param storySpec - Markdown rendering of the original story (title, description, ACs).
   * @param fanOutPayload - Arbitrary context string the worker emitted alongside LOOM_TOO_BIG.
   */
  decompose(storySpec: string, fanOutPayload: string): Promise<Story[]>;
}

// ─── Downstream dependent override descriptor ──────────────────────────────────
// Passed by the Supervisor to injectSubStories so the transaction can update
// both sub-story rows and dependency overrides atomically.

export interface DownstreamOverride {
  /** The story_id of the dependent story that must be re-pointed. */
  storyId: string;
  /** The new dependencies array replacing the YAML-declared one. */
  newDependencies: string[];
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Checks the current re-split budget for `payload.story`, invokes the PM
 * persona to decompose it, increments the resplit_count, and returns the
 * N ≥ 2 sub-stories.
 *
 * Throws `RerouteBudgetExhaustedError` without invoking PM when
 * `resplit_count >= MAX_RESPLIT_BUDGET`.
 * Throws a plain Error when PM returns fewer than 2 sub-stories.
 *
 * The resplit_count increment is a separate DB write (not in the same
 * transaction as injectSubStories) because it must happen AFTER a
 * successful PM call — if PM fails, the budget is not decremented.
 * Crash window: if the process dies after the resplit_count UPDATE but before
 * injectSubStories commits, the budget counter is permanently decremented
 * without sub-stories being injected. On restart, AgentStore.create() carries
 * forward MAX(resplit_count) so the next run sees the incremented count. This
 * is a deliberate trade-off: the increment guards against runaway PM calls on
 * repeated crashes (conservative), and the sub-story insertion is idempotent
 * enough that operators can retry manually if needed.
 */
export async function handleReroute(
  payload: ReroutePayload,
  opts: {
    pmAgent:   PMAgent;
    db:        Database.Database;
    epicId:    string;
    auditLog:  AuditLog;
  }
): Promise<Story[]> {
  const { story, fanOutPayload, trigger } = payload;
  const { pmAgent, db, epicId, auditLog } = opts;

  // Read current resplit_count from the most-recent agent row for this story.
  const agentRow = db
    .prepare(
      'SELECT resplit_count FROM agents WHERE story_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1'
    )
    .get(story.id) as { resplit_count: number } | undefined;
  const resplitCount = agentRow?.resplit_count ?? 0;

  if (resplitCount >= MAX_RESPLIT_BUDGET) {
    auditLog.record({
      action:  'reroute_budget_exhausted',
      command: story.id,
      allowed: false,
      detail: {
        resplitCount,
        maxBudget: MAX_RESPLIT_BUDGET,
        trigger,
        epicId,
        message: `MAX_RESPLIT_BUDGET=${MAX_RESPLIT_BUDGET} reached; story marked failed`,
      },
    });
    throw new RerouteBudgetExhaustedError(story.id, resplitCount);
  }

  auditLog.record({
    action:  'reroute_pm_invoked',
    command: story.id,
    allowed: true,
    detail: { trigger, epicId, resplitCountBefore: resplitCount },
  });

  // Invoke PM persona.
  const storySpec = renderStorySpec(story);
  const subStories = await pmAgent.decompose(storySpec, fanOutPayload);

  if (subStories.length < 2) {
    auditLog.record({
      action:  'reroute_pm_insufficient',
      command: story.id,
      allowed: false,
      detail: { trigger, subStoryCount: subStories.length, epicId },
    });
    throw new Error(
      `PM persona returned ${subStories.length} sub-stories for ${story.id}; ` +
      `need at least 2. Story marked failed.`
    );
  }

  // Increment resplit_count on the most-recent agent row.
  db.prepare(
    `UPDATE agents SET resplit_count = resplit_count + 1, updated_at = ?
     WHERE story_id = ? AND id = (
       SELECT id FROM agents WHERE story_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1
     )`
  ).run(new Date().toISOString(), story.id, story.id);

  auditLog.record({
    action:  'reroute_pm_succeeded',
    command: story.id,
    allowed: true,
    detail: {
      trigger,
      epicId,
      subStoryCount: subStories.length,
      subStoryIds:   subStories.map((s) => s.id),
      resplitCountAfter: resplitCount + 1,
    },
  });

  return subStories;
}

/**
 * Atomically injects sub-stories into the DB within a single SQLite transaction:
 *
 *  1. Creates pending agent rows for each sub-story (with full Story JSON stored
 *     in the `story_json` column for retrieval by the Supervisor's next tick).
 *  2. Updates downstream dependents' agent rows with `dep_overrides` JSON so the
 *     Supervisor can re-point them to the final sub-story rather than the original.
 *  3. Records one audit log entry per sub-story.
 *
 * The `downstreamOverrides` parameter is computed by the Supervisor from its
 * in-memory tasks map before calling this function — it is the only place that
 * holds the full epic DAG.
 *
 * Never modifies the YAML plan file. All state used across restarts is in the
 * DB; the in-memory tasks map is updated by the Supervisor after this returns.
 */
export function injectSubStories(
  originalStory:       Story,
  subStories:          Story[],
  epicId:              string,
  db:                  Database.Database,
  auditLog:            AuditLog,
  downstreamOverrides: DownstreamOverride[] = []
): void {
  const now = new Date().toISOString();

  db.transaction(() => {
    // Insert pending agent rows for each sub-story. Check for a pre-existing row
    // first so a crash-and-restart that re-enters injectSubStories doesn't create
    // phantom duplicate rows for the same sub-story.
    for (const sub of subStories) {
      const existingRow = db
        .prepare('SELECT id FROM agents WHERE story_id = ? AND epic_id = ? LIMIT 1')
        .get(sub.id, epicId) as { id: string } | undefined;
      if (existingRow) {
        // Already injected (crash-restart idempotency): skip INSERT, no new audit row.
        continue;
      }
      const agentId =
        `agent-${sub.id}-${crypto.randomBytes(AGENT_ID_RANDOM_BYTES).toString('hex')}`;
      db.prepare(
        `INSERT INTO agents
           (id, epic_id, story_id, story_title, status, story_json, updated_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        agentId,
        epicId,
        sub.id,
        sub.title,
        'pending',
        JSON.stringify(sub),
        now
      );

      // Audit entry per sub-story so operators can trace the injection.
      db.prepare(
        `INSERT INTO audit_log (agent_id, action, command, allowed, detail, timestamp)
         VALUES (?,?,?,?,?,?)`
      ).run(
        agentId,
        'sub_story_injected',
        sub.id,
        1,
        JSON.stringify({
          epicId,
          parentStoryId:   originalStory.id,
          trigger:         'reroute',
          title:           sub.title,
          dependenciesLen: sub.dependencies.length,
        }),
        now
      );
    }

    // Re-point downstream dependents: store dep_overrides so the Supervisor's
    // next tick knows to use the override instead of the YAML dependencies.
    for (const override of downstreamOverrides) {
      db.prepare(
        `UPDATE agents
         SET dep_overrides = ?, updated_at = ?
         WHERE story_id = ? AND epic_id = ?
           AND id = (
             SELECT id FROM agents
             WHERE story_id = ? AND epic_id = ?
             ORDER BY updated_at DESC, id DESC LIMIT 1
           )`
      ).run(
        JSON.stringify(override.newDependencies),
        now,
        override.storyId,
        epicId,
        override.storyId,
        epicId
      );

      db.prepare(
        `INSERT INTO audit_log (agent_id, action, command, allowed, detail, timestamp)
         VALUES (?,?,?,?,?,?)`
      ).run(
        null,
        'dep_override_applied',
        override.storyId,
        1,
        JSON.stringify({
          epicId,
          newDependencies:  override.newDependencies,
          replacedForStory: originalStory.id,
        }),
        now
      );
    }
  })();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Renders a Story as a Markdown spec for the PM persona's decompose prompt. */
function renderStorySpec(story: Story): string {
  const lines: string[] = [
    `# Story ${story.id} — ${story.title}`,
    '',
    story.description,
    '',
    '## Acceptance criteria',
    ...story.acceptance_criteria.map((ac) => `- [ ] ${ac}`),
  ];
  if (story.tech_notes?.trim()) {
    lines.push('', '## Technical guidance', story.tech_notes);
  }
  return lines.join('\n');
}
