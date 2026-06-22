import fs from 'node:fs';
import path from 'node:path';
import type { LLMClient } from '../../llm/LLMClient.js';
import { createLLMClient } from '../../llm/factory.js';
import { runGateEval } from '../framework/runGateEval.js';
import { decide } from '../framework/decide.js';
import type { RunRecord, Decision } from '../framework/types.js';
import type { SkillGeneratorDecision, SkillGeneratorJudgment } from './judgeTypes.js';
import type { SkillGeneratorMetrics } from './score.js';
import { createSkillGeneratorConsumer } from './consumer.js';
import { resolveSkillGeneratorModels } from './models.js';

export interface MainOptions {
  llm?:          LLMClient;
  projectRoot?:  string;
  fixturePath?:  string;
  gateModel?:    string;
  judgeModel?:   string;
}

export interface EvalReport {
  metrics:  SkillGeneratorMetrics;
  decision: Decision;
  perCase:  RunRecord<SkillGeneratorDecision, SkillGeneratorJudgment>[];
  markdown: string;
}

function renderMarkdown(
  metrics:  SkillGeneratorMetrics,
  decision: Decision,
  perCase:  RunRecord<SkillGeneratorDecision, SkillGeneratorJudgment>[],
): string {
  const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
  const lines: string[] = [
    '# Skill-Generator Eval Report',
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
    `| Judge inconclusive | ${metrics.judgeInconclusive} (${pct(metrics.judgeInconclusiveRate)}) |`,
    `| Decision correctness | ${pct(metrics.decisionCorrectness)} |`,
    `| Spurious generation rate | ${pct(metrics.spuriousGenerationRate)} |`,
    `| Skill quality | ${pct(metrics.skillQuality)} |`,
    `| Faithfulness | ${pct(metrics.faithfulness)} |`,
    `| Low-quality rate | ${pct(metrics.lowQualityRate)} |`,
  );

  if (perCase.length > 0) {
    lines.push(
      '',
      '## Per-Case Results',
      '',
      '| Case | Gate | Judge | Decision | Quality | Faithfulness | Spurious | Low-Quality |',
      '|------|------|-------|----------|---------|-------------|----------|-------------|',
    );
    for (const r of perCase) {
      const gateStatus = r.gate.status;
      const judgeStatus = r.judge.status;
      const dec     = r.gate.status === 'ok' ? r.gate.output.decision : '—';
      const quality = r.judge.status === 'ok'
        ? pct((r.judge.judgment.well_formed + r.judge.judgment.reusable + r.judge.judgment.scope_appropriateness) / 3)
        : '—';
      const faith   = r.judge.status === 'ok' ? pct(r.judge.judgment.faithfulness) : '—';
      const spur    = r.judge.status === 'ok' ? String(r.judge.judgment.spurious) : '—';
      const lowQ    = r.judge.status === 'ok' ? String(r.judge.judgment.low_quality) : '—';
      lines.push(`| ${r.caseId} | ${gateStatus} | ${judgeStatus} | ${dec} | ${quality} | ${faith} | ${spur} | ${lowQ} |`);
    }
  }

  return lines.join('\n');
}

export async function main(opts: MainOptions = {}): Promise<EvalReport> {
  const { gateModel, judgeModel } = resolveSkillGeneratorModels({
    gateModel:  opts.gateModel,
    judgeModel: opts.judgeModel,
  });
  // __dirname available: loom-core is "type":"commonjs" (package.json).
  // Three levels up from dist/eval/skill-generator/ → package root (packages/loom-core).
  // Callers that want workspace-root reports must pass projectRoot explicitly (the runner script does).
  const projectRoot = opts.projectRoot ?? path.resolve(__dirname, '../../..');
  const llm = opts.llm ?? createLLMClient('claude-cli');

  const consumer = createSkillGeneratorConsumer({ projectRoot });
  const cases    = consumer.loadCases(opts.fixturePath);
  const deps     = { llm, gateModel, judgeModel };

  const perCase  = await runGateEval(cases, consumer, deps);
  const metrics  = consumer.score(perCase);
  const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));
  const markdown = renderMarkdown(metrics, decision, perCase);

  const reportDir = path.resolve(projectRoot, '.loom/eval');
  await fs.promises.mkdir(reportDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(reportDir, 'skill-generator-report.md'),
    markdown,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(reportDir, 'skill-generator-report.json'),
    JSON.stringify({ metrics, decision, perCase }, null, 2),
    'utf8',
  );

  return { metrics, decision, perCase, markdown };
}
