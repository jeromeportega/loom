import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import {
  createDatabase,
  EpicStore,
  AgentStore,
  AuditLog,
  LeaseStore,
} from '@loom-ai/core';
import { prepareRetry } from '../commands/retry.js';

const EPIC_YAML = `epic_id: epic-001
title: Retry CLI test epic
status: in_progress
priority: must-have
prd_ref: prd.md
requirements:
  - r1
stories:
  - id: story-001-001
    title: Root story A
    description: the base
    acceptance_criteria: ["a"]
    estimated_complexity: small
    dependencies: []
  - id: story-001-002
    title: Dependent story B
    description: stacks on A
    acceptance_criteria: ["b"]
    estimated_complexity: small
    dependencies: ["story-001-001"]
`;

let root: string;
let db: DatabaseType.Database;
let epics: EpicStore;
let agents: AgentStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-retry-cli-'));
  const yamlRel = path.join('.loom', 'planning', 'epic-001', 'epic-001.yaml');
  fs.mkdirSync(path.dirname(path.join(root, yamlRel)), { recursive: true });
  fs.writeFileSync(path.join(root, yamlRel), EPIC_YAML);
  db = createDatabase(':memory:');
  epics = new EpicStore(db);
  agents = new AgentStore(db);
  epics.create('epic-001', 'Retry CLI test epic', yamlRel);
  epics.updateStatus('epic-001', 'in_progress');
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A LeaseStore owned by some OTHER live process, already holding the epic. */
function liveOtherLease(): LeaseStore {
  const other = new LeaseStore(db, {
    owner: 'other-supervisor',
    pid: 1,
    hostname: 'h',
    isAlive: () => true,
  });
  assert.ok(other.acquire('epic-001'), 'the other supervisor takes the lease');
  return other;
}

/** Our own LeaseStore, distinct owner, used by prepareRetry's checks. */
function ourLease(): LeaseStore {
  return new LeaseStore(db, {
    owner: 'me',
    pid: process.pid,
    hostname: 'h',
    isAlive: () => true,
  });
}

describe('prepareRetry — guards', () => {
  it('errors when the story has no agent on record', () => {
    const res = prepareRetry(db, root, 'story-001-001');
    assert.equal(res.status, 'error');
    assert.match(res.message, /no agent on record/i);
  });

  it('refuses to retry a story that is still running', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'running');
    const res = prepareRetry(db, root, 'story-001-001');
    assert.equal(res.status, 'rejected');
    assert.match(res.message, /still running/i);
  });
});

