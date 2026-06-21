#!/usr/bin/env node
/**
 * Developer eval harness — runs the Phase 0 IntakeClassifier on every case in
 * the intake-classification.yaml fixture and reports per-axis exact-match accuracy
 * vs human labels. Not an operator CLI command (ADR-005).
 *
 *   npm run eval:intake                        # session-based (claude-cli), the default
 *   LOOM_EVAL_BACKEND=cursor-cli npm run eval:intake
 *   LOOM_EVAL_MODEL=claude-haiku-4-5-20251001 npm run eval:intake
 */
import path from 'node:path';
import {
  loadIntakeEvalSet,
  runIntakeEval,
  computeAxisAccuracy,
  IntakeJudge,
  scoreIntakeEval,
  writeIntakeReportFiles,
  renderIntakeReport,
  createLLMClient,
  BriefRefiner,
  refineEvalCases,
  runRefinedIntakeEval,
} from '../packages/loom-core/dist/index.js';

const backend = process.env.LOOM_EVAL_BACKEND ?? 'claude-cli';
const classifierModel = process.env.LOOM_EVAL_MODEL ?? 'claude-haiku-4-5-20251001';
const judgeModel = process.env.LOOM_JUDGE_MODEL ?? 'claude-opus-4-8'; // planning_model default
const refinerModel = process.env.LOOM_REFINER_MODEL ?? 'claude-opus-4-7'; // planning-tier model (ADR-007)
const REFINED = process.env.LOOM_EVAL_REFINED === '1';

const cases = loadIntakeEvalSet();
console.log(`\nRunning intake eval — ${cases.length} cases, backend: ${backend}.\n`);

const llm = createLLMClient(backend);

// [INJECT:judge] wired by story-021-003
const deps = {
  llm,
  classifierModel,
  judgeModel,
  judge: new IntakeJudge({ llm, model: judgeModel }),
};

const records = await runIntakeEval(cases, deps);

// [INJECT:report] wired by story-021-004
const report = scoreIntakeEval(records, { classifierModel, judgeModel });
const outputDir = path.resolve('.loom/eval');

// Refined-brief variant (LOOM_EVAL_REFINED=1 only — off by default, FR-7).
// Roughly doubles LLM calls per run.
let refinedReport;
if (REFINED) {
  console.log(`\nRunning refined-brief variant (LOOM_EVAL_REFINED=1) with refiner model: ${refinerModel}.\n`);
  const projectRoot = path.resolve('.');
  const refiner = new BriefRefiner({ projectRoot, llm, model: refinerModel });
  const refinedCases = await refineEvalCases(cases, refiner);
  const refinedRecords = await runRefinedIntakeEval(refinedCases, deps);
  refinedReport = scoreIntakeEval(refinedRecords, { classifierModel, judgeModel });
}

// [INJECT:refined-report] — story-037-002
writeIntakeReportFiles(report, outputDir);
console.log(`\nReport written to ${outputDir}/intake-report.{md,json}`);
console.log(`Overall: ${report.overall.proceed ? 'PROCEED' : 'DO NOT PROCEED'} — ${report.overall.statement}`);

// Per-axis exact-match accuracy vs human labels (Phase 0 classifier only).
console.log('Classifier accuracy vs human labels:');
for (const axis of /** @type {('type' | 'size')[]} */ (['type', 'size'])) {
  const { correct, scored } = computeAxisAccuracy(records, axis);
  const pct = scored > 0 ? Math.round((correct / scored) * 100) : 0;
  const failed = records.length - scored;
  const suffix = failed > 0 ? ` (${failed} classifier failure${failed !== 1 ? 's' : ''} excluded)` : '';
  console.log(`  ${axis}: ${correct}/${scored} (${pct}%)${suffix}`);
}

console.log();
