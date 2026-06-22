export { EvalRunner, evaluateChecks } from './EvalRunner.js';
export type { EvalRunnerOptions } from './EvalRunner.js';
export { loadEvalSuite } from './cases.js';
export {
  EvalCaseSchema,
  EvalSuiteSchema,
  PlanningExpectationSchema,
} from './types.js';
export type {
  EvalCase,
  PlanningExpectation,
  EvalCheck,
  EvalCaseResult,
  EvalReport,
} from './types.js';

// Intake consumer surface — routed through its own sub-barrel.
// No wildcard collision: the intake surface was diffed against the frozen
// baseline (story-040-001) and no intake name collides at the root.
// JudgeOutcome (intake-internal) and RecoverBriefResult are excluded by
// intake/index.ts's explicit named exports.
export * from './intake/index.js';

// Framework re-exports (explicit named list to avoid collision with the
// orchestrator's GateOutcome exported from src/index.ts).
// Deep imports via './framework/index.js' also work for internal consumers.
export type {
  GateEvalCase,
  RunRecord,
  CoreMetrics,
  EvalThresholds,
  Decision,
  GateDeps,
  JudgeDeps,
  GateEvalConsumer,
} from './framework/types.js';
// GateOutcome<T> and JudgeOutcome<T> are NOT re-exported here to avoid
// collision with the orchestrator's GateOutcome exported from src/index.ts.
// Import them directly: import type { GateOutcome } from './framework/types.js'
export { runGateEval } from './framework/runGateEval.js';
export { coreMetrics } from './framework/coreMetrics.js';
export { decide } from './framework/decide.js';
export { DEFAULT_JUDGE_MODEL, resolveEvalModels } from './framework/models.js';
