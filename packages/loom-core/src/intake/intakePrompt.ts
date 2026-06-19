import type { IntakeVerdict } from './IntakeClassifier.js';

export function buildIntakeSizingInstruction(): string {
  return `## Size classification — epic vs story

Classify as **epic** when ANY of the following are true:
- The change touches multiple functional areas (e.g. auth AND data model AND API)
- The change spans multiple services or repositories
- The change is cross-cutting: affects shared infrastructure, observability, or a platform-wide contract
- The scope cannot be fully specified upfront — acceptance criteria cannot be written before discovery work
- The work would naturally decompose into three or more independent stories

Classify as **story** when ALL of the following are true:
- A single, bounded change within one functional area or service
- Fully specifiable before work begins: acceptance criteria can be written now
- Can be implemented and reviewed as one cohesive unit in a single sprint

**Conservative tiebreak — default to the richer size:**
When there is low confidence, ambiguous scope signals, or any doubt about whether
the brief fits a single bounded change, classify as **epic**, not story.
A story wrongly escalated to an epic costs one planning round.
An epic wrongly compressed to a story causes mid-sprint scope explosion.
Under uncertainty, always resolve to epic.`;
}

/**
 * A story wrongly escalated to an epic costs one planning round; an epic
 * wrongly compressed to a story causes mid-sprint scope explosion — so
 * low-confidence stories are upgraded to epic at the code level.
 */
export function applyConservativeTiebreak(verdict: IntakeVerdict): IntakeVerdict {
  if (verdict.confidence === 'low' && verdict.size === 'story') {
    return { ...verdict, size: 'epic' };
  }
  // Always return a new object so callers can never rely on identity equality.
  return { ...verdict };
}
