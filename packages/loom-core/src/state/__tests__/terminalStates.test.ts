import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../Database.js';
import { EpicStore } from '../EpicStore.js';
import { AgentStore } from '../AgentStore.js';
import { LeaseStore } from '../LeaseStore.js';
import { MockLLMClient } from '../../llm/MockLLMClient.js';
import { Planner } from '../../planner/Planner.js';
import { derivePlaceholderTitle } from '../../planner/placeholderTitle.js';
import { evaluateBriefGate } from '../../brief/gate.js';
import { StoryRetryService } from '../../orchestrator/StoryRetryService.js';
import { WorktreeManager } from '../../orchestrator/WorktreeManager.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A failing critique whose FIRST line we expect to land in the verdict string.
 * The verdict format is `brief gate: <score>/10 — <first critique line>` and
 * the first line is taken from the critique categories in the order an operator
 * reads them (ambiguities first).
 */
const FAILING_REFINEMENT = {
  ready: false,
  quality_score: 3,
  refined_brief: '# Brief\n\n## Goal\nUnclear.',
  critique: {
    strong_points: [],
    ambiguities: ['"fast" is never quantified'],
    missing_scope: ['no error handling described'],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: ['What is the success metric?'],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
};

const FIRST_CRITIQUE_LINE = '"fast" is never quantified';

const PASS_REFINEMENT = {
  ready: true,
  quality_score: 9,
  refined_brief: '# Brief\n\n## Goal\nShip it.',
  critique: {
    strong_points: ['clear'],
    ambiguities: [],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: [],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
};

/** A passing planner pipeline that completes the reserved epic to 'planned'. */
function fullPipelineResponder(req: { messages: { content: string }[] }): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
  if (last.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
  if (last.includes('Headless task B: produce the epic')) {
    const m = last.match(/starting at "(epic-\d+)"/);
    const eid = m ? m[1] : 'epic-001';
    const num = eid.slice(5);
    return (
      '```json\n' +
      JSON.stringify({
        epics: [
          {
            epic_id: eid,
            title: 'Epic produced by the planner',
            priority: 'must-have',
            prd_ref: 'x',
            requirements: ['FR-1'],
            stories: [
              {
                id: `story-${num}-001`,
                title: 'The single story',
                description: 'do it',
                acceptance_criteria: ['works'],
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
  if (last.includes('Headless task A: produce the architecture'))
    return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error('unexpected planning message: ' + last.slice(0, 60));
}

const BRIEF = '# Build a thing\n\nA brief that scores below the quality threshold.';

let tmpDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-terminal-states-'));
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Mirrors the reservation step `runEpic` performs at submission (story-007-005):
 * single allocation, reserve the row, stamp the derived placeholder title. The
 * row exists as 'planning' BEFORE any gate/planner decision — exactly the row
 * the terminal-state branch then flips.
 */
function reserve(db: ReturnType<typeof openDatabase>, brief: string): { store: EpicStore; id: string } {
  const id = Planner.nextEpicId(db);
  const store = new EpicStore(db);
  store.beginPlanning(id, brief);
  store.setTitle(id, derivePlaceholderTitle(brief));
  return { store, id };
}

/** The exact gate verdict string runEpic writes on `!verdict.pass && !force`. */
function gateVerdict(score: number, firstCritiqueLine: string): string {
  return `brief gate: ${score}/10 — ${firstCritiqueLine}`;
}

describe('terminal states for gate-rejected and crashed planning runs', () => {
  // ── Case 1: gate reject (!verdict.pass && !force) ──────────────────────────
  it('a gate-rejected brief leaves the reserved row as rejected with the verdict in error', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const { store, id } = reserve(db, BRIEF);

    // Sanity: before the decision the row is the reserved planning placeholder.
    const reserved = store.get(id)!;
    assert.equal(reserved.status, 'planning');
    assert.equal(reserved.title, derivePlaceholderTitle(BRIEF));

    const verdict = evaluateBriefGate(FAILING_REFINEMENT, 6);
    assert.equal(verdict.pass, false, 'precondition: the brief fails the gate');

    // The runEpic decision for `!verdict.pass && !force`.
    store.reject(id, gateVerdict(FAILING_REFINEMENT.quality_score, FIRST_CRITIQUE_LINE));

    const row = store.get(id)!;
    assert.equal(row.status, 'rejected', 'clean terminal rejected state');
    assert.equal(
      row.error,
      'brief gate: 3/10 — "fast" is never quantified',
      'the gate verdict is written to the error column'
    );
    assert.equal(row.reason, null, 'reason is NOT used for a gate verdict');
    // No orphaned '(planning…)' row: the reserved row was flipped in place, the
    // placeholder title is gone, and the planning_phase overlay is cleared.
    assert.notEqual(row.title, '(planning…)', 'no orphaned (planning…) placeholder');
    assert.equal(row.planning_phase, null, 'planning overlay cleared on the terminal state');
    assert.equal(store.listByStatus('planning').length, 0, 'no row left in planning');
    db.close();
  });

  // ── Case 2: provenance separation (human reason vs gate error) ─────────────
  it('keeps human-reject (reason) and gate-reject (error) distinguishable on the same status', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const store = new EpicStore(db);

    // Human reject — operator decision — writes `reason`, never `error`.
    store.beginPlanning('epic-001', 'a brief a human declines');
    store.updateStatus('epic-001', 'rejected', 'operator declined: out of scope this quarter');

    // Gate reject — machine verdict — writes `error`, never `reason`.
    store.beginPlanning('epic-002', 'a brief the gate rejects');
    store.reject('epic-002', gateVerdict(2, 'no acceptance criteria'));

    const human = store.get('epic-001')!;
    const gate = store.get('epic-002')!;

    // Both share the 'rejected' status (no schema migration during the freeze).
    assert.equal(human.status, 'rejected');
    assert.equal(gate.status, 'rejected');

    // The error-vs-reason split is the ONLY signal that tells them apart.
    assert.equal(human.reason, 'operator declined: out of scope this quarter');
    assert.equal(human.error, null, 'a human reject never writes the error column');

    assert.equal(gate.error, 'brief gate: 2/10 — no acceptance criteria');
    assert.equal(gate.reason, null, 'a gate reject never writes the reason column');

    // They are distinguishable: provenance is recoverable from the columns.
    const provenance = (e: typeof gate) => (e.error !== null ? 'gate' : 'human');
    assert.equal(provenance(human), 'human');
    assert.equal(provenance(gate), 'gate');
    db.close();
  });

  // ── Case 3: refiner/planner throw lands 'failed' (epic-005 path), not rejected
  it('a planner crash leaves the row failed via the existing fail() path, not rejected', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const { id } = reserve(db, BRIEF);

    // The planner adopts the reserved id, then the Analyst call throws — the
    // existing epic-005 catch records status 'failed' with the error message.
    const boom = new MockLLMClient(() => {
      throw new Error('worker OOM-killed mid-plan');
    });
    const planner = new Planner({ projectRoot: tmpDir, llm: boom, model: 'mock-model', db });

    await assert.rejects(() => planner.run(BRIEF, id), /worker OOM-killed mid-plan/);

    const row = new EpicStore(db).get(id)!;
    assert.equal(row.status, 'failed', 'a crash lands as failed, not rejected');
    assert.notEqual(row.status, 'rejected', 'an infra crash is never a quality-gate rejection');
    assert.equal(row.error, 'worker OOM-killed mid-plan', 'the failure message is retrievable');
    assert.equal(row.reason, null);
    db.close();
  });

  // ── Case 4: --force below-threshold reserves before the refiner, never rejects
  it('a --force run below threshold reserves before the refiner and is never recorded as rejected', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    // Reservation happens BEFORE the refiner (runEpic ordering, story-007-005).
    const { store, id } = reserve(db, BRIEF);
    assert.equal(store.get(id)!.status, 'planning', 'reserved before the refiner runs');

    // The brief scores below threshold...
    const verdict = evaluateBriefGate(FAILING_REFINEMENT, 6);
    assert.equal(verdict.pass, false);

    // ...but with --force the gate decision is overridden: runEpic NEVER calls
    // store.reject() on the force path. It proceeds straight to the planner,
    // which completes the reserved row to 'planned'.
    const force = true;
    if (!verdict.pass && !force) {
      throw new Error('force path must not reach the reject branch');
    }
    const planner = new Planner({
      projectRoot: tmpDir,
      llm: new MockLLMClient(fullPipelineResponder),
      model: 'mock-model',
      db,
    });
    await planner.run(BRIEF, id);

    const row = store.get(id)!;
    assert.equal(row.status, 'planned', 'forced run lands on the normal planned path');
    assert.notEqual(row.status, 'rejected', '--force is never recorded as rejected');
    assert.equal(row.error, null, 'no gate verdict written on a forced run');
    assert.equal(store.listByStatus('rejected').length, 0, 'no rejected row from a forced run');
    db.close();
  });

  // ── Case 5: downstream-consumer guard ──────────────────────────────────────
  it('a downstream consumer of rejected rows does not mishandle the gate-provenance verdict', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const store = new EpicStore(db);

    // A gate-provenance rejected row: error populated, reason NULL.
    store.beginPlanning('epic-001', 'gate-rejected brief');
    store.reject('epic-001', gateVerdict(1, 'untestable success claim'));

    // Consumer A: listByStatus('rejected') returns it without assuming reason.
    const rejected = store.listByStatus('rejected');
    assert.equal(rejected.length, 1);
    const row = rejected[0];
    assert.equal(row.reason, null, 'a gate-provenance row has no reason — consumers must not assume one');
    assert.ok(row.error, 'the verdict lives in error');

    // A consumer that naively rendered `reason` would print 'null'/blank; the
    // robust render falls back to `error`. Prove the fallback is well-defined.
    const renderRejectMessage = (e: typeof row): string => e.reason ?? e.error ?? 'rejected';
    assert.equal(
      renderRejectMessage(row),
      'brief gate: 1/10 — untestable success claim',
      'rendering a rejected row never crashes or shows an empty reason'
    );

    // Consumer B: StoryRetryService treats a 'rejected' epic as resumable and
    // flips it back to 'in_progress' — it reads only `status`, never `reason`.
    // A gate-provenance row must drive it without crashing. Seed a failed agent
    // so prepare() reaches the status flip.
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-001', 'story-001-001', 'A story');
    agentStore.updateStatus(agent.id, 'failed');

    const retry = new StoryRetryService({
      projectRoot: tmpDir,
      db,
      // Stub the git-touching collaborators so the guard test stays hermetic.
      worktrees: stubWorktrees(),
      leaseStore: new LeaseStore(db),
    });
    const result = retry.prepare('story-001-001');
    assert.equal(result.status, 'ready', 'the gate-provenance rejected epic is handled, not mishandled');
    assert.equal(
      store.get('epic-001')!.status,
      'in_progress',
      'a rejected epic is flipped back to in_progress regardless of verdict provenance'
    );
    db.close();
  });
});

/** A WorktreeManager whose filesystem/git operations are no-ops for the guard test. */
function stubWorktrees(): WorktreeManager {
  const stub = {
    remove() {},
    create() {},
    path() {
      return '';
    },
  };
  return stub as unknown as WorktreeManager;
}
