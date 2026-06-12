import type Database from 'better-sqlite3';
import type { ReviewerOutput } from '../findings/schema.js';
import type { SourceId } from '../findings/sources.js';
import { invokeSkill, type SkillInvocation } from '../skills/types.js';

/**
 * The payload every reviewer receives: the unified diff under review, the list
 * of changed files, and a short story-context string. Shared across
 * adversarial-review, edge-case-hunter, and the code-review adapter so the
 * orchestrator can fan one input out to all three (ADR-002).
 */
export interface ReviewerInput {
  diff: string;
  changed_files: string[];
  story_context: string;
}

/** A reviewer skill invocation: `ReviewerInput` in, `ReviewerOutput` out. */
export type ReviewerInvocation = SkillInvocation<ReviewerInput, ReviewerOutput>;

/**
 * One reviewer the orchestrator can run. `run` resolves to the reviewer's
 * findings or rejects — a zod-validation failure (malformed output) or any
 * other self-failure. The orchestrator wraps every `run` with exactly one
 * repair re-prompt followed by warn-and-continue, so a single reviewer can
 * never abort the pass.
 */
export interface ReviewerRunner {
  source: SourceId;
  run: (input: ReviewerInput) => Promise<ReviewerOutput>;
}

/**
 * Wrap a registered reviewer skill (`adversarial-review` / `edge-case-hunter`)
 * as a {@link ReviewerRunner}. `invokeSkill` validates the skill's output
 * against the frozen `ReviewerOutput` schema and writes the skill_usage +
 * audit_log provenance rows before returning, so a malformed reviewer response
 * surfaces here as a thrown `ZodError` — exactly the signal the orchestrator's
 * repair-then-warn path keys on.
 */
export function skillReviewer(
  source: SourceId,
  ctx: { db: Database.Database; story_id: string; epic_id: string; agent_id?: string },
): ReviewerRunner {
  return {
    source,
    run: async (input) => {
      const result = await invokeSkill<ReviewerInput, ReviewerOutput>(
        { name: source, input, story_id: ctx.story_id, epic_id: ctx.epic_id },
        { db: ctx.db, agent_id: ctx.agent_id },
      );
      return result.output;
    },
  };
}
