import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../state/Database.js';
import { EpicStore, AgentStore, LeaseStore } from '../state/index.js';
import { StoryRetryService } from '../orchestrator/StoryRetryService.js';
import { StoryHandoff } from '../orchestrator/StoryHandoff.js';
import type { WorktreeManager } from '../orchestrator/WorktreeManager.js';
import type Database from 'better-sqlite3';

const EPIC_YAML = `epic_id: epic-001
title: Retry service test epic
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
  - id: story-001-003
    title: Dependent story C
    description: stacks on B
    acceptance_criteria: ["c"]
    estimated_complexity: small
    dependencies: ["story-001-002"]
`;

interface RemoveCall {
  storyId: string;
  deleteBranch: boolean;
}

function fakeWorktrees(calls: RemoveCall[]): WorktreeManager {
  return {
    remove(storyId: string, opts: { deleteBranch?: boolean } = {}): void {
      calls.push({ storyId, deleteBranch: opts.deleteBranch === true });
    },
  } as unknown as WorktreeManager;
}

describe('StoryRetryService', () => {
  let root: string;
  let db: Database.Database;
  let epics: EpicStore;
  let agents: AgentStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-retry-'));
    const yamlRel = path.join('.loom', 'planning', 'epic-001', 'epic-001.yaml');
    fs.mkdirSync(path.dirname(path.join(root, yamlRel)), { recursive: true });
    fs.writeFileSync(path.join(root, yamlRel), EPIC_YAML);
    db = createDatabase(':memory:');
    epics = new EpicStore(db);
    agents = new AgentStore(db);
    epics.create('epic-001', 'Retry service test epic', yamlRel);
    epics.updateStatus('epic-001', 'in_progress');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('errors when the story has no agent on record', () => {
    const svc = new StoryRetryService({ projectRoot: root, db });
    const res = svc.prepare('story-001-001');
    assert.equal(res.status, 'error');
  });

  it('refuses to retry a story that is still running', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'running');
    const svc = new StoryRetryService({ projectRoot: root, db });
    const res = svc.prepare('story-001-001');
    assert.equal(res.status, 'rejected');
    assert.match(res.message, /still running/i);
  });

  it('refuses when a live supervisor holds the epic dispatch lease', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'failed');
    // Another live supervisor holds the lease.
    const otherLease = new LeaseStore(db, { owner: 'other', pid: 1, hostname: 'h', isAlive: () => true });
    assert.ok(otherLease.acquire('epic-001'));
    const svc = new StoryRetryService({
      projectRoot: root,
      db,
      leaseStore: new LeaseStore(db, { owner: 'me', pid: 1, hostname: 'h', isAlive: () => true }),
    });
    const res = svc.prepare('story-001-001');
    assert.equal(res.status, 'rejected');
    assert.match(res.message, /active dispatch run/i);
  });

  it('resume retry keeps the branch and flags willResume (no teardown)', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'failed');
    const calls: RemoveCall[] = [];
    const svc = new StoryRetryService({
      projectRoot: root,
      db,
      worktrees: fakeWorktrees(calls),
    });
    const res = svc.prepare('story-001-001');
    assert.equal(res.status, 'ready');
    assert.equal(res.cleaned, false);
    assert.equal(res.willResume, true);
    assert.deepEqual(res.resetStories, ['story-001-001']);
    assert.equal(calls.length, 0, 'resume retry tears nothing down');
    assert.equal(epics.get('epic-001')?.status, 'in_progress');
  });

  it('clean retry tears down the target + transitive dependents and resets them', () => {
    const a = agents.create('epic-001', 'story-001-001', 'A');
    agents.updateStatus(a.id, 'failed');
    const b = agents.create('epic-001', 'story-001-002', 'B');
    agents.updateStatus(b.id, 'done');
    const c = agents.create('epic-001', 'story-001-003', 'C');
    agents.updateStatus(c.id, 'done');
    // Seed handoff docs that a clean retry should clear.
    StoryHandoff.write(root, 'story-001-001', '# stale');
    StoryHandoff.write(root, 'story-001-003', '# stale');

    const calls: RemoveCall[] = [];
    const svc = new StoryRetryService({
      projectRoot: root,
      db,
      clean: true,
      worktrees: fakeWorktrees(calls),
    });
    const res = svc.prepare('story-001-001');

    assert.equal(res.status, 'ready');
    assert.equal(res.cleaned, true);
    assert.equal(res.willResume, false);
    assert.deepEqual(
      res.resetStories.sort(),
      ['story-001-001', 'story-001-002', 'story-001-003']
    );
    // Every story in the subtree had its worktree + branch removed.
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.deleteBranch));
    // Previously-successful dependents are reset off SUCCESS so they re-run.
    assert.equal(agents.getByStory('story-001-002')?.status, 'pending');
    assert.equal(agents.getByStory('story-001-003')?.status, 'pending');
    // Stale handoff docs cleared.
    assert.equal(fs.existsSync(StoryHandoff.pathFor(root, 'story-001-001')), false);
    assert.equal(fs.existsSync(StoryHandoff.pathFor(root, 'story-001-003')), false);
  });
});
