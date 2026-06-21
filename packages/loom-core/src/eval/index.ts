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

// Intake eval types — exported individually to avoid name collision with the
// generic JudgeOutcome<T> and other framework types that share names with
// orchestrator types exported in src/index.ts.
// Callers needing the intake JudgeOutcome can import from './intakeEvalTypes.js'.
export type { ClassifyResult, IntakeVerdict } from './intakeEvalTypes.js';
export { IntakeEvalCaseSchema, IntakeEvalSetSchema, IntakeJudgeResultSchema } from './intakeEvalTypes.js';
export type {
  IntakeEvalCase,
  IntakeEvalSet,
  IntakeJudgeResult,
  IntakeJudgeLike,
  IntakeRunRecord,
  ConfusionMatrix,
  AxisReport,
  IntakeEvalReport,
  RefinedCaseResult,
  DualIntakeReport,
} from './intakeEvalTypes.js';

export { loadIntakeEvalSet } from './loadIntakeEvalSet.js';
export { runIntakeEval, computeAxisAccuracy } from './runIntakeEval.js';
export type { RunIntakeEvalDeps } from './runIntakeEval.js';
export { refineEvalCases } from './refineEvalCases.js';
export { runRefinedIntakeEval } from './runRefinedIntakeEval.js';
export { IntakeJudge, computeJudgeVsHumanAgreement } from './IntakeJudge.js';
export { scoreIntakeEval } from './scoreIntakeEval.js';
export type { ScoreIntakeEvalMeta } from './scoreIntakeEval.js';
export { renderIntakeReport, writeIntakeReportFiles } from './renderIntakeReport.js';

// Intake consumer (GateEvalConsumer plug-point implementation)
export { createIntakeConsumer } from './intakeConsumer.js';
export type { IntakeMetrics, IntakeConsumer } from './intakeConsumer.js';

// Framework re-exports (explicit to avoid collision with orchestrator's GateOutcome).
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
