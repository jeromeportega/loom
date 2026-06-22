import fs from 'node:fs';
import path from 'node:path';
import type { LLMClient } from '../../llm/LLMClient.js';
import { createLLMClient } from '../../llm/factory.js';
import { runGateEval } from '../framework/runGateEval.js';
import { decide } from '../framework/decide.js';
import type { RunRecord, Decision } from '../framework/types.js';
import type { OpportunityRecord } from '../../signals/OpportunityEngine.js';
import type { OpportunityEngineJudgment } from './judgeTypes.js';
import type { OpportunityEngineMetrics } from './score.js';
import { createOpportunityEngineConsumer } from './consumer.js';
import { resolveOpportunityEngineModels } from './models.js';

export interface MainOptions {
  llm?:         LLMClient;
  projectRoot?: string;
  fixturePath?: string;
  gateModel?:   string;
  judgeModel?:  string;
}

export interface EvalReport {
  metrics:  OpportunityEngineMetrics;
  decision: Decision;
  perCase:  RunRecord<OpportunityRecord[], OpportunityEngineJudgment>[];
  markdown: string;
}

function renderMarkdown(
  metrics: OpportunityEngineMetrics,
  decision: Decision,
  perCase: RunRecord<OpportunityRecord[], OpportunityEngineJudgment>[],
): string {
  const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
  const lines: string[] = [
    '# Opportunity-Engine Eval Report',
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
    `| Coherence | ${pct(metrics.coherence)} |`,
    `| Score reasonableness | ${pct(metrics.scoreReasonableness)} |`,
    `| Grounding | ${pct(metrics.grounding)} |`,
    `| Forced clustering rate | ${pct(metrics.forcedClusteringRate)} |`,
    `| Hallucination rate | ${pct(metrics.hallucinationRate)} |`,
  );

  if (perCase.length > 0) {
    lines.push(
      '',
      '## Per-Case Results',
      '',
      '| Case | Gate | Judge | Coherence | Score Reasonableness | Grounding | Forced Clusters | Hallucinations |',
      '|------|------|-------|-----------|---------------------|-----------|-----------------|----------------|',
    );
    for (const r of perCase) {
      const gate  = r.gate.status;
      const judge = r.judge.status;
      const coh   = r.judge.status === 'ok' ? pct(r.judge.judgment.coherence) : '—';
      const sr    = r.judge.status === 'ok' ? pct(r.judge.judgment.score_reasonableness) : '—';
      const grd   = r.judge.status === 'ok' ? pct(r.judge.judgment.grounding) : '—';
      const fc    = r.judge.status === 'ok' ? String(r.judge.judgment.forced_clusters) : '—';
      const hall  = r.judge.status === 'ok'
        ? String(r.judge.judgment.invented_opportunities + r.judge.judgment.nonexistent_signal_ids)
        : '—';
      lines.push(`| ${r.caseId} | ${gate} | ${judge} | ${coh} | ${sr} | ${grd} | ${fc} | ${hall} |`);
    }
  }

  return lines.join('\n');
}

export async function main(opts: MainOptions = {}): Promise<EvalReport> {
  const { gateModel, judgeModel } = resolveOpportunityEngineModels({
    gateModel:  opts.gateModel,
    judgeModel: opts.judgeModel,
  });
  // __dirname available: loom-core is "type":"commonjs" (package.json).
  // Three levels up from dist/eval/opportunity-engine/ → package root (packages/loom-core).
  // Callers that want workspace-root reports must pass projectRoot explicitly (the runner script does).
  const projectRoot = opts.projectRoot ?? path.resolve(__dirname, '../../..');
  const llm = opts.llm ?? createLLMClient('claude-cli');

  const consumer = createOpportunityEngineConsumer({ projectRoot });
  const cases    = consumer.loadCases(opts.fixturePath);
  const deps     = { llm, gateModel, judgeModel };

  const perCase  = await runGateEval(cases, consumer, deps);
  const metrics  = consumer.score(perCase);
  const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));
  const markdown = renderMarkdown(metrics, decision, perCase);

  const reportDir = path.resolve(projectRoot, '.loom/eval');
  await fs.promises.mkdir(reportDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(reportDir, 'opportunity-engine-report.md'),
    markdown,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(reportDir, 'opportunity-engine-report.json'),
    JSON.stringify({ metrics, decision, perCase }, null, 2),
    'utf8',
  );

  return { metrics, decision, perCase, markdown };
}
