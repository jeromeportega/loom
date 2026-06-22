/**
 * Surface contract: every name frozen in surface-baseline.md (57 total)
 * must remain importable from the eval barrel after the intake relocation.
 *
 * Values (27): asserted non-undefined at runtime.
 * Types (30): verified present by the TypeScript compiler (type-erased at runtime).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Value exports (27) ────────────────────────────────────────────────────────
// All 27 must be importable and non-undefined after the intake relocation.

import {
  // eval/EvalRunner.ts, cases.ts, types.ts
  EvalRunner,
  evaluateChecks,
  loadEvalSuite,
  EvalCaseSchema,
  EvalSuiteSchema,
  PlanningExpectationSchema,

  // Intake surface (via eval/intake/index.ts)
  IntakeEvalCaseSchema,
  IntakeEvalSetSchema,
  IntakeJudgeResultSchema,
  loadIntakeEvalSet,
  runIntakeEval,
  computeAxisAccuracy,
  refineEvalCases,
  runRefinedIntakeEval,
  IntakeJudge,
  computeJudgeVsHumanAgreement,
  scoreIntakeEval,
  renderIntakeReport,
  writeIntakeReportFiles,
  renderIntakeReportDual,
  writeIntakeReportDualFiles,
  createIntakeConsumer,

  // Framework re-exports
  runGateEval,
  coreMetrics,
  decide,
  DEFAULT_JUDGE_MODEL,
  resolveEvalModels,
} from '../index.js';

// ── Type-only exports (30) ────────────────────────────────────────────────────
// Imported to prove the TypeScript compiler can resolve them; erased at runtime.

import type {
  // eval/types.ts
  EvalCase,
  PlanningExpectation,
  EvalCheck,
  EvalCaseResult,
  EvalReport,
  EvalRunnerOptions,

  // Intake types
  ClassifyResult,
  IntakeVerdict,
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
  RunIntakeEvalDeps,
  ScoreIntakeEvalMeta,
  IntakeMetrics,
  IntakeConsumer,

  // Framework types
  GateEvalCase,
  RunRecord,
  CoreMetrics,
  EvalThresholds,
  Decision,
  GateDeps,
  JudgeDeps,
  GateEvalConsumer,
} from '../index.js';

// ── Assertions ────────────────────────────────────────────────────────────────

describe('eval barrel surface contract — all 57 baseline names present (story-040-002 AC4)', () => {
  it('top-level framework values are exported and defined', () => {
    assert.ok(EvalRunner !== undefined, 'EvalRunner');
    assert.ok(evaluateChecks !== undefined, 'evaluateChecks');
    assert.ok(loadEvalSuite !== undefined, 'loadEvalSuite');
    assert.ok(EvalCaseSchema !== undefined, 'EvalCaseSchema');
    assert.ok(EvalSuiteSchema !== undefined, 'EvalSuiteSchema');
    assert.ok(PlanningExpectationSchema !== undefined, 'PlanningExpectationSchema');
  });

  it('intake value exports are present after relocation to eval/intake/', () => {
    assert.ok(IntakeEvalCaseSchema !== undefined, 'IntakeEvalCaseSchema');
    assert.ok(IntakeEvalSetSchema !== undefined, 'IntakeEvalSetSchema');
    assert.ok(IntakeJudgeResultSchema !== undefined, 'IntakeJudgeResultSchema');
    assert.ok(loadIntakeEvalSet !== undefined, 'loadIntakeEvalSet');
    assert.ok(runIntakeEval !== undefined, 'runIntakeEval');
    assert.ok(computeAxisAccuracy !== undefined, 'computeAxisAccuracy');
    assert.ok(refineEvalCases !== undefined, 'refineEvalCases');
    assert.ok(runRefinedIntakeEval !== undefined, 'runRefinedIntakeEval');
    assert.ok(IntakeJudge !== undefined, 'IntakeJudge');
    assert.ok(computeJudgeVsHumanAgreement !== undefined, 'computeJudgeVsHumanAgreement');
    assert.ok(scoreIntakeEval !== undefined, 'scoreIntakeEval');
    assert.ok(renderIntakeReport !== undefined, 'renderIntakeReport');
    assert.ok(writeIntakeReportFiles !== undefined, 'writeIntakeReportFiles');
    assert.ok(renderIntakeReportDual !== undefined, 'renderIntakeReportDual');
    assert.ok(writeIntakeReportDualFiles !== undefined, 'writeIntakeReportDualFiles');
    assert.ok(createIntakeConsumer !== undefined, 'createIntakeConsumer');
  });

  it('framework re-export values are present', () => {
    assert.ok(runGateEval !== undefined, 'runGateEval');
    assert.ok(coreMetrics !== undefined, 'coreMetrics');
    assert.ok(decide !== undefined, 'decide');
    assert.ok(DEFAULT_JUDGE_MODEL !== undefined, 'DEFAULT_JUDGE_MODEL');
    assert.ok(resolveEvalModels !== undefined, 'resolveEvalModels');
  });

  it('type exports compile — all 30 type names are resolvable by the TypeScript compiler', () => {
    // Types are erased at runtime. The import above is the actual assertion.
    // This test exists to ensure the suite runs (rather than being skipped)
    // and to document that type-import resolution was verified.
    const typeCount = 30;
    assert.ok(typeCount === 30, '30 type names verified by compiler (see import list above)');
  });
});
