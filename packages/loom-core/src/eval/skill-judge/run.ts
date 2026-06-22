import fs from 'node:fs';
import path from 'node:path';
import type { LLMClient } from '../../llm/LLMClient.js';
import { createLLMClient } from '../../llm/factory.js';
import { DEFAULT_JUDGE_MODEL } from '../framework/models.js';
import { runGateEval } from '../framework/runGateEval.js';
import { decide } from '../framework/decide.js';
import type { RunRecord, Decision } from '../framework/types.js';
import type { JudgeResult } from '../../skills/SkillJudge.js';
import type { SkillJudgeJudgment } from './judgeTypes.js';
import type { SkillJudgeMetrics } from './score.js';
import { createSkillJudgeConsumer } from './consumer.js';
import { DEFAULT_GATE_MODEL } from './runGate.js';

export interface MainOptions {
  llm?:         LLMClient;
  gateModel?:   string;
  judgeModel?:  string;
  fixturePath?: string;
}

export interface EvalReport {
  metrics:  SkillJudgeMetrics;
  decision: Decision;
  perCase:  RunRecord<JudgeResult, SkillJudgeJudgment>[];
  markdown: string;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function renderMarkdown(
  metrics: SkillJudgeMetrics,
  decision: Decision,
  perCase: RunRecord<JudgeResult, SkillJudgeJudgment>[],
): string {
  const lines: string[] = [
    '# Skill-Judge Eval Report',
    '',
    `**Decision:** ${decision.verdict}`,
  ];

  if (decision.reasons.length > 0) {
    lines.push('', '**Reasons:**');
    for (const r of decision.reasons) lines.push(`- ${r}`);
  }

  lines.push(
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total cases | ${metrics.totalCases} |`,
    `| Scored cases | ${metrics.scoredCases} |`,
    `| Gate failures | ${metrics.gateFailures} (${pct(metrics.gateFailureRate)}) |`,
    `| Fail-open observed | ${metrics.failOpenObserved} |`,
    `| Judge inconclusive | ${metrics.judgeInconclusive} (${pct(metrics.judgeInconclusiveRate)}) |`,
    `| Decision accuracy | ${pct(metrics.decisionAccuracy)} |`,
    `| Band agreement | ${pct(metrics.bandAgreement)} |`,
    `| Independent agreement | ${pct(metrics.independentAgreement)} |`,
  );

  if (perCase.length > 0) {
    lines.push(
      '',
      '## Per-Case Results',
      '',
      '| Case | Gate | Judge | Correct | In-Band | Ind. Verdict | Defensible |',
      '|------|------|-------|---------|---------|--------------|------------|',
    );
    for (const r of perCase) {
      const gate = r.gate.status;
      const judge = r.judge.status;
      const correct = r.judge.status === 'ok' ? String(r.judge.judgment.decision_correct) : '—';
      const inBand = r.judge.status === 'ok' ? String(r.judge.judgment.band_in_range) : '—';
      const indVerdict = r.judge.status === 'ok' ? r.judge.judgment.independent_verdict : '—';
      const defensible = r.judge.status === 'ok' ? String(r.judge.judgment.band_defensible) : '—';
      lines.push(`| ${r.caseId} | ${gate} | ${judge} | ${correct} | ${inBand} | ${indVerdict} | ${defensible} |`);
    }
  }

  return lines.join('\n');
}

function resolveReportDir(): string {
  // Compiled output lives at dist/eval/skill-judge/ — three levels up to package root
  return path.resolve(__dirname, '../../../.loom/eval');
}

export async function main(opts: MainOptions = {}): Promise<EvalReport> {
  const gateModel  = opts.gateModel  ?? process.env.LOOM_EVAL_GATE_MODEL  ?? DEFAULT_GATE_MODEL;
  const judgeModel = opts.judgeModel ?? process.env.LOOM_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const llm        = opts.llm        ?? createLLMClient('claude-cli');

  const consumer = createSkillJudgeConsumer();
  const cases    = consumer.loadCases(opts.fixturePath);
  const deps     = { llm, gateModel, judgeModel };

  const perCase  = await runGateEval(cases, consumer, deps);
  const metrics  = consumer.score(perCase);
  const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));
  const markdown = renderMarkdown(metrics, decision, perCase);

  const reportDir = resolveReportDir();
  await fs.promises.mkdir(reportDir, { recursive: true });
  await fs.promises.writeFile(path.join(reportDir, 'skill-judge-report.md'), markdown, 'utf8');
  await fs.promises.writeFile(
    path.join(reportDir, 'skill-judge-report.json'),
    JSON.stringify({ metrics, decision, perCase }, null, 2),
    'utf8',
  );

  return { metrics, decision, perCase, markdown };
}
