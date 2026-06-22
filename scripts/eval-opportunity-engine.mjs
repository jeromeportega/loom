#!/usr/bin/env node
/**
 * Opportunity-engine gate eval — runs OpportunityEngine against the labeled case set
 * and produces a go/no-go verdict. Not an operator CLI command (ADR-006).
 *
 *   npm run eval:opportunity-engine
 *   LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:opportunity-engine
 *   LOOM_EVAL_JUDGE_MODEL=claude-opus-4-8  npm run eval:opportunity-engine
 *
 * Output: .loom/eval/opportunity-engine-report.{md,json}
 */
import path from 'node:path';
import { main } from '../packages/loom-core/dist/eval/opportunity-engine/run.js';

const gateModel   = process.env.LOOM_EVAL_GATE_MODEL  ?? 'claude-haiku-4-5-20251001';
const judgeModel  = process.env.LOOM_EVAL_JUDGE_MODEL ?? 'claude-opus-4-8';
// Resolve to workspace root (CWD when run via `npm run eval:opportunity-engine` from repo root).
const projectRoot = path.resolve('.');

console.log(`\nRunning opportunity-engine eval — 8 cases (default fixture).`);
console.log(`  Gate model:  ${gateModel}`);
console.log(`  Judge model: ${judgeModel}\n`);

// main() writes both report files to <projectRoot>/.loom/eval/ before returning.
const report = await main({ gateModel, judgeModel, projectRoot });

const outputDir = path.join(projectRoot, '.loom', 'eval');
console.log(`Report written to ${outputDir}/opportunity-engine-report.{md,json}`);
console.log(`\nDecision: ${report.decision.verdict.toUpperCase()}`);
if (report.decision.reasons.length > 0) {
  for (const r of report.decision.reasons) console.log(`  • ${r}`);
}
console.log(`Scored:                    ${report.metrics.scoredCases}/${report.metrics.totalCases}`);
console.log(`Gate failures:             ${report.metrics.gateFailures} (${pct(report.metrics.gateFailureRate)})`);
console.log(`Judge inconclusive:        ${report.metrics.judgeInconclusive} (${pct(report.metrics.judgeInconclusiveRate)})`);
console.log(`Coherence:                 ${pct(report.metrics.coherence)}`);
console.log(`Score reasonableness:      ${pct(report.metrics.scoreReasonableness)}`);
console.log(`Grounding:                 ${pct(report.metrics.grounding)}`);
console.log(`Forced clustering rate:    ${pct(report.metrics.forcedClusteringRate)}`);
console.log(`Hallucination rate:        ${pct(report.metrics.hallucinationRate)}`);
console.log();

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}
