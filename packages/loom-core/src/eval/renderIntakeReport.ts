import fs from 'node:fs';
import path from 'node:path';
import type { IntakeEvalReport, AxisReport, ConfusionMatrix } from './intakeEvalTypes.js';

function renderConfusionMatrix(matrix: ConfusionMatrix): string {
  const { labels, counts } = matrix;

  // Header row
  const headerCells = ['', ...labels.map(l => `predicted:${l}`)];
  const header = `| ${headerCells.join(' | ')} |`;
  const separator = `| ${headerCells.map(() => '---').join(' | ')} |`;

  const rows = labels.map(lab => {
    const cells = [
      `**${lab}**`,
      ...labels.map(pred => String(counts[lab]?.[pred] ?? 0)),
    ];
    return `| ${cells.join(' | ')} |`;
  });

  return [header, separator, ...rows].join('\n');
}

function renderAxisReport(ar: AxisReport): string {
  const { axis, accuracy, confusion, judgeVsClassifier, judgeVsHuman, disagreements, dangerousConfusions, verdict } = ar;

  const pct = accuracy.scored > 0 ? Math.round((accuracy.correct / accuracy.scored) * 100) : 0;

  const lines: string[] = [
    `## ${axis.charAt(0).toUpperCase() + axis.slice(1)} Axis`,
    '',
    `**Accuracy:** ${accuracy.correct}/${accuracy.scored} correct (${pct}%)`,
    '',
    '### Confusion Matrix',
    '',
    renderConfusionMatrix(confusion),
    '',
    '### Agreement',
    '',
    `- Judge vs Classifier: agree ${judgeVsClassifier.agree} | disagree ${judgeVsClassifier.disagree} | inconclusive ${judgeVsClassifier.inconclusive}`,
    `- Judge vs Human: agree ${judgeVsHuman.agree} | disagree ${judgeVsHuman.disagree} | inconclusive ${judgeVsHuman.inconclusive}`,
    '',
    `### Disagreements (${disagreements.length})`,
    '',
  ];

  if (disagreements.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Case | Labeled | Predicted | Judge | Rationale |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const d of disagreements) {
      const rationale = d.rationale.replace(/\|/g, '\\|');
      lines.push(`| ${d.caseId} | ${d.labeled} | ${d.predicted} | ${d.judge} | ${rationale} |`);
    }
  }

  lines.push('');
  lines.push('### Dangerous Confusions');
  lines.push('');

  if (dangerousConfusions.length === 0) {
    lines.push(axis === 'size'
      ? 'None detected (0 epic→story under-sizing cases).'
      : 'None defined for type axis.');
  } else {
    for (const dc of dangerousConfusions) {
      lines.push(`**${dc.from} → ${dc.to}:** ${dc.count} case(s) — ${dc.caseIds.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('### Verdict');
  lines.push('');
  lines.push(verdict.statement);

  return lines.join('\n');
}

function renderMarkdown(report: IntakeEvalReport): string {
  const { failureCounts: fc, thresholds: th } = report;

  const lines: string[] = [
    '# Intake Classifier Evaluation Report',
    '',
    `Generated from **${report.generatedFromCases}** cases — classifier: \`${report.classifierModel}\`, judge: \`${report.judgeModel}\``,
    '',
    `**Inconclusive judge calls:** ${report.inconclusiveJudgeCount}`,
    '',
    '### Failure Counts',
    '',
    `- Scored: ${fc.scored} of ${fc.total}`,
    `- timeout: ${fc.timeout} | invalid_output: ${fc.invalid_output} | llm_error: ${fc.llm_error}`,
    '',
    '### Thresholds',
    '',
    `- minScoredCases: ${th.minScoredCases}`,
    `- maxClassifierFailureRate: ${(th.maxClassifierFailureRate * 100).toFixed(0)}%`,
    `- maxJudgeInconclusiveRate: ${(th.maxJudgeInconclusiveRate * 100).toFixed(0)}%`,
    '',
    '---',
    '',
  ];

  for (const axisReport of report.axes) {
    lines.push(renderAxisReport(axisReport));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## Overall');
  lines.push('');
  lines.push(`**Decision:** ${report.overall.decision}`);
  lines.push('');
  lines.push(report.overall.statement);
  lines.push('');

  return lines.join('\n');
}

export function renderIntakeReport(report: IntakeEvalReport): { markdown: string; json: string } {
  const markdown = renderMarkdown(report);
  const json = JSON.stringify(report, null, 2);
  return { markdown, json };
}

/**
 * Writes intake-report.md and intake-report.json to outputDir.
 * Both derive from a single renderIntakeReport call so they cannot drift (ADR-007).
 */
export function writeIntakeReportFiles(report: IntakeEvalReport, outputDir: string): void {
  const { markdown, json } = renderIntakeReport(report);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'intake-report.md'), markdown, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'intake-report.json'), json, 'utf8');
}
