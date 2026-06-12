#!/usr/bin/env node
/**
 * Developer eval runner — runs the bundled planning eval suite and prints a
 * score. For loom developers tuning the planner personas; not a customer tool.
 *
 *   npm run eval                  # session-based (claude-cli), the default
 *   LOOM_EVAL_BACKEND=anthropic-api npm run eval
 *
 * Each case runs the full planner, so a run takes several minutes.
 */
import { EvalRunner, loadEvalSuite, createLLMClient } from '../packages/loom-core/dist/index.js';

const backend = process.env.LOOM_EVAL_BACKEND ?? 'claude-cli';
const model = process.env.LOOM_EVAL_MODEL ?? 'claude-sonnet-4-6';

const cases = loadEvalSuite('planning');
console.log(`\nRunning the planning eval suite — ${cases.length} cases, backend: ${backend}.`);
console.log('Each case runs the full planner; this takes several minutes.\n');

const report = await new EvalRunner({ llm: createLLMClient(backend), model }).run(
  'planning',
  cases
);

for (const result of report.cases) {
  console.log(`  [${result.passed ? 'PASS' : 'FAIL'}] ${result.caseId}`);
  if (result.error) console.log(`         error: ${result.error}`);
  for (const check of result.checks.filter((c) => !c.passed)) {
    console.log(`         x ${check.name}: ${check.detail}`);
  }
}

const pct = Math.round(report.score * 100);
console.log(`\nScore: ${report.passed}/${report.total} (${pct}%)\n`);
process.exit(report.passed === report.total ? 0 : 1);
