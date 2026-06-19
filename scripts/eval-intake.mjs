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
import {
  loadIntakeEvalSet,
  runIntakeEval,
  computeAxisAccuracy,
  createLLMClient,
} from '../packages/loom-core/dist/index.js';

const backend = process.env.LOOM_EVAL_BACKEND ?? 'claude-cli';
const classifierModel = process.env.LOOM_EVAL_MODEL ?? 'claude-haiku-4-5-20251001';
const judgeModel = 'claude-opus-4-7'; // planning_model default; wired by story-021-003

const cases = loadIntakeEvalSet();
console.log(`\nRunning intake eval — ${cases.length} cases, backend: ${backend}.\n`);

// [INJECT:judge] story-021-003 replaces this stub with:
//   deps.judge = new IntakeJudge({ llm, model: judgeModel });
const inconclusiveStub = {
  judge: async () => ({ status: 'inconclusive', detail: 'judge not yet wired (story-021-003)' }),
};

const records = await runIntakeEval(cases, {
  llm: createLLMClient(backend),
  classifierModel,
  judgeModel,
  judge: inconclusiveStub,
});

// [INJECT:report] story-021-004 adds scoreIntakeEval + renderIntakeReport here.

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
