/**
 * Sync-check: the three helpers exported from Planner.ts
 * (_plannerIsStandalone, _plannerStandaloneStoryId, _plannerStandaloneBranch)
 * must produce identical outputs to the canonical exports in routing.ts.
 *
 * The physical-separation invariant (enforced by the `require()` check below)
 * forbids value imports from intake/ in Planner.js, so the helpers must be
 * locally defined in Planner.ts rather than re-imported. This test catches
 * drift between the two copies at CI time — a prefix rule change or size-union
 * extension applied in only one place will fail here.
 *
 * NOTE: This test reads the compiled dist/planner/Planner.js for the require()
 * check (the last test case). It must run against a freshly built output.
 * "npm test" in loom-core always runs "tsc" before executing dist/ tests,
 * so stale artifacts are not a concern in CI. Running this file directly via
 * ts-node or tsx (without a prior "tsc") will skip the require() check.
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
import {
  _plannerIsStandalone,
  _plannerStandaloneStoryId,
  _plannerStandaloneBranch,
} from '../Planner.js';

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
  it('_plannerIsStandalone: Planner.ts copy matches routing.ts for all routing inputs', () => {
    for (const routing of ROUTINGS) {
      const canonical = isStandalone(routing);
      const local = _plannerIsStandalone(routing);
      assert.equal(
        local,
        canonical,
        `isStandalone(${JSON.stringify(routing)}): Planner copy=${local} != routing.ts=${canonical}`
      );
    }
  });

  it('_plannerStandaloneStoryId: Planner.ts copy matches routing.ts for representative epic ids', () => {
    for (const epicId of EPIC_IDS) {
      const canonical = standaloneStoryId(epicId);
      const local = _plannerStandaloneStoryId(epicId);
      assert.equal(
        local,
        canonical,
        `standaloneStoryId("${epicId}"): Planner copy="${local}" != routing.ts="${canonical}"`
      );
    }
  });

  it('_plannerStandaloneBranch: Planner.ts copy matches routing.ts for representative story ids', () => {
    for (const storyId of STORY_IDS) {
      const canonical = standaloneBranch(storyId);
      const local = _plannerStandaloneBranch(storyId);
      assert.equal(
        local,
        canonical,
        `standaloneBranch("${storyId}"): Planner copy="${local}" != routing.ts="${canonical}"`
      );
    }
  });

  it('Planner.js has no require() calls into the intake module family (physical-separation invariant)', () => {
    // __dirname at runtime (compiled) = dist/planner/__tests__/
    // path.join(__dirname, '..', 'Planner.js') = dist/planner/Planner.js
    const plannerPath = path.join(__dirname, '..', 'Planner.js');
    if (!fs.existsSync(plannerPath)) {
      // Running via ts-node/tsx without a prior build — skip the compiled-JS check.
      // The import above already exercises Planner.ts at the TypeScript level;
      // this check only catches runtime `require()` calls in the compiled output.
      return;
    }
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
