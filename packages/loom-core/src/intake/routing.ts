/**
 * Intake routing seam — shared between loom-cli (producer) and the planner (consumer).
 * Both import `EffectiveRouting` and `buildSizingConstraintBlock` from here.
 */

export interface EffectiveRouting {
  type:       'feature' | 'bug' | 'chore';
  size:       'story' | 'epic';
  confidence: 'low' | 'medium' | 'high';
  /** 'classifier' = the intake classifier produced the verdict; 'operator-override' = the operator changed it at the confirm prompt. */
  source:     'classifier' | 'operator-override';
}

/**
 * Builds the sizing constraint block appended to the PM agent's task B prompt.
 * One builder, reused verbatim by both advisory and confirm — never duplicated.
 *
 * When routing is absent the PM message is unchanged (NFR-1: byte-identical off-path).
 */
export function buildSizingConstraintBlock(routing: EffectiveRouting): string {
  if (routing.size === 'story') {
    return (
      '\n\n## Sizing constraint (intake classifier)\n\n' +
      'The intake classifier scored this request as story-sized. ' +
      'Produce a single cohesive story or the minimum necessary decomposition — ' +
      'do NOT expand this into a multi-story epic unless the work genuinely ' +
      'requires parallel, independently deliverable tracks.'
    );
  }
  // size === 'epic'
  return (
    '\n\n## Sizing constraint (intake classifier)\n\n' +
    'The intake classifier scored this request as epic-sized. ' +
    'Perform a full decomposition: break this into the smallest independently ' +
    'deliverable stories, as you would for any standard epic.'
  );
}