describe('prepareRetry — self path (no live lease)', () => {
  it('resume-retries a failed story and signals self-dispatch', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'failed');

    const res = prepareRetry(db, root, 'story-001-001', {}, ourLease());

    assert.equal(res.status, 'ready');
    assert.equal(res.dispatch, 'self', 'no lease held → this command dispatches');
    assert.equal(res.epicId, 'epic-001');
    assert.equal(res.willResume, true);
    assert.equal(res.cleaned, false);
    assert.deepEqual(res.resetStories, ['story-001-001']);
    // Epic flipped back to runnable by the shared service.
    assert.equal(epics.get('epic-001')?.status, 'in_progress');
  });

  it('grants a fresh auto-retry budget (clears attempt_class) and says so', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.setAttemptClass(a.id, 'infra_failure');
    agents.updateStatus(a.id, 'failed');
    assert.equal(agents.getByStory('story-001-001')?.attempt_class, 'infra_failure');

    const res = prepareRetry(db, root, 'story-001-001', {}, ourLease());

    assert.equal(res.status, 'ready');
    assert.equal(
      agents.getByStory('story-001-001')?.attempt_class,
      null,
      'auto-retry budget reset: classification cleared'
    );
    assert.match(res.message, /fresh auto-retry budget/i);
  });

  it('clears attempt_class on EVERY historical attempt of the story', () => {
    // Two prior attempts, both classified; both must be cleared.
    const first = agents.create('epic-001', 'story-001-001', 'A');
    agents.setAttemptClass(first.id, 'infra_failure');
    agents.updateStatus(first.id, 'failed');
    const second = agents.create('epic-001', 'story-001-001', 'A');
    agents.setAttemptClass(second.id, 'work_failure');
    agents.updateStatus(second.id, 'failed');

    const res = prepareRetry(db, root, 'story-001-001', {}, ourLease());
    assert.equal(res.status, 'ready');

    const cleared = agents
      .listHistoryByStory('story-001-001')
      .every((r) => r.attempt_class === null);
    assert.ok(cleared, 'no attempt row keeps a stale classification');
  });

  it('clean retry tears down and resets the whole subtree, with a fresh budget each', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.setAttemptClass(a.id, 'infra_failure');
    agents.updateStatus(a.id, 'failed');
    const b = agents.create('epic-001', 'story-001-002', 'B');
    agents.setAttemptClass(b.id, 'work_failure');
    agents.updateStatus(b.id, 'done');

    const res = prepareRetry(db, root, 'story-001-001', { clean: true }, ourLease());

    assert.equal(res.status, 'ready');
    assert.equal(res.dispatch, 'self');
    assert.equal(res.cleaned, true);
    assert.equal(res.willResume, false);
    assert.deepEqual(
      res.resetStories.sort(),
      ['story-001-001', 'story-001-002'],
      'transitive dependent is reset on a clean retry'
    );
    // Budget reset reached the dependent too (it was in resetStories).
    assert.equal(agents.getByStory('story-001-002')?.attempt_class, null);
    // Dependent was reset off SUCCESS so it re-runs.
    assert.equal(agents.getByStory('story-001-002')?.status, 'pending');
  });

  it('records a story_retry audit row tagged dispatch=self with budget_reset', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'failed');

    prepareRetry(db, root, 'story-001-001', { reason: 'flaky infra' }, ourLease());

    const rows = new AuditLog(db)
      .getByStory('story-001-001')
      .filter((r) => r.action === 'story_retry');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail!);
    assert.equal(detail.epic_id, 'epic-001');
  });
});

describe('prepareRetry — queue path (a live run holds the lease)', () => {
  it('resets to ready and defers to the lease-holder instead of self-dispatching', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'failed');
    liveOtherLease();

    const res = prepareRetry(db, root, 'story-001-001', {}, ourLease());

    assert.equal(res.status, 'ready');
    assert.equal(res.dispatch, 'queue', 'lease held → defer to the live run');
    assert.equal(res.cleaned, false);
    // The failed attempt is flipped back to pending so the live supervisor
    // re-dispatches it on its next loop.
    assert.equal(agents.getByStory('story-001-001')?.status, 'pending');
    assert.equal(epics.get('epic-001')?.status, 'in_progress');
    assert.match(res.message, /re-dispatch the story/i);
    assert.match(res.message, /fresh auto-retry budget/i);
  });

  it('grants a fresh auto-retry budget on the queue path too', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.setAttemptClass(a.id, 'infra_failure');
    agents.updateStatus(a.id, 'failed');
    liveOtherLease();

    prepareRetry(db, root, 'story-001-001', {}, ourLease());

    assert.equal(agents.getByStory('story-001-001')?.attempt_class, null);
  });

  it('downgrades --clean to a soft reset while a live run holds the epic (no teardown race)', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'failed');
    const b = agents.create('epic-001', 'story-001-002', 'B');
    agents.updateStatus(b.id, 'done');
    liveOtherLease();

    const res = prepareRetry(db, root, 'story-001-001', { clean: true }, ourLease());

    assert.equal(res.status, 'ready');
    assert.equal(res.dispatch, 'queue');
    assert.equal(res.cleaned, false, 'no teardown happens while a live run holds the epic');
    // Only the target is reset — the dependent is NOT torn down (would race).
    assert.deepEqual(res.resetStories, ['story-001-001']);
    assert.equal(agents.getByStory('story-001-002')?.status, 'done');
    assert.match(res.message, /--clean teardown skipped/i);
  });

  it('records a story_retry audit row tagged dispatch=queue with budget_reset', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'failed');
    liveOtherLease();

    prepareRetry(db, root, 'story-001-001', {}, ourLease());

    const rows = new AuditLog(db)
      .getByStory('story-001-001')
      .filter((r) => r.action === 'story_retry');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail!);
    assert.equal(detail.dispatch, 'queue');
    assert.equal(detail.budget_reset, true);
  });
});
