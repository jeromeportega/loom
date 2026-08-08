export type {
  BlastRadius,
  ProvenanceTag,
  Alternative,
  GrillingDecision,
  ResolvedDecision,
  FactCheckResult,
  InterviewOutcome,
  InterviewResult,
} from './types.js';
export { seedDecisionTree } from './seeding.js';
export { factCheck } from './factCheck.js';
export { persistLedger } from './ledger.js';
export { writeGrillingAuditRow } from './auditWriter.js';
export { runGrillingInterview, type InterviewOptions } from './interview.js';
export { appendResolvedDecisionsAppendix } from './appendix.js';
