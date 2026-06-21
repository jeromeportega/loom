/**
 * Operator entrypoint for the brief-quality eval (ADR-006).
 * NOT a loom subcommand and NOT a worker story — run directly as a Node.js script.
 * Never import this from the planning path or the integration gate.
 */
import type { LLMClient } from '../../llm/LLMClient.js';
import { createLLMClient } from '../../llm/factory.js';
import { DEFAULT_JUDGE_MODEL } from '../framework/models.js';
import { runGateEval } from '../framework/runGateEval.js';
import { decide } from '../framework/decide.js';
import type { RunRecord, Decision } from '../framework/types.js';
import { createBriefQualityConsumer } from './consumer.js';
import type { BriefRefinement } from '../../brief/types.js';
import type { BriefQualityJudgment, BriefQualityMetrics } from './judgeTypes.js';

const DEFAULT_GATE_MODEL = 'claude-opus-4-8';

export interface EvalReport {
  metrics:  BriefQualityMetrics;
  decision: Decision;
  perCase:  RunRecord<BriefRefinement, BriefQualityJudgment>[];
  markdown: string;
}

export interface MainOptions {
  llm?:         LLMClient;
  projectRoot?: string;
  fixturePath?: string;
  gateModel?:   string;
  judgeModel?:  string;
}

function renderMarkdown(
  metrics: BriefQualityMetrics,
  decision: Decision,
  perCase: RunRecord<BriefRefinement, BriefQualityJudgment>[],
): string {
  const lines: string[] = [
    '# Brief-Quality Eval Report',
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
    `| Readiness accuracy | ${pct(metrics.readinessAccuracy)} |`,
    `| Quality-band agreement | ${pct(metrics.qualityBandAgreement)} |`,
    `| Critique quality | ${pct(metrics.critiqueQuality)} |`,
  );

  if (perCase.length > 0) {
    lines.push('', '## Per-Case Results', '', '| Case | Gate | Judge | Correct | In-Band | Fidelity |', '|------|------|-------|---------|---------|---------|');
    for (const r of perCase) {
      const gate = r.gate.status;
      const judge = r.judge.status;
      const correct = r.judge.status === 'ok' ? String(r.judge.judgment.readiness_correct) : '—';
      const inBand = r.judge.status === 'ok' ? String(r.judge.judgment.quality_in_band) : '—';
      const fidelity = r.judge.status === 'ok' ? r.judge.judgment.critique_fidelity : '—';
      lines.push(`| ${r.caseId} | ${gate} | ${judge} | ${correct} | ${inBand} | ${fidelity} |`);
    }
  }

  return lines.join('\n');
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export async function main(opts: MainOptions = {}): Promise<EvalReport> {
  const gateModel  = opts.gateModel  ?? process.env.LOOM_EVAL_GATE_MODEL  ?? DEFAULT_GATE_MODEL;
  const judgeModel = opts.judgeModel ?? process.env.LOOM_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const llm        = opts.llm        ?? createLLMClient('claude-cli');
  const projectRoot = opts.projectRoot ?? process.cwd();

  const consumer = createBriefQualityConsumer({ projectRoot });
  const cases    = consumer.loadCases(opts.fixturePath);
  const deps     = { llm, gateModel, judgeModel };

  const perCase  = await runGateEval(cases, consumer, deps);
  const metrics  = consumer.score(perCase);
  const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));
  const markdown = renderMarkdown(metrics, decision, perCase);

  return { metrics, decision, perCase, markdown };
}
