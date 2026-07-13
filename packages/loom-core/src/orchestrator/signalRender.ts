import type { StorySignals } from '../types.js';

export interface SignalRenderInput {
  /** Latest StorySignals per story id, from SignalLedger.readEpic. */
  records: Map<string, StorySignals>;
  /**
   * Per-story finalization outcomes. `null` fields mean the granularity is
   * unavailable (e.g. gate is epic-level today, ADR-6) — renderer degrades to
   * emitting heuristics + tier without asserting the over-spend flag.
   */
  outcomes: Map<string, { reviewFindings: number | null; gateGreen: boolean | null }>;
  /** Story IDs in topological order (from EpicFinalizer). */
  storyOrder: string[];
}

/**
 * Renders the "Build signal analysis" PR-body section. Pure function — no I/O,
 * no side effects, no database access. Appended to the epic PR body by
 * EpicFinalizer.finalize after the integration-gate section.
 *
 * Over-spend flag (FR-7): a story is flagged iff tier==='heavy' AND
 * reviewFindings===0 AND gateGreen===true. Any null field degrades gracefully
 * — heuristics + tier are emitted without the flag (ADR-6). Under-spend is
 * never flagged.
 */
export function renderBuildSignalAnalysis(input: SignalRenderInput): string {
  const { records, outcomes, storyOrder } = input;
  const lines: string[] = ['## Build signal analysis', ''];

  for (const storyId of storyOrder) {
    const signals = records.get(storyId);
    if (!signals) continue;

    lines.push(`### ${storyId}`, '');

    if (signals.heuristics) {
      const h = signals.heuristics;
      lines.push('**Heuristics**', '');
      lines.push(`- diff_lines: ${h.diff_lines}`);
      lines.push(`- diff_files: ${h.diff_files}`);
      lines.push(`- tests_green_first_try: ${h.tests_green_first_try}`);
      lines.push('');
    }

    lines.push(`**Recommended tier:** ${signals.tier}`);
    lines.push('', '**Steps:**');
    lines.push(`- reviewers: ${signals.steps.reviewers}`);
    lines.push(`- verify_phase: ${signals.steps.verify_phase}`);
    lines.push(`- skill_gen: ${signals.steps.skill_gen}`);
    lines.push('');

    // Over-spend flag (FR-7): fires iff tier=heavy AND reviewFindings===0 AND
    // gateGreen===true. Null in either outcome field → degrade gracefully (ADR-6).
    const outcome = outcomes.get(storyId);
    if (
      outcome &&
      signals.tier === 'heavy' &&
      outcome.reviewFindings === 0 &&
      outcome.gateGreen === true
    ) {
      lines.push(
        '> **Over-spend candidate:** Recommended `heavy` but finalized with no review',
        '> findings and a green gate. Future gating could safely downgrade.',
        ''
      );
    }
  }

  return lines.join('\n');
}
