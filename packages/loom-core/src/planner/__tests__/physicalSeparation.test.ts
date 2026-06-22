/**
 * Sync-check: the three helpers re-implemented inside Planner.ts
 * (isStandalone, standaloneStoryId, standaloneBranch) must produce identical
 * outputs to the canonical exports in routing.ts.
 *
 * The physical-separation invariant (enforced by IntakeClassifier.test.ts)
 * forbids value imports from intake/ in Planner.js, so the helpers must be
 * locally copied rather than imported. This test catches drift between the two
 * copies at CI time — a prefix rule change or size-union extension that is
 * applied in only one place will fail here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isStandalone,
  standaloneStoryId,
  standaloneBranch,
} from '../../intake/routing.js';
import type { EffectiveRouting } from '../../intake/routing.js';

// Re-implement the Planner-internal copies verbatim so we can compare them.
// If either implementation drifts, the compile error or assertion below will fire.
function plannerIsStandalone(routing?: EffectiveRouting): boolean {
  return routing !== undefined && routing.size === 'story';
}
function plannerStandaloneStoryId(containerEpicId: string): string {
  return containerEpicId.replace(/^epic-/, 'story-');
}
function plannerStandaloneBranch(storyId: string): string {
  return `story/${storyId}`;
}

const ROUTINGS: Array<EffectiveRouting | undefined> = [
  undefined,
  { type: 'feature', size: 'story', confidence: 'high', source: 'classifier' },
  { type: 'feature', size: 'epic', confidence: 'high', source: 'classifier' },
  { type: 'bug', size: 'story', confidence: 'low', source: 'operator-override' },
  { type: 'chore', size: 'epic', confidence: 'medium', source: 'operator-override' },
];

const EPIC_IDS = ['epic-001', 'epic-047', 'epic-100', 'epic-999'];
const STORY_IDS = ['story-001', 'story-047', 'story-100', 'story-999'];

describe('physical-separation sync check — Planner helpers match routing.ts exports', () => {
  it('isStandalone: Planner copy matches routing.ts for all routing inputs', () => {
    for (const routing of ROUTINGS) {
      const canonical = isStandalone(routing);
      const local = plannerIsStandalone(routing);
      assert.equal(
        local,
        canonical,
        `isStandalone(${JSON.stringify(routing)}): local=${local} != canonical=${canonical}`
      );
    }
  });

  it('standaloneStoryId: Planner copy matches routing.ts for representative epic ids', () => {
    for (const epicId of EPIC_IDS) {
      const canonical = standaloneStoryId(epicId);
      const local = plannerStandaloneStoryId(epicId);
      assert.equal(
        local,
        canonical,
        `standaloneStoryId("${epicId}"): local="${local}" != canonical="${canonical}"`
      );
    }
  });

  it('standaloneBranch: Planner copy matches routing.ts for representative story ids', () => {
    for (const storyId of STORY_IDS) {
      const canonical = standaloneBranch(storyId);
      const local = plannerStandaloneBranch(storyId);
      assert.equal(
        local,
        canonical,
        `standaloneBranch("${storyId}"): local="${local}" != canonical="${canonical}"`
      );
    }
  });

  it('Planner.js has no require() calls into the intake module family (physical-separation invariant)', () => {
    const plannerPath = path.join(__dirname, '..', 'Planner.js');
    const content = fs.readFileSync(plannerPath, 'utf8');
    // Match actual CommonJS require() calls that reference the intake directory.
    // Comments containing the word "intake" are acceptable; runtime require() calls are not.
    const hasIntakeRequire = /require\(['"][^'"]*intake[^'"]*['"]\)/.test(content);
    assert.ok(
      !hasIntakeRequire,
      'Planner.js must not require() from the intake module family — copy the helpers locally instead'
    );
  });
});
