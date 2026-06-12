import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/state/Database.js';
import { EpicStore } from '../../src/state/EpicStore.js';
import { AgentStore } from '../../src/state/AgentStore.js';
import {
  registerSkill,
  getSkillDefinition,
  type SkillDefinition,
} from '../../src/skills/types.js';
import { Investigation } from '../../src/findings/investigation.js';
import { investigateAndRoute } from '../../src/failure/investigateAndRoute.js';
import type { FailurePayload } from '../../src/failure/router.js';

const STORY = 'story-001-002';
const PAYLOAD: FailurePayload = {
  failing_test_or_gate: 'npm test',
  stderr_tail: 'TypeError: getUser is not a function',
  diff: 'diff --git a/auth.ts b/auth.ts',
  story_id: STORY,
};

let db: Database.Database;
let agentId: string;
let originalDef: SkillDefinition<unknown, unknown> | undefined;
let nextInvestigation: unknown;

/** Override the registered failure-investigator so each test controls its grade. */
function stubInvestigator(value: unknown): void {
  nextInvestigation = value;
}

function countAction(action: string, command = STORY): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND command = ?')
    .get(action, command) as { n: number };
  return row.n;
}

function latestDetail(action: string): Record<string, unknown> {
  const row = db
    .prepare(
      'SELECT detail FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1',
    )
    .get(action) as { detail: string | null } | undefined;
  assert.ok(row, `expected an audit row for ${action}`);
  return JSON.parse(row!.detail ?? '{}');
}

beforeEach(() => {
  db = createDatabase(':memory:');
  new EpicStore(db).create('epic-001', 'Review Forge');
  agentId = new AgentStore(db).create('epic-001', STORY).id;

  // Replace the story-001 stub with a test-controlled handler. The output is
  // still validated against the real Investigation schema, so investigateAndRoute
  // receives a genuine, parsed Investigation.
  originalDef = getSkillDefinition('failure-investigator');
  registerSkill({
    name: 'failure-investigator',
    inputSchema: z.unknown(),
    outputSchema: Investigation,
    handler: () => nextInvestigation,
  });
});

afterEach(() => {
  if (originalDef) registerSkill(originalDef);
  db.close();
});

describe('investigateAndRoute — skill + router + audit provenance', () => {
  it('strong: returns retry-with-hint and threads the investigator hint through', async () => {
    stubInvestigator({
      grade: 'strong',
      hypothesis: 'the diff renamed getUser but left a call site',
      hint: 'update the remaining getUser(...) call at auth.ts:42',
      evidence_refs: ['auth.ts:42', 'stderr: getUser is not a function'],
    });

    const decision = await investigateAndRoute(PAYLOAD, {
      db,
      epic_id: 'epic-001',
      agent_id: agentId,
    });

    assert.deepEqual(decision, {
      kind: 'retry-with-hint',
      hint: 'update the remaining getUser(...) call at auth.ts:42',
    });
    // The hint the next worker invocation receives is recorded verbatim.
    assert.equal(
      latestDetail('failure.routed.retry_with_hint').hint,
      'update the remaining getUser(...) call at auth.ts:42',
    );
  });

  it('weak: returns surface-to-operator', async () => {
    stubInvestigator({
      grade: 'weak',
      hypothesis: 'stderr is truncated past the real error; cause unconfirmed',
      evidence_refs: [],
    });

    const decision = await investigateAndRoute(PAYLOAD, {
      db,
      epic_id: 'epic-001',
      agent_id: agentId,
    });

    assert.equal(decision.kind, 'surface-to-operator');
    assert.equal(
      (decision as { reason: string }).reason,
      'stderr is truncated past the real error; cause unconfirmed',
    );
  });

  it('contradictory: returns stop-epic', async () => {
    stubInvestigator({
      grade: 'contradictory',
      hypothesis: 'the failing test asserts behavior the diff never touches',
      evidence_refs: ['stderr: assertion in module the diff does not import'],
    });

    const decision = await investigateAndRoute(PAYLOAD, {
      db,
      epic_id: 'epic-001',
      agent_id: agentId,
    });

    assert.equal(decision.kind, 'stop-epic');
  });

  it('always writes a failure.investigation.graded row carrying the grade', async () => {
    stubInvestigator({
      grade: 'weak',
      hypothesis: 'unconfirmed',
      evidence_refs: [],
    });

    await investigateAndRoute(PAYLOAD, { db, epic_id: 'epic-001', agent_id: agentId });

    assert.equal(countAction('failure.investigation.graded'), 1);
    assert.equal(latestDetail('failure.investigation.graded').grade, 'weak');
  });

  it('each grade writes a distinguishable failure.routed.* audit row', async () => {
    const cases: Array<[unknown, string, string]> = [
      [
        { grade: 'strong', hypothesis: 'h', hint: 'fix it', evidence_refs: [] },
        'failure.routed.retry_with_hint',
        's-strong',
      ],
      [
        { grade: 'weak', hypothesis: 'h', evidence_refs: [] },
        'failure.routed.surface_to_operator',
        's-weak',
      ],
      [
        { grade: 'contradictory', hypothesis: 'h', evidence_refs: [] },
        'failure.routed.stop_epic',
        's-contradictory',
      ],
    ];

    const ROUTED = [
      'failure.routed.retry_with_hint',
      'failure.routed.surface_to_operator',
      'failure.routed.stop_epic',
    ];

    for (const [investigation, expectedAction, story] of cases) {
      stubInvestigator(investigation);
      await investigateAndRoute(
        { ...PAYLOAD, story_id: story },
        { db, epic_id: 'epic-001', agent_id: agentId },
      );
      // Exactly the expected routed action fired for this story; the other two did not.
      for (const action of ROUTED) {
        assert.equal(
          countAction(action, story),
          action === expectedAction ? 1 : 0,
          `${story}: ${action} count`,
        );
      }
    }
  });

  it('imposes no retry ceiling of its own — repeated strong grades keep retrying', async () => {
    stubInvestigator({
      grade: 'strong',
      hypothesis: 'h',
      hint: 'keep going',
      evidence_refs: [],
    });
    for (let i = 0; i < 5; i++) {
      const decision = await investigateAndRoute(PAYLOAD, {
        db,
        epic_id: 'epic-001',
        agent_id: agentId,
      });
      assert.equal(decision.kind, 'retry-with-hint');
    }
  });
});
