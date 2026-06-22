#!/usr/bin/env node
/**
 * Brief-quality gate eval — runs BriefRefiner against the labeled case set
 * and produces a go/no-go verdict. Not an operator CLI command (ADR-006).
 *
 *   npm run eval:brief-quality
 *   LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:brief-quality
 *   LOOM_EVAL_JUDGE_MODEL=claude-opus-4-8  npm run eval:brief-quality
 *
 * Output: .loom/eval/brief-quality-report.{md,json}
 */
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../packages/loom-core/dist/eval/brief-quality/run.js';

const gateModel  = process.env.LOOM_EVAL_GATE_MODEL  ?? 'claude-opus-4-8';
const judgeModel = process.env.LOOM_EVAL_JUDGE_MODEL ?? 'claude-opus-4-8';

console.log(`\nRunning brief-quality eval (default fixture).`);
console.log(`  Gate model:  ${gateModel}`);
console.log(`  Judge model: ${judgeModel}\n`);

const report = await main({ gateModel, judgeModel });

const outputDir = path.resolve('.loom/eval');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'brief-quality-report.md'),   report.markdown, 'utf8');
fs.writeFileSync(path.join(outputDir, 'brief-quality-report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(`Report written to ${outputDir}/brief-quality-report.{md,json}`);
console.log(`\nDecision: ${report.decision.verdict.toUpperCase()}`);
if (report.decision.reasons.length > 0) {
  for (const r of report.decision.reasons) console.log(`  • ${r}`);
}
console.log(`Scored:             ${report.metrics.scoredCases}/${report.metrics.totalCases}`);
console.log(`Gate failures:      ${report.metrics.gateFailures} (${pct(report.metrics.gateFailureRate)})`);
console.log(`Judge inconclusive: ${report.metrics.judgeInconclusive} (${pct(report.metrics.judgeInconclusiveRate)})`);
console.log(`Readiness accuracy: ${pct(report.metrics.readinessAccuracy)}`);
console.log(`Band agreement:     ${pct(report.metrics.qualityBandAgreement)}`);
console.log(`Critique quality:   ${pct(report.metrics.critiqueQuality)}`);
console.log();

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}
