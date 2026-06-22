#!/usr/bin/env node
/**
 * Skill-generator gate eval — runs SkillGenerator against the labeled case set
 * and produces a go/no-go verdict. Not an operator CLI command (ADR-006).
 *
 *   npm run eval:skill-generator
 *   LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:skill-generator
 *   LOOM_EVAL_JUDGE_MODEL=claude-opus-4-8  npm run eval:skill-generator
 *
 * Output: .loom/eval/skill-generator-report.{md,json}
 */
import path from 'node:path';
import { main } from '../packages/loom-core/dist/eval/skill-generator/run.js';

const gateModel   = process.env.LOOM_EVAL_GATE_MODEL  ?? 'claude-haiku-4-5-20251001';
const judgeModel  = process.env.LOOM_EVAL_JUDGE_MODEL ?? 'claude-opus-4-8';
// Resolve to workspace root (CWD when run via `npm run eval:skill-generator` from repo root).
const projectRoot = path.resolve('.');

console.log(`\nRunning skill-generator eval — 8 cases (default fixture).`);
console.log(`  Gate model:  ${gateModel}`);
console.log(`  Judge model: ${judgeModel}\n`);

// main() writes both report files to <projectRoot>/.loom/eval/ before returning.
const report = await main({ gateModel, judgeModel, projectRoot });

const outputDir = path.join(projectRoot, '.loom', 'eval');
console.log(`Report written to ${outputDir}/skill-generator-report.{md,json}`);
console.log(`\nDecision: ${report.decision.verdict.toUpperCase()}`);
if (report.decision.reasons.length > 0) {
  for (const r of report.decision.reasons) console.log(`  • ${r}`);
}
console.log(`Scored:                   ${report.metrics.scoredCases}/${report.metrics.totalCases}`);
console.log(`Gate failures:            ${report.metrics.gateFailures} (${pct(report.metrics.gateFailureRate)})`);
console.log(`Judge inconclusive:       ${report.metrics.judgeInconclusive} (${pct(report.metrics.judgeInconclusiveRate)})`);
console.log(`Decision correctness:     ${pct(report.metrics.decisionCorrectness)}`);
console.log(`Spurious generation rate: ${pct(report.metrics.spuriousGenerationRate)}`);
console.log(`Skill quality:            ${pct(report.metrics.skillQuality)}`);
console.log(`Faithfulness:             ${pct(report.metrics.faithfulness)}`);
console.log(`Low-quality rate:         ${pct(report.metrics.lowQualityRate)}`);
console.log();

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}
