import type { GateVerdict, BriefRefinement } from '@loom-ai/core';

/**
 * The pass-with-clarifications notice printed on exit 3.
 * Clarifications are listed as OPTIONAL; the --force flag is mentioned.
 * Story-012-002 owns this file and will replace the stub body with final copy.
 */
export function formatClarificationsNotice(
  verdict: GateVerdict,
  refinement: Pick<BriefRefinement, 'questions' | 'refined_brief'>,
): string {
  // TODO(story-012-002): render refinement.refined_brief as the suggested brief block.
  const lines: string[] = [
    '',
    `  Brief scored ${verdict.quality_score}/10 (>= ${verdict.threshold}) — ready with optional clarifications.`,
  ];
  if (refinement.questions.length > 0) {
    lines.push('');
    lines.push('  Optional clarifications (address these for a cleaner plan):');
    for (const q of refinement.questions) lines.push(`    • ${q}`);
  }
  lines.push('');
  lines.push('  Re-run `loom epic "<brief>" --force` to plan as-is.');
  lines.push('');
  return lines.join('\n');
}
