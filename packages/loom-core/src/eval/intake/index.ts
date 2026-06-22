// Intake eval types — explicit named re-exports (JudgeOutcome is intentionally omitted
// to avoid collision with the framework's JudgeOutcome<T> at the package root).
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

export {
  renderIntakeReport,
  writeIntakeReportFiles,
  renderIntakeReportDual,
  writeIntakeReportDualFiles,
} from './renderIntakeReport.js';

export { createIntakeConsumer } from './intakeConsumer.js';
export type { IntakeMetrics, IntakeConsumer } from './intakeConsumer.js';

// recoverBriefText is intentionally NOT exported — it is an internal helper only.
// Import directly from './recoverBriefText.js' if needed.
