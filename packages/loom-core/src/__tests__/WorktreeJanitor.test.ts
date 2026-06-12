import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeManager } from '../orchestrator/WorktreeManager.js';
import { WorktreeJanitor } from '../orchestrator/WorktreeJanitor.js';
import { AgentStore } from '../state/AgentStore.js';
import { EpicStore } from '../state/EpicStore.js';
import { createDatabase } from '../state/Database.js';
import type Database from 'better-sqlite3';
import type { AgentStatus } from '../types.js';

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('WorktreeJanitor', () => {
  let repo: string;
  let db: Database.Database;
  let wt: WorktreeManager;
  let agents: AgentStore;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-janitor-'));
    gitc(['init', '-q'], repo);
    gitc(['config', 'user.email', 'test@loom.dev'], repo);
    gitc(['config', 'user.name', 'Loom Test'], repo);
    gitc(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
    gitc(['add', '.'], repo);
    gitc(['commit', '-q', '-m', 'initial'], repo);

    fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
    db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    wt = new WorktreeManager(repo);
    agents = new AgentStore(db);
    new EpicStore(db).create('epic-001', 'Test epic');
  });

  afterEach(() => {
    try { db.close(); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function seed(storyId: string, status: AgentStatus): void {
    const a = agents.create('epic-001', storyId, storyId);
    agents.updateStatus(a.id, status);
  }

  it('flags a worktree whose story is done, keeps failed/blocked/running', () => {
    wt.create('story-001-001'); // done → orphan
    wt.create('story-001-002'); // failed → keep
    wt.create('story-001-003'); // blocked → keep
    wt.create('story-001-004'); // running → keep
    seed('story-001-001', 'done');
    seed('story-001-002', 'failed');
    seed('story-001-003', 'blocked');
    seed('story-001-004', 'running');

    const orphans = new WorktreeJanitor(wt, agents).findOrphans();
    assert.deepEqual(
      orphans.map((o) => `${o.storyId}:${o.reason}`).sort(),
      ['story-001-001:completed']
    );
  });

  it('flags a worktree with no agent record as no-agent', () => {
    wt.create('story-009-009'); // dir exists, no agent row
    const orphans = new WorktreeJanitor(wt, agents).findOrphans();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].storyId, 'story-009-009');
    assert.equal(orphans[0].reason, 'no-agent');
  });

  it('prune removes done + no-agent worktrees and preserves failed', () => {
    wt.create('story-001-001');
    wt.create('story-001-002');
    wt.create('story-007-007'); // no agent
    seed('story-001-001', 'done');
    seed('story-001-002', 'failed');

    const pruned = new WorktreeJanitor(wt, agents).prune();
    assert.equal(pruned.length, 2);

    const remaining = wt.list().map((w) => w.storyId).sort();
    assert.deepEqual(remaining, ['story-001-002'], 'only the failed story survives');
    assert.ok(
      !fs.existsSync(wt.worktreePath('story-001-001')),
      'the done worktree was removed from disk'
    );
  });

  it('deletes the branch for completed orphans but keeps it for no-agent', () => {
    wt.create('story-001-001');
    wt.create('story-002-002'); // no agent — branch should survive
    seed('story-001-001', 'done');

    new WorktreeJanitor(wt, agents).prune();

    const doneBranch = execFileSync('git', ['branch', '--list', 'story/story-001-001'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    assert.equal(doneBranch, '', 'completed orphan branch deleted');

    const noAgentBranch = execFileSync('git', ['branch', '--list', 'story/story-002-002'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    assert.ok(noAgentBranch.includes('story/story-002-002'), 'no-agent branch preserved');
  });

  it('reports nothing when there are no worktrees', () => {
    assert.deepEqual(new WorktreeJanitor(wt, agents).findOrphans(), []);
  });
});
