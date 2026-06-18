import type { GateVerdict, BriefRefinement } from '@loom-ai/core';

/**
 * The PASSED-with-clarifications notice. Clarifications listed as OPTIONAL;
 * embeds the literal force flag "--force" and is visibly distinct from the
 * below-threshold console.error rejection block. Returns the string; the
 * caller prints it to stdout.
 */
export function formatClarificationsNotice(
  verdict: GateVerdict,
  refinement: Pick<BriefRefinement, 'questions' | 'refined_brief'>,
): string {
  const lines: string[] = [
    '',
    `  PASSED-with-clarifications  (${verdict.quality_score}/10 >= ${verdict.threshold})`,
    '',
    '  The brief scored above the quality threshold. You can proceed to planning.',
  ];

  if (refinement.questions.length > 0) {
    lines.push('');
    lines.push('  OPTIONAL — addressing these makes the plan sharper:');
    for (const q of refinement.questions) lines.push(`    • ${q}`);
  }

  lines.push('');
  lines.push('  To plan as-is:     loom epic "<brief>" --force');
  if (refinement.questions.length > 0) {
    lines.push('  Or tighten the brief and re-run to resolve these clarifications.');
  }
  lines.push('');

  return lines.join('\n');
}
