import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { MockLLMClient } from '../../llm/MockLLMClient.js';
import type { LLMClient, LLMRequest } from '../../llm/index.js';
import { Planner } from '../Planner.js';
import { derivePlaceholderTitle } from '../placeholderTitle.js';

// ─── Scripted persona outputs that drive a full successful planner run ──────
// Mirrors the responder in PlannerFailure.test.ts so a stubbed Planner.run()
// completes end-to-end without a real cursor-agent.

const ANALYST_BRIEF = '# Demo Project\n\n## The Problem\nThere is a gap to fill.';
const PM_PRD = '# Demo PRD\n\n## Goals\nShip the demo.\n\n## Functional Requirements\nFR-1: it works.';
const ARCH_DOC = '# Demo Architecture\n\n## Architecture Philosophy\nFavor boring technology.';
const REAL_TITLE = 'The real planned epic title';

function pmEpicsJson(userMsg: string): string {
  const m = userMsg.match(/starting at "(epic-\d+)"/);
  const eid = m ? m[1] : 'epic-001';
  const num = eid.slice(5);
  return (
    '```json\n' +
    JSON.stringify({
      epics: [
        {
          epic_id: eid,
          title: REAL_TITLE,
          priority: 'must-have',
          prd_ref: 'x',
          requirements: ['FR-1'],
          stories: [
            {
              id: `story-${num}-001`,
              title: 'First test story',
              description: 'Build the first thing.',
              acceptance_criteria: ['it works'],
              estimated_complexity: 'small',
              dependencies: [],
            },
          ],
        },
      ],
    }) +
    '\n```'
  );
}

function plannerResponse(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('Produce the project brief')) return ANALYST_BRIEF;
  if (last.includes('Headless task A: produce the PRD')) return PM_PRD;
  if (last.includes('Headless task B: produce the epic')) return pmEpicsJson(last);
  if (last.includes('Headless task A: produce the architecture')) return ARCH_DOC;
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error(`unexpected planning message: ${last.slice(0, 80)}`);
}

let tmpDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reservation-'));
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function db() {
  return openDatabase(path.join(tmpDir, '.loom'));
}

function makePlanner(llm: LLMClient): Planner {
  return new Planner({ projectRoot: tmpDir, llm, model: 'mock-model', db: db() });
}

// ─── (1) derivePlaceholderTitle unit ────────────────────────────────────────

describe('derivePlaceholderTitle', () => {
  it('uses the first markdown heading (trimmed) when one is present', () => {
    const brief = '# Add a settings panel\n\nSome detail about the work.';
    assert.equal(derivePlaceholderTitle(brief), 'Add a settings panel');
  });

  it('matches any heading level h1–h6 and trims surrounding whitespace', () => {
    assert.equal(derivePlaceholderTitle('###   Deep heading   \nbody'), 'Deep heading');
    assert.equal(derivePlaceholderTitle('###### Tiny heading\nbody'), 'Tiny heading');
  });

  it('finds the first heading even when preceded by prose', () => {
    const brief = 'Here is some preamble.\n\n## The real goal\n\nmore text';
    assert.equal(derivePlaceholderTitle(brief), 'The real goal');
  });

  it('ignores a non-heading hash (no space after the #)', () => {
    // `#nospace` is not a markdown heading, so it falls through to the slice.
    const brief = '#nospace tag then a long descriptive sentence about the work to do here';
    assert.equal(derivePlaceholderTitle(brief), brief.slice(0, 60));
  });

  it('falls back to the first 60 chars when there is no heading', () => {
    const brief =
      'Build a small demo feature that verifies the placeholder derivation logic end to end.';
    const title = derivePlaceholderTitle(brief);
    assert.equal(title, brief.slice(0, 60));
    assert.equal(title.length, 60);
  });

  it('returns the (short) slice without throwing for short or empty briefs', () => {
    assert.equal(derivePlaceholderTitle('tiny'), 'tiny');
    assert.equal(derivePlaceholderTitle(''), '');
  });
});

// ─── (3) single allocation + (4) default path preserved ─────────────────────

