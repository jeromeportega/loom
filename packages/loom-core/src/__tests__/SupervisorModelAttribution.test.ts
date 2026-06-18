/**
 * Model attribution tests (epic-013, story-013-002).
 *
 * Covers the two-phase write: requested model at dispatch (phase 1) and
 * executed model from the system/init stream event (phase 2). Also covers
 * the planner path (EpicStore.planner_model) and the ADR-003 invariant that
 * CodeReviewAgent does not create a distinct agent row.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { AgentStore } from '../state/AgentStore.js';
import { EpicStore } from '../state/EpicStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import type { Story } from '../types.js';

// ─── helpers ────────────────────────────────────────────────────────────────

let repo: string;
let loomDir: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function story(id: string, deps: string[] = []): Story {
  return {
    id,
    title: `Story ${id}`,
    description: 'Implement the thing.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: deps,
  };
}

function seedEpic(epicId: string, stories: Story[]): void {
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
  store.updateStatus(epicId, 'approved');
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-model-attr-'));
  loomDir = path.join(repo, '.loom');
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

// ─── AgentStore unit tests ───────────────────────────────────────────────────

describe('AgentStore.setModel', () => {
  it('persists model and second call overwrites (executed beats requested)', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const agents = new AgentStore(db);
    const agent = agents.create('epic-001', 'story-001-001');

    assert.equal(agents.get(agent.id)?.model, null, 'initially null');

    agents.setModel(agent.id, 'claude-sonnet-4-6');
    assert.equal(agents.get(agent.id)?.model, 'claude-sonnet-4-6');

    agents.setModel(agent.id, 'claude-opus-4-8');
    assert.equal(agents.get(agent.id)?.model, 'claude-opus-4-8', 'second call overwrites');
  });
});

// ─── EpicStore unit tests ────────────────────────────────────────────────────

describe('EpicStore.setPlannerModel', () => {
  it('persists planner_model alongside status and title', () => {
    const db = openDatabase(loomDir);
    const store = new EpicStore(db);
    store.create('epic-001', 'My Epic');

    assert.equal(store.get('epic-001')?.planner_model, null, 'initially null');

    store.setPlannerModel('epic-001', 'claude-opus-4-7');
    assert.equal(store.get('epic-001')?.planner_model, 'claude-opus-4-7');

    store.setPlannerModel('epic-001', 'claude-opus-4-8');
    assert.equal(store.get('epic-001')?.planner_model, 'claude-opus-4-8', 'second call overwrites');
  });
});

// ─── Supervisor integration tests ────────────────────────────────────────────

describe('Supervisor model attribution', () => {
  it('writes requested model at dispatch time (phase 1)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    let agentIdAtDispatch: string | undefined;
    let modelAtDispatch: string | null | undefined;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner((assignment) => {
        // Read the DB mid-run (inside the worker responder, before result lands).
        const agents = new AgentStore(db);
        const rec = agents.getByStory(assignment.storyId);
        agentIdAtDispatch = rec?.id;
        modelAtDispatch = rec?.model;
        return {
          status: 'done',
          commitCount: 1,
          summary: 'done',
          logTail: '',
        };
      }),
      maxConcurrent: 1,
      workerModel: 'claude-sonnet-4-6',
    }).run();

    assert.ok(agentIdAtDispatch, 'agent record exists at dispatch');
    assert.equal(modelAtDispatch, 'claude-sonnet-4-6', 'phase-1 model written at dispatch');
  });

  it('upgrades to executed model from WorkerResult.model (phase 2)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        model: 'claude-opus-4-8',
      }),
      maxConcurrent: 1,
      workerModel: 'claude-sonnet-4-6',
    }).run();

    const rec = new AgentStore(db).getByStory('story-001-001');
    assert.equal(
      rec?.model,
      'claude-opus-4-8',
      'executed model overwrites requested model after applyResult'
    );
  });

  it('keeps requested model when worker dies before init (no model in result)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'failed',
        commitCount: 0,
        summary: 'crashed before init',
        logTail: '',
        // model absent — simulates worker dying before system/init
      }),
      maxConcurrent: 1,
      workerModel: 'claude-sonnet-4-6',
    }).run();

    const rec = new AgentStore(db).getByStory('story-001-001');
    assert.equal(
      rec?.model,
      'claude-sonnet-4-6',
      'requested model is retained when result carries no executed model'
    );
  });

  it('leaves model null when workerModel is not set (role with no resolved model)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        // no model in result either
      }),
      maxConcurrent: 1,
      // workerModel not set
    }).run();

    const rec = new AgentStore(db).getByStory('story-001-001');
    assert.equal(rec?.model, null, 'model stays null when no workerModel configured');
  });

  it('creates no distinct agent row for CodeReviewAgent (ADR-003)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        review: {
          status: 'passed',
          blockerCount: 0,
          totalCount: 0,
          summary: 'LGTM',
          revisions: 0,
        },
      }),
      maxConcurrent: 1,
      workerModel: 'claude-sonnet-4-6',
    }).run();

    const agents = new AgentStore(db).listByEpic('epic-001');
    assert.equal(agents.length, 1, 'exactly one agent row — reviewer rides the worker row');
    assert.equal(agents[0].review_status, 'passed', 'review outcome on worker row');
  });
});
