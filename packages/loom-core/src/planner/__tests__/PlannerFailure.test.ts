import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { MockLLMClient } from '../../llm/MockLLMClient.js';
import type { LLMClient } from '../../llm/index.js';
import { Planner } from '../Planner.js';

// ─── Scripted persona outputs that drive a full successful run ──────────────

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

const fullPipelineResponder = (req: { messages: { content: string }[] }): string => {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('Produce the project brief')) return ANALYST_BRIEF;
  if (last.includes('Headless task A: produce the PRD')) return PM_PRD;
  if (last.includes('Headless task B: produce the epic')) return pmEpicsJson(last);
  if (last.includes('Headless task A: produce the architecture')) return ARCH_DOC;
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error(`unexpected planning message: ${last.slice(0, 80)}`);
};

let tmpDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-planner-fail-'));
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePlanner(llm: LLMClient): Planner {
  const db = openDatabase(path.join(tmpDir, '.loom'));
  return new Planner({ projectRoot: tmpDir, llm, model: 'mock-model', db });
}

describe('Planner failure taxonomy (failed vs rejected)', () => {
  it('records an infra-killed run as failed with a retrievable error — NOT rejected', async () => {
    // Force the planner to crash at the infra point: the first LLM call (the
    // Analyst persona) throws as if the process were killed / the provider died.
    const boom = new MockLLMClient(() => {
      throw new Error('worker OOM-killed mid-plan');
    });
    const planner = makePlanner(boom);

    await assert.rejects(() => planner.run('Build something that will crash.'), /OOM-killed/);

    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epic = new EpicStore(db).get('epic-001');
    assert.ok(epic, 'the planning placeholder row must still exist after the crash');
    assert.equal(epic.status, 'failed', 'a crash lands as failed, not rejected');
    assert.notEqual(epic.status, 'rejected', 'an infra crash is not a human rejection');
    // The error message is retrievable and non-empty.
    assert.ok(epic.error && epic.error.length > 0, 'error message must be retrievable');
    assert.equal(epic.error, 'worker OOM-killed mid-plan');
  });

  it('stores the error MESSAGE, not the full multi-line stack (Security Model)', async () => {
    const err = new Error('provider rate limit exceeded');
    // A real Error carries a multi-line .stack; the planner must persist only
    // the single-line .message so a stack trace never leaks into the DB.
    assert.ok(err.stack && err.stack.split('\n').length > 1, 'sanity: the error has a stack');

    const boom = new MockLLMClient(() => {
      throw err;
    });
    const planner = makePlanner(boom);
    await assert.rejects(() => planner.run('Build something that errors.'));

    const db = openDatabase(path.join(tmpDir, '.loom'));
    const epic = new EpicStore(db).get('epic-001')!;
    assert.equal(epic.error, 'provider rate limit exceeded');
    assert.ok(!epic.error!.includes('\n'), 'stored error must be a single-line message');
    assert.notEqual(epic.error, err.stack, 'must not be the full stack');
  });

  it('a human-declined plan still lands as rejected (regression guard for the split)', async () => {
    // The human-decline path is EpicStore.updateStatus(id, 'rejected', reason),
    // distinct from the planner's infra-failure fail(). Both must coexist so
    // the taxonomy split is real, not a rename.
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const store = new EpicStore(db);
    store.beginPlanning('epic-001', 'a brief a human will decline');
    store.updateStatus('epic-001', 'rejected', 'operator declined');

    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'rejected');
    assert.notEqual(epic.status, 'failed');
    assert.equal(epic.reason, 'operator declined');
    assert.equal(epic.error, null, 'a human rejection sets reason, never the infra error column');
  });
});

describe('Planner title backfill', () => {
  it('a planning run starts from the (planning…) placeholder title', () => {
    // beginPlanning seeds the placeholder BEFORE the real title is known —
    // the value the backfill must later overwrite. Verified on a throwaway id
    // so the planner run below can own epic-001 without a PK collision.
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const seeded = new EpicStore(db).beginPlanning('epic-099', 'seed brief');
    assert.equal(seeded.title, '(planning…)', 'planning starts from the placeholder title');
  });

  it('replaces the placeholder title with the real title via the reused completePlanning', async () => {
    const planner = makePlanner(new MockLLMClient(fullPipelineResponder));
    const result = await planner.run('Build something worth planning.');
    assert.equal(result.runId, 'epic-001');

    const epic = new EpicStore(openDatabase(path.join(tmpDir, '.loom'))).get('epic-001')!;
    assert.equal(epic.status, 'planned');
    assert.equal(epic.title, REAL_TITLE, 'the placeholder must be replaced with the real title');
    assert.notEqual(epic.title, '(planning…)');
    assert.equal(epic.planning_phase, null, 'completePlanning clears the planning phase');
  });
});