describe('Planner allocation site', () => {
  it('Planner.run(brief, reservedId) SKIPS self-allocation and adopts the reserved id', async () => {
    // The caller reserves the row first (the runEpic path), then hands the id
    // to the planner. The planner must NOT call nextEpicId again.
    const reservedId = Planner.nextEpicId(db()); // exactly one allocation: here
    const store = new EpicStore(db());
    store.beginPlanning(reservedId, 'Build something pre-reserved.');
    store.setTitle(reservedId, derivePlaceholderTitle('Build something pre-reserved.'));

    let allocCount = 0;
    const origNext = Planner.nextEpicId;
    (Planner as { nextEpicId: typeof Planner.nextEpicId }).nextEpicId = (database) => {
      allocCount++;
      return origNext(database);
    };
    try {
      const planner = makePlanner(new MockLLMClient(plannerResponse));
      const result = await planner.run('Build something pre-reserved.', reservedId);
      assert.equal(result.runId, reservedId, 'planner adopts the pre-reserved id');
    } finally {
      (Planner as { nextEpicId: typeof Planner.nextEpicId }).nextEpicId = origNext;
    }

    assert.equal(allocCount, 0, 'planner must not self-allocate when given a reservedId');
    // Exactly one row exists — no parallel insert path created a second epic.
    assert.equal(new EpicStore(db()).list({ includeArchived: true }).length, 1);
  });

  it('Planner.run(brief) with NO reservedId self-allocates as before (MCP/test path)', async () => {
    let allocCount = 0;
    const origNext = Planner.nextEpicId;
    (Planner as { nextEpicId: typeof Planner.nextEpicId }).nextEpicId = (database) => {
      allocCount++;
      return origNext(database);
    };
    try {
      const planner = makePlanner(new MockLLMClient(plannerResponse));
      const result = await planner.run('Build something the default way.');
      assert.equal(result.runId, 'epic-001', 'default path allocates the next id itself');
    } finally {
      (Planner as { nextEpicId: typeof Planner.nextEpicId }).nextEpicId = origNext;
    }

    assert.equal(allocCount, 1, 'the default path self-allocates exactly once');
    const epic = new EpicStore(db()).get('epic-001')!;
    assert.equal(epic.status, 'planned');
  });
});

// ─── (5) title replacement at completion ────────────────────────────────────

describe('placeholder → real title', () => {
  it('the planner replaces the derived placeholder with its real title at completion', async () => {
    const brief = '# Reserve the epic row\n\nDo the reservation work.';
    const reservedId = Planner.nextEpicId(db());
    const store = new EpicStore(db());
    store.beginPlanning(reservedId, brief);
    store.setTitle(reservedId, derivePlaceholderTitle(brief));

    // The placeholder title is the derived heading right after reservation.
    assert.equal(store.get(reservedId)!.title, 'Reserve the epic row');

    const planner = makePlanner(new MockLLMClient(plannerResponse));
    await planner.run(brief, reservedId);

    const done = new EpicStore(db()).get(reservedId)!;
    assert.equal(done.status, 'planned');
    assert.equal(done.title, REAL_TITLE, 'the real title replaced the placeholder');
    assert.notEqual(done.title, 'Reserve the epic row');
    assert.equal(done.planning_phase, null, 'completion clears the planning phase');
  });
});

// ─── (6) submission-order under interleaving ────────────────────────────────

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Mirrors runEpic's reservation step exactly: a single nextEpicId allocation
 * followed by the synchronous beginPlanning + setTitle inserts. Because those
 * inserts are synchronous (better-sqlite3), the row is durable the instant
 * this returns — BEFORE any refiner/planner await — which is what makes
 * reservation order follow submission order.
 */
function reserveAtSubmission(brief: string): string {
  const reservedId = Planner.nextEpicId(db());
  const store = new EpicStore(db());
  store.beginPlanning(reservedId, brief);
  store.setTitle(reservedId, derivePlaceholderTitle(brief));
  return reservedId;
}

describe('submission-order allocation under interleaving', () => {
  it('two submissions allocate ids in submission order even when the first refiner finishes second', async () => {
    const briefA = '# First submission\n\nThe one submitted first.';
    const briefB = '# Second submission\n\nThe one submitted second.';

    // Submit A, then B — reservation happens synchronously at submission time.
    const idA = reserveAtSubmission(briefA);
    const idB = reserveAtSubmission(briefB);

    // The earlier submission got the lower id, purely from submission order.
    assert.equal(idA, 'epic-001', 'first submission reserves the lower id');
    assert.equal(idB, 'epic-002', 'second submission reserves the next id');

    // Now drive the two planner runs with deferred refiners that resolve OUT of
    // order: the FIRST submission's refiner resolves SECOND. The planner runs
    // adopt the pre-reserved ids, so completion order cannot change them.
    const gateA = deferred();
    const gateB = deferred();

    const runA = (async () => {
      await gateA.promise; // refiner for A is held...
      return makePlanner(new MockLLMClient(plannerResponse)).run(briefA, idA);
    })();
    const runB = (async () => {
      await gateB.promise;
      return makePlanner(new MockLLMClient(plannerResponse)).run(briefB, idB);
    })();

    // Resolve B first, then A — the opposite of submission order.
    gateB.resolve();
    gateA.resolve();

    const [resA, resB] = await Promise.all([runA, runB]);
    assert.equal(resA.runId, 'epic-001', 'submission A keeps its submission-order id');
    assert.equal(resB.runId, 'epic-002', 'submission B keeps its submission-order id');

    const store = new EpicStore(db());
    assert.equal(store.get('epic-001')!.user_brief, briefA);
    assert.equal(store.get('epic-002')!.user_brief, briefB);
  });
});
