/**
 * Intake routing seam — shared between loom-cli (producer) and the planner (consumer).
 * Both import `EffectiveRouting` and `buildSizingConstraintBlock` from here.
 */

export interface EffectiveRouting {
  type:       'feature' | 'bug' | 'chore';
  size:       'story' | 'epic';
  confidence: 'low' | 'medium' | 'high';
  /**
   * 'classifier' = intake classifier produced the verdict.
   * 'operator-override' = operator changed it at the confirm prompt (story-045-003).
   * Only 'classifier' is produced until story-045-003 lands.
   */
  source:     'classifier' | 'operator-override';
}

/**
 * True iff the planner should take the standalone-story path (epic-047).
 * `routing === undefined` (intake_routing:off or classifier failure) ALWAYS
 * returns false — the off-path and classification-failure path can never enter
 * the standalone branch (ADR-001, NFR-1).
 *
 * This is the SINGLE source of truth for the branch gate; every site that needs
 * to check "are we standalone?" must import and call this function rather than
 * comparing routing.size inline.
 */
export function isStandalone(routing?: EffectiveRouting): boolean {
  return routing !== undefined && routing.size === 'story';
}

/**
 * Derives the flat story id for a standalone container.
 * Producer: called ONCE in Planner.runStandalone at planning time.
 * Consumers (Supervisor dispatch, presentation sites) read the persisted
 * agents.story_id — they MUST NOT re-derive this value.
 *
 * Example: 'epic-047' → 'story-047'  (same NNN, no phantom sub-id)
 */
export function standaloneStoryId(containerEpicId: string): string {
  return containerEpicId.replace(/^epic-/, 'story-');
}

/**
 * Derives the git branch name for a standalone story worktree.
 * Example: 'story-047' → 'story/story-047'  (flat, no phantom epic id segment)
 */
export function standaloneBranch(storyId: string): string {
  return `story/${storyId}`;
}

/**
 * Builds the sizing constraint block appended to the PM agent's task B prompt.
 * One builder, reused verbatim by both advisory and confirm — never duplicated.
 *
 * When routing is absent the PM message is unchanged (NFR-1: byte-identical off-path).
 */
export function buildSizingConstraintBlock(routing: EffectiveRouting): string {
  switch (routing.size) {
    case 'story':
      return (
        '\n\n## Sizing constraint (intake classifier)\n\n' +
        'The intake classifier scored this request as story-sized. ' +
        'Produce a single cohesive story or the minimum necessary decomposition — ' +
        'do NOT expand this into a multi-story epic unless the work genuinely ' +
        'requires parallel, independently deliverable tracks.'
      );
    case 'epic':
      return (
        '\n\n## Sizing constraint (intake classifier)\n\n' +
        'The intake classifier scored this request as epic-sized. ' +
        'Perform a full decomposition: break this into the smallest independently ' +
        'deliverable stories, as you would for any standard epic.'
      );
    default: {
      const _: never = routing.size;
      return '';
    }
  }
}
