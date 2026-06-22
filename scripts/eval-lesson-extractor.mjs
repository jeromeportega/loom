#!/usr/bin/env node
/**
 * Lesson-extractor gate eval — runs LessonExtractor against the labeled case set
 * and produces a go/no-go verdict. Not an operator CLI command (ADR-006).
 *
 *   npm run eval:lesson-extractor
 *   LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:lesson-extractor
 *   LOOM_EVAL_JUDGE_MODEL=claude-opus-4-8  npm run eval:lesson-extractor
 *
 * Output: .loom/eval/lesson-extractor-report.{md,json}
 */
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../packages/loom-core/dist/eval/lesson-extractor/run.js';

const gateModel  = process.env.LOOM_EVAL_GATE_MODEL  ?? 'claude-haiku-4-5-20251001';
const judgeModel = process.env.LOOM_EVAL_JUDGE_MODEL ?? 'claude-opus-4-8';

console.log(`\nRunning lesson-extractor eval — 2 cases (default fixture).`);
console.log(`  Gate model:  ${gateModel}`);
console.log(`  Judge model: ${judgeModel}\n`);

const report = await main({ gateModel, judgeModel });

const outputDir = path.resolve('.loom/eval');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'lesson-extractor-report.md'),   report.markdown, 'utf8');
fs.writeFileSync(path.join(outputDir, 'lesson-extractor-report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(`Report written to ${outputDir}/lesson-extractor-report.{md,json}`);
console.log(`\nDecision: ${report.decision.verdict.toUpperCase()}`);
if (report.decision.reasons.length > 0) {
  for (const r of report.decision.reasons) console.log(`  • ${r}`);
}
console.log(`Scored:               ${report.metrics.scoredCases}/${report.metrics.totalCases}`);
console.log(`Gate failures:        ${report.metrics.gateFailures} (${pct(report.metrics.gateFailureRate)})`);
console.log(`Judge inconclusive:   ${report.metrics.judgeInconclusive} (${pct(report.metrics.judgeInconclusiveRate)})`);
console.log(`Faithfulness:         ${pct(report.metrics.faithfulness)}`);
console.log(`Usefulness:           ${pct(report.metrics.usefulness)}`);
console.log(`Coverage:             ${pct(report.metrics.coverage)}`);
console.log(`Hallucination rate:   ${pct(report.metrics.hallucinationRate)}`);
console.log(`Over-extraction rate: ${pct(report.metrics.overExtractionRate)}`);
console.log();

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}
