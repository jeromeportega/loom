import fs from 'node:fs';
import path from 'node:path';
import type { LLMClient } from '../../llm/LLMClient.js';
import { createLLMClient } from '../../llm/factory.js';
import { runGateEval } from '../framework/runGateEval.js';
import { decide } from '../framework/decide.js';
import type { RunRecord, Decision } from '../framework/types.js';
import type { Lesson } from '../../findings/lesson.js';
import type { LessonExtractorJudgment } from './judgeTypes.js';
import type { LessonExtractorMetrics } from './score.js';
import { createLessonExtractorConsumer } from './consumer.js';
import { resolveLessonExtractorModels } from './models.js';

export interface MainOptions {
  llm?:         LLMClient;
  projectRoot?: string;
  fixturePath?: string;
  gateModel?:   string;
  judgeModel?:  string;
}

export interface EvalReport {
  metrics:  LessonExtractorMetrics;
  decision: Decision;
  perCase:  RunRecord<Lesson[], LessonExtractorJudgment>[];
  markdown: string;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function renderMarkdown(
  metrics: LessonExtractorMetrics,
  decision: Decision,
  perCase: RunRecord<Lesson[], LessonExtractorJudgment>[],
): string {
  const lines: string[] = [
    '# Lesson-Extractor Eval Report',
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
    `| Faithfulness | ${pct(metrics.faithfulness)} |`,
    `| Usefulness | ${pct(metrics.usefulness)} |`,
    `| Coverage | ${pct(metrics.coverage)} |`,
    `| Hallucination rate | ${pct(metrics.hallucinationRate)} |`,
    `| Over-extraction rate | ${pct(metrics.overExtractionRate)} |`,
  );

  if (perCase.length > 0) {
    lines.push(
      '',
      '## Per-Case Results',
      '',
      '| Case | Gate | Judge | Faithfulness | Usefulness | Coverage | Hallucinated | Over-extracted |',
      '|------|------|-------|-------------|------------|----------|-------------|----------------|',
    );
    for (const r of perCase) {
      const gate  = r.gate.status;
      const judge = r.judge.status;
      const faith = r.judge.status === 'ok' ? pct(r.judge.judgment.faithfulness) : '—';
      const useful = r.judge.status === 'ok' ? pct(r.judge.judgment.usefulness) : '—';
      const cov   = r.judge.status === 'ok' ? r.judge.judgment.coverage : '—';
      const hall  = r.judge.status === 'ok' ? String(r.judge.judgment.hallucinated_lessons) : '—';
      const over  = r.judge.status === 'ok' ? String(r.judge.judgment.over_extraction) : '—';
      lines.push(`| ${r.caseId} | ${gate} | ${judge} | ${faith} | ${useful} | ${cov} | ${hall} | ${over} |`);
    }
  }

  return lines.join('\n');
}

export async function main(opts: MainOptions = {}): Promise<EvalReport> {
  const { gateModel, judgeModel } = resolveLessonExtractorModels({
    gateModel:  opts.gateModel,
    judgeModel: opts.judgeModel,
  });
  // Default projectRoot: three levels up from compiled dist/eval/lesson-extractor/ → package root
  const projectRoot = opts.projectRoot ?? path.resolve(__dirname, '../../..');
  const llm = opts.llm ?? createLLMClient('claude-cli');

  const consumer = createLessonExtractorConsumer({ projectRoot });
  const cases    = consumer.loadCases(opts.fixturePath);
  const deps     = { llm, gateModel, judgeModel };

  const perCase  = await runGateEval(cases, consumer, deps);
  const metrics  = consumer.score(perCase);
  const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));
  const markdown = renderMarkdown(metrics, decision, perCase);

  const reportDir = path.resolve(projectRoot, '.loom/eval');
  await fs.promises.mkdir(reportDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(reportDir, 'lesson-extractor-report.md'),
    markdown,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(reportDir, 'lesson-extractor-report.json'),
    JSON.stringify({ metrics, decision, perCase }, null, 2),
    'utf8',
  );

  return { metrics, decision, perCase, markdown };
}
