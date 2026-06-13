import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import { approveAndDispatch } from '../orchestrator/actions/approveAndDispatch.js';
import { resumeEpic } from '../orchestrator/actions/resumeEpic.js';
import { PolicyEngine } from '../guardrails/index.js';
import type { Story } from '../types.js';

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function story(id: string, deps: string[] = []): Story {
  return {
    id,
    title: `Story ${id} title`,
    description: 'Implement the thing.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: deps,
  };
}

/** Seeds an epic in 'planned' status (not auto-approved). */
function seedEpicPlanned(epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId} title`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(path.join(repo, '.loom'));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  // Leave status as 'planned' — do NOT call updateStatus('approved')
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-autonomy-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('Supervisor autonomy modes', () => {
  it('manual gate: planned epic stays planned, no dispatch, no epic_approved row', async () => {
    seedEpicPlanned('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    // autonomy defaults to 'manual' — no setAutonomy call needed

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      lease: false,
    }).run(['epic-001']);

    assert.equal(epicStore.get('epic-001')?.status, 'planned', 'epic must stay planned');
    assert.equal(result.storiesTotal, 0, 'no stories dispatched');
    const auditRows = new AuditLog(db).recent(50).filter((r) => r.action === 'epic_approved');
    assert.equal(auditRows.length, 0, 'no epic_approved audit row written');
  });

  it('full-auto: planned epic auto-approves and runs all stories to completion', async () => {
    seedEpicPlanned('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    epicStore.setAutonomy('epic-001', 'full-auto');

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 2,
      lease: false,
    }).run(['epic-001']);

    assert.equal(epicStore.get('epic-001')?.status, 'done', 'epic must reach done');
    assert.equal(result.storiesDone, 2, 'both stories done');
    assert.equal(result.halted, false, 'run must not be halted');

    const auditRows = new AuditLog(db).recent(50).filter((r) => r.action === 'epic_approved');
    assert.equal(auditRows.length, 1, 'one epic_approved audit row');
    const detail = JSON.parse(auditRows[0].detail!);
    assert.equal(detail.actor, 'full-auto', 'actor is full-auto');
    assert.equal(auditRows[0].command, 'epic-001', 'command is the epic id');
  });

  it('checkpoint: pauses after first story, resumes on resumeEpic', async () => {
    seedEpicPlanned('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    epicStore.setAutonomy('epic-001', 'checkpoint');

    // First run: should dispatch story-001-001 and then pause
    const result1 = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1, // serial so checkpoint is deterministic
      lease: false,
    }).run(['epic-001']);

    assert.equal(epicStore.isPaused('epic-001'), true, 'epic must be paused');
    const epic = epicStore.get('epic-001')!;
    assert.equal(epic.paused_after_story, 'story-001-001', 'paused after first story');
    assert.equal(result1.halted, true, 'run is halted at checkpoint');

    const agents1 = new AgentStore(db);
    assert.equal(agents1.getByStory('story-001-001')?.status, 'done', 'first story done');
    // The agent record is created during task-pool setup, but the story was never dispatched.
    // It must remain 'pending' — not running/done/failed.
    assert.equal(agents1.getByStory('story-001-002')?.status, 'pending', 'second story not dispatched — status must be pending');

    // Resume: clear pause
    await resumeEpic({ epicStore }, 'epic-001');
    assert.equal(epicStore.isPaused('epic-001'), false, 'pause must be cleared');
    assert.equal(epicStore.get('epic-001')?.paused_after_story, null, 'paused_after_story cleared');

    // Second run: should dispatch story-001-002 (story-001-001 is already done)
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      lease: false,
    }).run(['epic-001']);

    assert.equal(agents1.getByStory('story-001-002')?.status, 'done', 'second story dispatched and done');
  });

  it('audit parity: epic_approved row and policy_snapshot are byte-identical for human and full-auto', async () => {
    const loomDir = path.join(repo, '.loom');
    const db = openDatabase(loomDir);
    const epicStore = new EpicStore(db);
    const auditLog = new AuditLog(db);
    const policy = PolicyEngine.load(loomDir).policyData;

    // Human approve path: create epic-001 in planned state and call approveAndDispatch directly
    seedEpicPlanned('epic-001', [story('story-001-001')]);
    await approveAndDispatch({ epicStore, auditLog, policy }, 'epic-001', { actor: 'human' });

    const humanRows = auditLog.recent(50).filter((r) => r.action === 'epic_approved' && r.command === 'epic-001');
    assert.equal(humanRows.length, 1, 'human approve must write one epic_approved row');
    const humanRow = humanRows[0];

    // Full-auto path: create epic-002 in planned state with full-auto autonomy
    seedEpicPlanned('epic-002', [story('story-002-001')]);
    epicStore.setAutonomy('epic-002', 'full-auto');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      lease: false,
    }).run(['epic-002']);

    const autoRows = auditLog.recent(50).filter((r) => r.action === 'epic_approved' && r.command === 'epic-002');
    assert.equal(autoRows.length, 1, 'full-auto must write one epic_approved row');
    const autoRow = autoRows[0];

    // Assert fields are byte-identical except actor
    assert.equal(humanRow.action, autoRow.action, 'action must match');
    assert.equal(humanRow.allowed, autoRow.allowed, 'allowed must match');
    assert.equal(humanRow.policy_rule, autoRow.policy_rule, 'policy_rule must match');

    const humanDetail = JSON.parse(humanRow.detail!);
    const autoDetail = JSON.parse(autoRow.detail!);
    assert.equal(humanDetail.actor, 'human', 'human row actor is human');
    assert.equal(autoDetail.actor, 'full-auto', 'auto row actor is full-auto');

    // Policy snapshot stored on the epic row must be identical
    const epic1 = epicStore.get('epic-001')!;
    const epic2 = epicStore.get('epic-002')!;
    assert.equal(epic1.policy_snapshot, epic2.policy_snapshot, 'policy snapshots must be identical');

    // Both epics must be in approved or later status (full-auto reaches done)
    assert.ok(
      ['approved', 'in_progress', 'done'].includes(epic1.status),
      'human-approved epic must be approved or later'
    );
    assert.equal(epic2.status, 'done', 'full-auto epic must reach done');
  });

  it('full-auto: no story is double-dispatched across runs', async () => {
    seedEpicPlanned('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    epicStore.setAutonomy('epic-001', 'full-auto');

    const worker = new MockWorkerRunner({ status: 'done' });

    // First run completes all stories
    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      lease: false,
    }).run(['epic-001']);

    const dispatchedFirst = worker.assignments.map((a) => a.storyId);

    // Second run: stories are already done, none should re-dispatch
    await new Supervisor({
      projectRoot: repo,
      db,
      worker,
      maxConcurrent: 2,
      lease: false,
    }).run(['epic-001']);

    const dispatchedSecond = worker.assignments
      .map((a) => a.storyId)
      .filter((id) => !dispatchedFirst.includes(id));

    assert.deepEqual(dispatchedSecond, [], 'no story must be re-dispatched on a second run');
  });

  it('checkpoint: last story completes without pause (clean finish)', async () => {
    seedEpicPlanned('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const epicStore = new EpicStore(db);
    epicStore.setAutonomy('epic-001', 'checkpoint');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      lease: false,
    }).run(['epic-001']);

    // With only one story, it's the last — no pause should be set
    assert.equal(epicStore.isPaused('epic-001'), false, 'last story must not pause the epic');
    assert.equal(epicStore.get('epic-001')?.status, 'done', 'single-story checkpoint epic must finish done');
  });
});
