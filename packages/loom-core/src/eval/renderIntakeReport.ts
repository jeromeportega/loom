import fs from 'node:fs';
import path from 'node:path';
import type { IntakeEvalReport, AxisReport, ConfusionMatrix, DualIntakeReport } from './intakeEvalTypes.js';

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
  const lines: string[] = [
    '# Intake Classifier Evaluation Report',
    '',
    `Generated from **${report.generatedFromCases}** cases — classifier: \`${report.classifierModel}\`, judge: \`${report.judgeModel}\``,
    '',
    `**Inconclusive judge calls:** ${report.inconclusiveJudgeCount}`,
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
  if (report.gate.decision !== 'proceed') {
    // Gate is authoritative — the axis quality bar result below may say 'proceed'
    // but the gate overrides it based on failure rates or insufficient sample size.
    lines.push(`> **Note:** Gate decision is \`${report.gate.decision}\` (see Gate Decision below). ` +
      `The axis quality bar result is informational only when the gate is not \`proceed\`.`);
    lines.push('');
  }
  lines.push(`**Axis quality bar (per-axis dangerous confusions):** ${report.overall.proceed ? 'Cleared' : 'Not cleared'}`);
  lines.push('');
  lines.push(report.overall.statement);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Gate Decision');
  lines.push('');
  lines.push(`**Decision:** \`${report.gate.decision}\``);
  lines.push('');
  lines.push(report.gate.statement);
  lines.push('');
  lines.push(`**Scored cases (ok classifier + conclusive judge):** ${report.scoredCases} / ${report.generatedFromCases} total (minimum required: ${report.gate.minScoredCases})`);
  lines.push('');
  lines.push(`**Failure rate threshold:** ${Math.round(report.gate.maxFailureRate * 100)}%`);
  lines.push('');
  lines.push('### Failure Counts');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Classifier: llm_error | ${report.failureCounts.classifier.llm_error} |`);
  lines.push(`| Classifier: timeout | ${report.failureCounts.classifier.timeout} |`);
  lines.push(`| Classifier: invalid_output | ${report.failureCounts.classifier.invalid_output} |`);
  lines.push(`| Judge: inconclusive (total) | ${report.failureCounts.judgeInconclusive} |`);
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

// ── Dual (raw + refined) rendering ──────────────────────────────────────────

function computeUnderSizingCount(report: IntakeEvalReport): number {
  const sizeAxis = report.axes.find(a => a.axis === 'size');
  if (!sizeAxis) return 0;
  const dc = sizeAxis.dangerousConfusions.find(d => d.from === 'epic' && d.to === 'story');
  return dc?.count ?? 0;
}

function renderComparisonTable(comparison: NonNullable<DualIntakeReport['comparison']>): string {
  const { typeAccuracy, sizeAccuracy, underSizing, refinerFailures } = comparison;

  const pct = (c: number, s: number) => (s > 0 ? Math.round((c / s) * 100) : 0);

  const rawTypePct = pct(typeAccuracy.raw.correct, typeAccuracy.raw.scored);
  const refinedTypePct = pct(typeAccuracy.refined.correct, typeAccuracy.refined.scored);
  const rawSizePct = pct(sizeAccuracy.raw.correct, sizeAccuracy.raw.scored);
  const refinedSizePct = pct(sizeAccuracy.refined.correct, sizeAccuracy.refined.scored);

  return [
    '| Metric | Raw brief | Refined brief |',
    '| --- | --- | --- |',
    `| Type accuracy | ${typeAccuracy.raw.correct}/${typeAccuracy.raw.scored} (${rawTypePct}%) | ${typeAccuracy.refined.correct}/${typeAccuracy.refined.scored} (${refinedTypePct}%) |`,
    `| Size accuracy | ${sizeAccuracy.raw.correct}/${sizeAccuracy.raw.scored} (${rawSizePct}%) | ${sizeAccuracy.refined.correct}/${sizeAccuracy.refined.scored} (${refinedSizePct}%) |`,
    `| Epic→story under-sizing | ${underSizing.raw} | ${underSizing.refined} |`,
    `| Refiner failures | — | ${refinerFailures} |`,
  ].join('\n');
}

/**
 * Renders a DualIntakeReport to markdown and JSON.
 *
 * Off-path (dual.refined === undefined): MUST return renderIntakeReport(dual.raw) verbatim,
 * byte-for-byte identical, so intake-report.{md,json} are unchanged when the flag is off (FR-8).
 *
 * On-path (dual.refined present): appends a clearly-labeled "Refined-brief variant" section and
 * a raw-vs-refined comparison table; the JSON gains top-level `refined` and `comparison` keys
 * while `raw` stays untouched (additive only).
 */
export function renderIntakeReportDual(dual: DualIntakeReport): { markdown: string; json: string } {
  if (dual.refined === undefined) {
    return renderIntakeReport(dual.raw);
  }

  const refined = dual.refined;

  const rawTypeAxis = dual.raw.axes.find(a => a.axis === 'type')!;
  const rawSizeAxis = dual.raw.axes.find(a => a.axis === 'size')!;
  const refinedTypeAxis = refined.axes.find(a => a.axis === 'type')!;
  const refinedSizeAxis = refined.axes.find(a => a.axis === 'size')!;

  const comparison: NonNullable<DualIntakeReport['comparison']> = {
    typeAccuracy: { raw: rawTypeAxis.accuracy, refined: refinedTypeAxis.accuracy },
    sizeAccuracy: { raw: rawSizeAxis.accuracy, refined: refinedSizeAxis.accuracy },
    underSizing: {
      raw: computeUnderSizingCount(dual.raw),
      refined: computeUnderSizingCount(refined),
    },
    // refinerFailures: use pre-populated value if caller supplied it; otherwise fall back
    // to the refined report's llm_error classifier count (refiner failures are synthesized
    // as llm_error records — ADR-005 — so this is the best proxy from the reports alone).
    refinerFailures: dual.comparison?.refinerFailures ?? refined.failureCounts.classifier.llm_error,
  };

  const rawMarkdown = renderMarkdown(dual.raw);

  // Render the refined report and drop its "# Intake Classifier Evaluation Report\n\n" heading
  // so the section nests cleanly under the "## Refined-brief variant" H2.
  const refinedFull = renderMarkdown(refined);
  const refinedBody = refinedFull.split('\n').slice(2).join('\n');

  const markdown = [
    rawMarkdown,
    '',
    '---',
    '',
    '## Refined-brief variant',
    '',
    refinedBody,
    '---',
    '',
    '## Raw vs Refined Comparison',
    '',
    renderComparisonTable(comparison),
  ].join('\n');

  const json = JSON.stringify({ raw: dual.raw, refined, comparison }, null, 2);

  return { markdown, json };
}

/**
 * Writes intake-report.md and intake-report.json from a DualIntakeReport.
 * Off-path (no refined): output is byte-identical to writeIntakeReportFiles (FR-8).
 * On-path (refined present): the dual markdown and additive JSON are written instead.
 */
export function writeIntakeReportDualFiles(dual: DualIntakeReport, outputDir: string): void {
  const { markdown, json } = renderIntakeReportDual(dual);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'intake-report.md'), markdown, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'intake-report.json'), json, 'utf8');
}
