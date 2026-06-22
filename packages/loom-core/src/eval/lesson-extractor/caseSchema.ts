import { z } from 'zod';

// ── Telemetry sub-schemas mirror production types exactly (ADR-003) ───────────
// A production change to EpicTelemetry / DecisionTrace / AuditLogEntry will
// intentionally break this schema, catching drift early.

const DecisionTraceSchema = z.object({
  id:         z.number(),
  agent_id:   z.string().nullable(),
  epic_id:    z.string().nullable(),
  story_id:   z.string().nullable(),
  kind:       z.string(),
  subject:    z.string().nullable(),
  rationale:  z.string(),
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

const EpicTelemetryFixture = z.object({
  epic_id:         z.string(),
  final_status:    z.enum(['done', 'failed']),
  decision_traces: z.array(DecisionTraceSchema),
  agents:          z.array(AgentEntrySchema),
  audit_tail:      z.array(AuditRowSchema),
});

const RubricExpectation = z.object({
  expected_themes:       z.array(z.string().min(1)),
  over_extraction_traps: z.array(z.string().min(1)).min(1),
});

export const LessonExtractorCaseSchema = z.object({
  id:        z.string(),
  source:    z.enum(['rich', 'thin']),
  telemetry: EpicTelemetryFixture,
  rubric:    RubricExpectation,
  rationale: z.string().min(1),
});

export const LessonExtractorCaseSetSchema = z.object({
  cases: z.array(LessonExtractorCaseSchema).min(1),
});

export type LessonExtractorCase = z.infer<typeof LessonExtractorCaseSchema>;
