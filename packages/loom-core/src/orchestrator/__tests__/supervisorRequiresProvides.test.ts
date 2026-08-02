/**
 * story-095-004: Supervisor typed-requires validation, provides injection,
 * and LOOM_PROVIDES parsing.
 *
 * Unit tests: checkRequires, injectProvidesSection, parseLoomProvides
 * Integration tests: dispatch blocking on unmet requires, provides injection
 * into worker prompt, LOOM_PROVIDES persistence, parse-failure blocking, and
 * backward-compat (no requires/provides = identical to pre-feature behavior).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { Supervisor } from '../Supervisor.js';
import {
  checkRequires,
  injectProvidesSection,
  parseLoomProvides,
  LoomProvidesParseError,
} from '../Supervisor.js';
import { MockWorkerRunner } from '../MockWorkerRunner.js';
import type { Story } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): string {
  gitc(['init', '-q'], dir);
  gitc(['config', 'user.email', 'test@loom.dev'], dir);
  gitc(['config', 'user.name', 'Loom Test'], dir);
  gitc(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  gitc(['add', '.'], dir);
  gitc(['commit', '-q', '-m', 'initial'], dir);
  return fs.realpathSync(dir);
}

function makeStory(id: string, overrides: Partial<Story> = {}): Story {
  return {
    id,
    title: `Story ${id}`,
    description: 'Implement it.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: [],
    ...overrides,
  };
}

function seedEpic(repoDir: string, epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(path.join(repoDir, '.loom'));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
}

// ─── Test state ───────────────────────────────────────────────────────────────

let repoDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rp-'));
  initRepo(repoDir);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  resetDatabaseForTest();
});

// ─── checkRequires ─────────────────────────────────────────────────────────────

describe('checkRequires', () => {
  it('[Happy] story with no requires → ok=true, unmet=[]', () => {
    const story = makeStory('story-001-001');
    const result = checkRequires(story, new Map());
    assert.deepStrictEqual(result, { ok: true, unmet: [] });
  });

  it('[Happy] required key present in upstream provides → ok=true', () => {
    const story = makeStory('story-001-002', {
      requires: { schemaVersion: 'story-001-001' },
    });
    const provides = new Map([
      ['story-001-001', { schemaVersion: '3.0', extra: 'ignored' }],
    ]);
    const result = checkRequires(story, provides);
    assert.deepStrictEqual(result, { ok: true, unmet: [] });
  });

  it('[Negative] required key missing from upstream provides → ok=false, unmet=[key]', () => {
    const story = makeStory('story-001-002', {
      requires: { schemaVersion: 'story-001-001' },
    });
    // story-001-001 has no provides_output → absent from map
    const result = checkRequires(story, new Map());
    assert.deepStrictEqual(result, { ok: false, unmet: ['schemaVersion'] });
  });

  it('[Boundary] story provides a key but NOT the required one → ok=false', () => {
    const story = makeStory('story-001-002', {
      requires: { schemaVersion: 'story-001-001' },
    });
    const provides = new Map([
      ['story-001-001', { someOtherKey: 'value' }],
    ]);
    const result = checkRequires(story, provides);
    assert.deepStrictEqual(result, { ok: false, unmet: ['schemaVersion'] });
  });

  it('[Boundary] two required keys; one satisfied, one not → unmet lists only missing', () => {
    const story = makeStory('story-001-002', {
      requires: { schemaVersion: 'story-001-001', dbUrl: 'story-001-001' },
    });
    const provides = new Map([
      ['story-001-001', { schemaVersion: '3.0' }], // dbUrl is absent
    ]);
    const result = checkRequires(story, provides);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.unmet, ['dbUrl']);
  });

  it('[Boundary] both required keys present → ok=true', () => {
    const story = makeStory('story-001-002', {
      requires: { schemaVersion: 'story-001-001', dbUrl: 'story-001-001' },
    });
    const provides = new Map([
      ['story-001-001', { schemaVersion: '3.0', dbUrl: 'postgres://localhost/db' }],
    ]);
    const result = checkRequires(story, provides);
    assert.deepStrictEqual(result, { ok: true, unmet: [] });
  });

  it('[Boundary] empty requires record → ok=true (same as absent)', () => {
    const story = makeStory('story-001-001', { requires: {} });
    const result = checkRequires(story, new Map());
    assert.deepStrictEqual(result, { ok: true, unmet: [] });
  });
});

// ─── injectProvidesSection ────────────────────────────────────────────────────

describe('injectProvidesSection', () => {
  it('[Happy] story with no requires → base prompt returned unchanged', () => {
    const story = makeStory('story-001-001');
    const base = 'My base prompt.';
    const result = injectProvidesSection(base, story, new Map());
    assert.strictEqual(result, base);
  });

  it('[Happy] single required key with value → prompt contains ## Upstream Provides block', () => {
    const story = makeStory('story-001-002', {
      requires: { schemaVersion: 'story-001-001' },
    });
    const provides = new Map([
      ['story-001-001', { schemaVersion: '3.0' }],
    ]);
    const result = injectProvidesSection('Base prompt.', story, provides);
    assert.ok(result.startsWith('Base prompt.'), 'base prompt preserved at start');
    assert.ok(result.includes('## Upstream Provides'), 'section header present');
    assert.ok(result.includes('schemaVersion'), 'key present');
    assert.ok(result.includes('"3.0"'), 'value present (JSON-serialized)');
  });

  it('[Happy] multiple upstream provides values → all appear in injected block', () => {
    const story = makeStory('story-001-002', {
      requires: { schemaVersion: 'story-001-001', dbUrl: 'story-001-001' },
    });
    const provides = new Map([
      ['story-001-001', { schemaVersion: '3.0', dbUrl: 'postgres://localhost/db' }],
    ]);
    const result = injectProvidesSection('Base.', story, provides);
    assert.ok(result.includes('schemaVersion'), 'first key present');
    assert.ok(result.includes('dbUrl'), 'second key present');
    assert.ok(result.includes('"postgres://localhost/db"'), 'second value present');
  });

  it('[Negative] required key not in provides map → section not appended', () => {
    const story = makeStory('story-001-002', {
      requires: { schemaVersion: 'story-001-001' },
    });
    // story-001-001 is absent from the provides map
    const result = injectProvidesSection('Base.', story, new Map());
    assert.strictEqual(result, 'Base.', 'no section appended when provides absent');
  });

  it('[Boundary] empty requires → base prompt unchanged', () => {
    const story = makeStory('story-001-001', { requires: {} });
    const result = injectProvidesSection('Base.', story, new Map());
    assert.strictEqual(result, 'Base.');
  });

  it('[Purity] returns a new string; does not mutate inputs', () => {
    const story = makeStory('story-001-002', {
      requires: { key: 'story-001-001' },
    });
    const provides = new Map([['story-001-001', { key: 'val' }]]);
    const base = 'Base.';
    const result = injectProvidesSection(base, story, provides);
    assert.notStrictEqual(result, base, 'returned string is different from input');
    assert.strictEqual(base, 'Base.', 'base prompt string unmodified');
  });
});

// ─── parseLoomProvides ────────────────────────────────────────────────────────

describe('parseLoomProvides', () => {
  it('[Happy] no LOOM_PROVIDES line → returns null', () => {
    assert.strictEqual(parseLoomProvides('Some output\nwithout marker\n'), null);
  });

  it('[Happy] well-formed LOOM_PROVIDES line → returns parsed object', () => {
    const result = parseLoomProvides('Some output\nLOOM_PROVIDES {"key": "value"}\nMore output\n');
    assert.deepStrictEqual(result, { key: 'value' });
  });

  it('[Happy] last occurrence wins when multiple lines present', () => {
    const output = [
      'LOOM_PROVIDES {"key": "first"}',
      'Some work',
      'LOOM_PROVIDES {"key": "second"}',
    ].join('\n');
    const result = parseLoomProvides(output);
    assert.deepStrictEqual(result, { key: 'second' });
  });

  it('[Happy] leading/trailing whitespace on the line is trimmed', () => {
    const result = parseLoomProvides('  LOOM_PROVIDES {"x": 1}  \n');
    assert.deepStrictEqual(result, { x: 1 });
  });

  it('[Negative] LOOM_PROVIDES with invalid JSON → throws LoomProvidesParseError', () => {
    assert.throws(
      () => parseLoomProvides('LOOM_PROVIDES not-json'),
      (err: unknown) => {
        assert.ok(err instanceof LoomProvidesParseError, 'is LoomProvidesParseError');
        assert.ok(typeof err.raw === 'string', 'has raw property');
        return true;
      }
    );
  });

  it('[Negative] LOOM_PROVIDES with JSON array → throws LoomProvidesParseError', () => {
    assert.throws(
      () => parseLoomProvides('LOOM_PROVIDES [1, 2, 3]'),
      LoomProvidesParseError
    );
  });

  it('[Negative] LOOM_PROVIDES with JSON null → throws LoomProvidesParseError', () => {
    assert.throws(
      () => parseLoomProvides('LOOM_PROVIDES null'),
      LoomProvidesParseError
    );
  });

  it('[Negative] LOOM_PROVIDES embedded mid-line (not standalone) → null', () => {
    // The prefix prevents the trimmed line from starting with "LOOM_PROVIDES "
    const result = parseLoomProvides('prefix text LOOM_PROVIDES {"key": "val"}');
    assert.strictEqual(result, null, 'not standalone line is ignored');
  });

  it('[Happy] empty output → returns null', () => {
    assert.strictEqual(parseLoomProvides(''), null);
  });

  it('[Happy] complex JSON object persists all fields', () => {
    const obj = { schemaVersion: '3.0', count: 42, nested: { a: true } };
    const result = parseLoomProvides(`LOOM_PROVIDES ${JSON.stringify(obj)}`);
    assert.deepStrictEqual(result, obj);
  });
});

// ─── Integration: dispatch blocking on unmet requires ─────────────────────────

describe('dispatch integration — requires blocking', () => {
  it('[Happy] story with no requires dispatches normally (backward compat)', async () => {
    const story = makeStory('story-001-001');
    seedEpic(repoDir, 'epic-001', [story]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner({ status: 'done', commitCount: 1, summary: 'ok', logTail: '' });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesDone, 1, 'story dispatched and completed');
    assert.strictEqual(result.storiesBlocked, 0, 'no blocked stories');

    // No requires_unmet audit entry for this story
    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const unmetRow = rows.find((r) => r.action === 'requires_unmet');
    assert.strictEqual(unmetRow, undefined, 'no requires_unmet audit entry for no-requires story');
  });

  it('[Negative] story with unmet requires → blocked, audit-logged, not dispatched', async () => {
    const storyA = makeStory('story-001-001', {
      provides: { schemaVersion: {} },
    });
    const storyB = makeStory('story-001-002', {
      dependencies: ['story-001-001'],
      requires: { schemaVersion: 'story-001-001' },
    });
    seedEpic(repoDir, 'epic-001', [storyA, storyB]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    // Story A completes WITHOUT a LOOM_PROVIDES trailer → storyA will be blocked too
    // (because it declares provides), so storyB never even gets to checkRequires.
    // To test the requires-unmet path specifically, we need a scenario where storyA
    // somehow completed successfully in a prior run with no provides_output.
    // We simulate this by directly inserting a 'done' agent for storyA with null provides_output.
    const agents = new AgentStore(db);
    const agentA = agents.create('epic-001', 'story-001-001', 'Story A');
    agents.updateStatus(agentA.id, 'done');
    // provides_output stays NULL → storyB's requires are unmet

    let dispatchCount = 0;
    const worker = new MockWorkerRunner(() => {
      dispatchCount++;
      return Promise.resolve({ status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' });
    });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 2, lease: false });

    const result = await supervisor.run(['epic-001']);

    // storyA is already done from the pre-seeded agent (skipped by taskFor since SUCCESS)
    // storyB should be blocked due to unmet requires
    assert.strictEqual(result.storiesBlocked, 1, 'storyB blocked due to unmet requires');
    assert.strictEqual(dispatchCount, 0, 'no worker spawned for storyB');

    // Verify the DB record (not just the in-memory counter) reflects blocked status.
    const agentB = new AgentStore(db).getByStory('story-001-002');
    assert.ok(agentB, 'agent record created for storyB');
    assert.strictEqual(agentB!.status, 'blocked', 'storyB DB status is blocked');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-002');
    const unmetRow = rows.find((r) => r.action === 'requires_unmet');
    assert.ok(unmetRow, 'requires_unmet audit entry present');
    const detail = JSON.parse(unmetRow!.detail ?? '{}') as { unmet: string[] };
    assert.ok(Array.isArray(detail.unmet), 'detail.unmet is array');
    assert.ok(detail.unmet.includes('schemaVersion'), 'unmet includes the missing key');
  });

  it('[Happy] story with satisfied requires → dispatched with ## Upstream Provides in assignment', async () => {
    const storyA = makeStory('story-001-001', {
      provides: { schemaVersion: {} },
    });
    const storyB = makeStory('story-001-002', {
      dependencies: ['story-001-001'],
      requires: { schemaVersion: 'story-001-001' },
    });
    seedEpic(repoDir, 'epic-001', [storyA, storyB]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    // Pre-seed storyA as done with valid provides_output
    const agents = new AgentStore(db);
    const agentA = agents.create('epic-001', 'story-001-001', 'Story A');
    agents.updateStatus(agentA.id, 'done');
    agents.setProvidesOutput(agentA.id, JSON.stringify({ schemaVersion: '3.0' }));

    const worker = new MockWorkerRunner({ status: 'done', commitCount: 1, summary: 'ok', logTail: '' });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 2, lease: false });

    const result = await supervisor.run(['epic-001']);

    // storiesDone counts all tasks with SUCCESS status at end of run, including
    // stories that were already done before this run started (pre-seeded storyA).
    assert.strictEqual(result.storiesDone, 2, 'both stories done (A pre-seeded, B dispatched)');
    // storyB should have been dispatched with the provides section
    const assignment = worker.assignments.find((a) => a.storyId === 'story-001-002');
    assert.ok(assignment, 'storyB was dispatched');
    assert.ok(
      assignment!.upstreamProvidesSection?.includes('## Upstream Provides'),
      'assignment contains ## Upstream Provides section'
    );
    assert.ok(
      assignment!.upstreamProvidesSection?.includes('schemaVersion'),
      'provides section includes the required key'
    );
    assert.ok(
      assignment!.upstreamProvidesSection?.includes('"3.0"'),
      'provides section includes the value verbatim'
    );
  });
});

// ─── Integration: LOOM_PROVIDES persistence ──────────────────────────────────

describe('dispatch integration — LOOM_PROVIDES persistence', () => {
  it('[Happy] worker output with well-formed LOOM_PROVIDES → persisted to agents.provides_output', async () => {
    const story = makeStory('story-001-001', {
      provides: { schemaVersion: {} },
    });
    seedEpic(repoDir, 'epic-001', [story]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner({
      status: 'done',
      commitCount: 1,
      summary: 'ok',
      logTail: 'Did some work.\nLOOM_PROVIDES {"schemaVersion": "3.0"}\n',
    });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesDone, 1, 'story completed');
    const agents = new AgentStore(db);
    const agent = agents.getByStory('story-001-001');
    assert.ok(agent?.provides_output, 'provides_output is set');
    const parsed = JSON.parse(agent!.provides_output!);
    assert.deepStrictEqual(parsed, { schemaVersion: '3.0' });
  });

  it('[Negative] malformed LOOM_PROVIDES trailer when story declares provides → blocked + audit', async () => {
    const story = makeStory('story-001-001', {
      provides: { schemaVersion: {} },
    });
    seedEpic(repoDir, 'epic-001', [story]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner({
      status: 'done',
      commitCount: 1,
      summary: 'ok',
      logTail: 'Did work.\nLOOM_PROVIDES not-valid-json\n',
    });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesBlocked, 1, 'story blocked due to malformed trailer');
    assert.strictEqual(result.storiesDone, 0, 'story did not advance to completed');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const failRow = rows.find((r) => r.action === 'provides_parse_failed');
    assert.ok(failRow, 'provides_parse_failed audit entry present');
    const detail = JSON.parse(failRow!.detail ?? '{}') as { reason: string };
    assert.strictEqual(detail.reason, 'malformed');

    const agents = new AgentStore(db);
    const agent = agents.getByStory('story-001-001');
    assert.strictEqual(agent?.provides_output, null, 'provides_output not written on parse failure');
  });

  it('[Negative] absent LOOM_PROVIDES trailer when story declares provides → blocked + audit', async () => {
    const story = makeStory('story-001-001', {
      provides: { schemaVersion: {} },
    });
    seedEpic(repoDir, 'epic-001', [story]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner({
      status: 'done',
      commitCount: 1,
      summary: 'ok',
      logTail: 'Did work but forgot to emit LOOM_PROVIDES.',
    });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesBlocked, 1, 'story blocked due to absent trailer');
    assert.strictEqual(result.storiesDone, 0, 'story did not advance to completed');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const failRow = rows.find((r) => r.action === 'provides_parse_failed');
    assert.ok(failRow, 'provides_parse_failed audit entry present');
    const detail = JSON.parse(failRow!.detail ?? '{}') as { reason: string };
    assert.strictEqual(detail.reason, 'trailer_absent');
  });

  it('[Happy] absent LOOM_PROVIDES trailer when story declares NO provides → no-op, story completes', async () => {
    // Backward-compat: stories without provides advance normally even if worker
    // emits no LOOM_PROVIDES trailer.
    const story = makeStory('story-001-001');
    seedEpic(repoDir, 'epic-001', [story]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner({
      status: 'done',
      commitCount: 1,
      summary: 'ok',
      logTail: 'Did work. No trailer.',
    });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesDone, 1, 'story completed normally');
    assert.strictEqual(result.storiesBlocked, 0, 'no blocked stories');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const failRow = rows.find((r) => r.action === 'provides_parse_failed');
    assert.strictEqual(failRow, undefined, 'no provides_parse_failed entry for no-provides story');
    const unmetRow = rows.find((r) => r.action === 'requires_unmet');
    assert.strictEqual(unmetRow, undefined, 'no requires_unmet entry for no-requires story');
  });

  it('[Negative] LOOM_PROVIDES with missing declared keys → blocked + audit with reason=missing_keys', async () => {
    // Worker emits a valid JSON object but omits a declared provides key.
    // The downstream requires check must not blame the dependent story.
    const story = makeStory('story-001-001', {
      provides: { schemaVersion: {}, dbUrl: {} },
    });
    seedEpic(repoDir, 'epic-001', [story]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner({
      status: 'done',
      commitCount: 1,
      summary: 'ok',
      logTail: 'Did work.\nLOOM_PROVIDES {"schemaVersion": "3.0"}\n', // dbUrl missing
    });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesBlocked, 1, 'story blocked due to missing provides key');
    assert.strictEqual(result.storiesDone, 0, 'story did not advance to completed');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const failRow = rows.find((r) => r.action === 'provides_parse_failed');
    assert.ok(failRow, 'provides_parse_failed audit entry present');
    const detail = JSON.parse(failRow!.detail ?? '{}') as { reason: string; keys: string[] };
    assert.strictEqual(detail.reason, 'missing_keys');
    assert.ok(Array.isArray(detail.keys), 'detail.keys is array');
    assert.ok(detail.keys.includes('dbUrl'), 'missing key listed');
    assert.ok(!detail.keys.includes('schemaVersion'), 'present key not listed');

    const agents = new AgentStore(db);
    const agent = agents.getByStory('story-001-001');
    assert.strictEqual(agent?.provides_output, null, 'provides_output not written when keys missing');
  });
});

// ─── Integration: streaming LOOM_PROVIDES capture ─────────────────────────────
// Exercises the path where the worker's LOOM_PROVIDES line is captured via the
// onOutput streaming callback so it isn't lost when logTail is truncated.

describe('dispatch integration — streaming LOOM_PROVIDES capture', () => {
  it('[Happy] LOOM_PROVIDES emitted via onOutput stream and logTail is empty → persisted', async () => {
    // Simulate a worker that emits LOOM_PROVIDES via onOutput (real worker path),
    // then returns a logTail that does NOT contain the trailer (truncation scenario).
    const story = makeStory('story-001-001', {
      provides: { schemaVersion: {} },
    });
    seedEpic(repoDir, 'epic-001', [story]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner(async (assignment) => {
      // Simulate streaming: emit LOOM_PROVIDES via onOutput before returning
      assignment.onOutput?.('Did many lines of work...\n', 'stdout');
      assignment.onOutput?.('LOOM_PROVIDES {"schemaVersion": "4.0"}\n', 'stdout');
      assignment.onOutput?.('Verbose post-trailer diagnostic output.\n', 'stdout');
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: 'ok',
        // logTail simulates truncation: does NOT contain the LOOM_PROVIDES line
        logTail: 'Verbose post-trailer diagnostic output.',
      };
    });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesDone, 1, 'story completed');
    assert.strictEqual(result.storiesBlocked, 0, 'no blocked stories');
    const agents = new AgentStore(db);
    const agent = agents.getByStory('story-001-001');
    assert.ok(agent?.provides_output, 'provides_output persisted via stream capture');
    const parsed = JSON.parse(agent!.provides_output!);
    assert.deepStrictEqual(parsed, { schemaVersion: '4.0' }, 'captured value is correct');
  });

  it('[Happy] last LOOM_PROVIDES in stream wins when emitted across multiple chunks', async () => {
    const story = makeStory('story-001-001', {
      provides: { schemaVersion: {} },
    });
    seedEpic(repoDir, 'epic-001', [story]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner(async (assignment) => {
      // Two LOOM_PROVIDES lines — last occurrence wins
      assignment.onOutput?.('LOOM_PROVIDES {"schemaVersion": "1.0"}\n', 'stdout');
      assignment.onOutput?.('LOOM_PROVIDES {"schemaVersion": "2.0"}\n', 'stdout');
      return {
        status: 'done' as const,
        commitCount: 1,
        summary: 'ok',
        logTail: '',
      };
    });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false });

    await supervisor.run(['epic-001']);

    const agents = new AgentStore(db);
    const agent = agents.getByStory('story-001-001');
    const parsed = JSON.parse(agent!.provides_output!);
    assert.deepStrictEqual(parsed, { schemaVersion: '2.0' }, 'last occurrence wins');
  });
});

// ─── Integration: shared upstream provider ────────────────────────────────────

describe('dispatch integration — shared upstream provider', () => {
  it('[Happy] two downstream stories sharing the same upstream provider each get injected provides', async () => {
    // storyA provides schemaVersion; storyB and storyC both require it.
    const storyA = makeStory('story-001-001', {
      provides: { schemaVersion: {} },
    });
    const storyB = makeStory('story-001-002', {
      dependencies: ['story-001-001'],
      requires: { schemaVersion: 'story-001-001' },
    });
    const storyC = makeStory('story-001-003', {
      dependencies: ['story-001-001'],
      requires: { schemaVersion: 'story-001-001' },
    });
    seedEpic(repoDir, 'epic-001', [storyA, storyB, storyC]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    // Pre-seed storyA as done with valid provides_output
    const agents = new AgentStore(db);
    const agentA = agents.create('epic-001', 'story-001-001', 'Story A');
    agents.updateStatus(agentA.id, 'done');
    agents.setProvidesOutput(agentA.id, JSON.stringify({ schemaVersion: '3.0' }));

    const worker = new MockWorkerRunner({ status: 'done', commitCount: 1, summary: 'ok', logTail: '' });
    const supervisor = new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 2, lease: false });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesDone, 3, 'all three stories done');
    assert.strictEqual(result.storiesBlocked, 0, 'no blocked stories');

    // Both storyB and storyC must have received the upstream provides section
    const assignmentB = worker.assignments.find((a) => a.storyId === 'story-001-002');
    const assignmentC = worker.assignments.find((a) => a.storyId === 'story-001-003');
    assert.ok(assignmentB, 'storyB was dispatched');
    assert.ok(assignmentC, 'storyC was dispatched');
    assert.ok(
      assignmentB!.upstreamProvidesSection?.includes('schemaVersion'),
      'storyB receives schemaVersion in provides section'
    );
    assert.ok(
      assignmentC!.upstreamProvidesSection?.includes('schemaVersion'),
      'storyC receives schemaVersion in provides section'
    );
    assert.ok(
      assignmentB!.upstreamProvidesSection?.includes('"3.0"'),
      'storyB receives correct value'
    );
    assert.ok(
      assignmentC!.upstreamProvidesSection?.includes('"3.0"'),
      'storyC receives correct value'
    );
  });
});
