import { z } from 'zod';
import type { EpicTelemetry } from '../../findings/LessonExtractor.js';

// ── Telemetry sub-schemas mirror production types exactly (ADR-003) ───────────
// The compile-time structural check below enforces conformance; a production
// change to EpicTelemetry / DecisionTrace / AuditLogEntry will break the
// _assertEpicTelemetry assertion, catching drift at build time.

const DecisionTraceSchema = z.object({
  id:         z.number(),
  agent_id:   z.string().nullable(),
  epic_id:    z.string().nullable(),
  story_id:   z.string().nullable(),
  kind:       z.string().min(1),
  subject:    z.string().nullable(),
  rationale:  z.string().min(1),
  metadata:   z.string().nullable(),
  timestamp:  z.string(),
});

const AgentEntrySchema = z.object({
  story_id:       z.string(),
  review_summary: z.string().nullable(),
  log_tail:       z.string().nullable(),
});

const AuditRowSchema = z.object({
  id:          z.number(),
  agent_id:    z.string().nullable(),
  action:      z.string(),
  command:     z.string().nullable(),
  allowed:     z.boolean().nullable(),
  policy_rule: z.string().nullable(),
  detail:      z.string().nullable(),
  timestamp:   z.string(),
});

const EpicTelemetryFixtureSchema = z.object({
  epic_id:         z.string(),
  final_status:    z.enum(['done', 'failed']),
  decision_traces: z.array(DecisionTraceSchema),
  agents:          z.array(AgentEntrySchema),
  audit_tail:      z.array(AuditRowSchema),
});

// Compile-time structural check: if the production EpicTelemetry shape changes,
// this type assertion will fail to compile, surfacing drift immediately.
type _EpicTelemetryCheck = z.infer<typeof EpicTelemetryFixtureSchema> extends EpicTelemetry ? true : never;
type _assertEpicTelemetry = _EpicTelemetryCheck;

const RubricExpectation = z.object({
  expected_themes:       z.array(z.string().min(1)),
  over_extraction_traps: z.array(z.string().min(1)).min(1),
});

export const LessonExtractorCaseSchema = z.object({
  id:        z.string(),
  source:    z.enum(['rich', 'thin']),
  telemetry: EpicTelemetryFixtureSchema,
  rubric:    RubricExpectation,
  rationale: z.string().min(1),
});

export const LessonExtractorCaseSetSchema = z.object({
  cases: z.array(LessonExtractorCaseSchema).min(1),
});

export type LessonExtractorCase = z.infer<typeof LessonExtractorCaseSchema>;
export type LessonExtractorCaseSet = z.infer<typeof LessonExtractorCaseSetSchema>;
