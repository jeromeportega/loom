import { z } from 'zod';
import type Database from 'better-sqlite3';
import { AuditLog } from '../state/AuditLog.js';
import { SkillUsageStore } from '../state/SkillUsageStore.js';
import { ReviewerOutput } from '../findings/schema.js';
import { Investigation } from '../findings/investigation.js';
import { Distillation } from '../findings/distillation.js';
import { Lesson } from '../findings/lesson.js';
import { SOURCE } from '../findings/sources.js';

/**
 * A single skill invocation request. The orchestrator builds one of these per
 * reviewer/skill call; `name` selects the registered skill, `input` is the
 * (skill-specific) payload, and the story/epic ids attribute the resulting
 * provenance rows.
 */
export interface SkillInvocation<TInput = unknown, TOutput = unknown> {
  name: string;
  input: TInput;
  story_id: string;
  epic_id: string;
}

/** The result of {@link invokeSkill}: the validated output plus run metadata. */
export interface SkillResult<TOutput = unknown> {
  output: TOutput;
  cache_hit: boolean;
  duration_ms: number;
}

/**
 * Runtime dependencies an invocation needs to record provenance. `db` is the
 * loom state database; `agent_id`, when supplied, attributes both the
 * skill_usage and audit_log rows to a concrete agent (otherwise audit_log is
 * recorded with a null agent and skill_usage falls back to a story-derived id).
 */
export interface SkillRuntimeContext {
  db: Database.Database;
  agent_id?: string;
}

/**
 * A registered skill: its name, the zod schemas that validate its input and
 * output, and the handler that produces the output. Handlers may be async.
 */
export interface SkillDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  handler: (
    input: TInput,
    call: SkillInvocation<TInput, TOutput>,
  ) => TOutput | Promise<TOutput>;
}

const registry = new Map<string, SkillDefinition<any, any>>();

/** Registers (or replaces) a skill definition. Idempotent under re-import. */
export function registerSkill<TInput, TOutput>(
  def: SkillDefinition<TInput, TOutput>,
): void {
  registry.set(def.name, def as SkillDefinition<any, any>);
}

/** Returns the registered definition for a skill name, or undefined. */
export function getSkillDefinition(
  name: string,
): SkillDefinition<unknown, unknown> | undefined {
  return registry.get(name);
}

/** Names of every registered skill, in insertion order. */
export function registeredSkillNames(): string[] {
  return [...registry.keys()];
}

/**
 * Invoke a registered skill end to end: validate the input, run the handler,
 * validate the output, and — per CLAUDE.md invariant #5 — write the
 * skill_usage and audit_log provenance rows BEFORE returning to the caller.
 *
 * Throws if the skill is unknown or if input/output fail schema validation.
 */
export async function invokeSkill<TInput, TOutput>(
  call: SkillInvocation<TInput, TOutput>,
  ctx: SkillRuntimeContext,
): Promise<SkillResult<TOutput>> {
  const def = registry.get(call.name);
  if (!def) throw new Error(`unknown skill: ${call.name}`);

  const start = Date.now();
  const input = def.inputSchema.parse(call.input) as TInput;
  const produced = await def.handler(input, call as SkillInvocation<any, any>);
  const output = def.outputSchema.parse(produced) as TOutput;
  const duration_ms = Date.now() - start;

  // Provenance is written before returning. skill_usage.agent_id is NOT NULL
  // (no FK) so a story-derived id is safe when no concrete agent is supplied;
  // audit_log.agent_id has an FK to agents(id), so it stays null unless the
  // caller passes a real agent id.
  const usageAgentId = ctx.agent_id ?? `agent-${call.story_id}`;
  new SkillUsageStore(ctx.db).recordInjection(call.name, usageAgentId, call.story_id);
  new AuditLog(ctx.db).record({
    agent_id: ctx.agent_id,
    action: 'skill_invoked',
    command: call.name,
    detail: { skill: call.name, story_id: call.story_id, epic_id: call.epic_id },
  });

  return { output, cache_hit: false, duration_ms };
}

// ─── Built-in Review Forge skills (stub bodies) ─────────────────────────────
//
// story-001 registers all five skills with schema-valid stub handlers so the
// invocation seam, provenance writes, and headless loading are exercised from
// day one. Stories 002/004/005/006 fill the real SKILL.md bodies; the registry
// glue here stays the invocation contract. Inputs are validated permissively
// (`z.unknown()`) because the concrete input types are owned by later stories
// (ReviewerInput, FailurePayload); outputs are validated strictly against the
// frozen findings schemas.

const anyInput = z.unknown();

registerSkill({
  name: SOURCE.ADVERSARIAL,
  inputSchema: anyInput,
  outputSchema: ReviewerOutput,
  handler: () => ({ findings: [] }),
});

registerSkill({
  name: SOURCE.EDGE_CASE,
  inputSchema: anyInput,
  outputSchema: ReviewerOutput,
  handler: () => ({ findings: [] }),
});

registerSkill({
  name: 'failure-investigator',
  inputSchema: anyInput,
  outputSchema: Investigation,
  handler: () => ({
    grade: 'weak' as const,
    hypothesis: 'stub investigation — no analysis performed yet',
    evidence_refs: [],
  }),
});

registerSkill({
  name: 'doc-distiller',
  inputSchema: anyInput,
  outputSchema: Distillation,
  handler: () => ({
    distilled: '(stub distillation)',
    source_token_count: 0,
    distilled_token_count: 0,
    acceptance_criteria_preserved: [],
  }),
});

const LessonExtractorOutput = z.object({ lessons: z.array(Lesson) });

registerSkill({
  name: 'lesson-extractor',
  inputSchema: anyInput,
  outputSchema: LessonExtractorOutput,
  handler: () => ({ lessons: [] }),
});
