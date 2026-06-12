import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { EpicReverter } from '../orchestrator/EpicReverter.js';

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-revert-'));
  gitc(['init', '-q', '-b', 'main']);
  gitc(['config', 'user.email', 't@loom.dev']);
  gitc(['config', 'user.name', 'T']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('EpicReverter', () => {
  it('skipped when the epic does not exist', () => {
    const db = openDatabase(path.join(repo, '.loom'));
    const reverter = new EpicReverter({ projectRoot: repo, db, allowedRemotes: [] });
    const r = reverter.revert('epic-nope');
    assert.equal(r.status, 'skipped');
  });

  it('deletes the epic + story branches locally and flips status to rejected', () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    new AgentStore(db).create('epic-001', 'story-001-001');
    new AgentStore(db).create('epic-001', 'story-001-002');

    // Seed branches that the reverter should delete. (In a real run these
    // come from worktree creation + the EpicFinalizer merge; here we
    // create them by hand from main.)
    for (const b of ['story/story-001-001', 'story/story-001-002', 'epic/epic-001']) {
      gitc(['branch', b]);
    }

    const reverter = new EpicReverter({ projectRoot: repo, db, allowedRemotes: [] });
    const r = reverter.revert('epic-001', { reason: 'bad plan' });
    assert.equal(r.status, 'reverted');
    assert.deepEqual(
      r.deleted_refs.sort(),
      ['epic/epic-001', 'story/story-001-001', 'story/story-001-002'],
    );

    // Branches really gone.
    for (const b of ['story/story-001-001', 'story/story-001-002', 'epic/epic-001']) {
      const out = execFileSync(
        'git',
        ['branch', '-l', b],
        { cwd: repo, encoding: 'utf8' },
      ).trim();
      assert.equal(out, '', `${b} should be deleted`);
    }

    // Status flipped + reason recorded.
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'rejected');

    // Audit row landed.
    const audit = new AuditLog(db).recent(10).find((r) => r.action === 'epic_revert');
    assert.ok(audit, 'epic_revert audit row should land');
    assert.match(audit?.detail ?? '', /bad plan/);
  });

  it('best-effort on branches that were already cleaned up — no error', () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    new AgentStore(db).create('epic-001', 'story-001-001');
    // No branches created — finalize already cleaned them up.

    const reverter = new EpicReverter({ projectRoot: repo, db, allowedRemotes: [] });
    const r = reverter.revert('epic-001');
    assert.equal(r.status, 'reverted');
    assert.equal(r.deleted_refs.length, 0);
  });

  it('--remote without an allowed remote becomes a partial revert', () => {
    const db = openDatabase(path.join(repo, '.loom'));
    new EpicStore(db).create('epic-001', 'Seeded');
    new AgentStore(db).create('epic-001', 'story-001-001');
    gitc(['branch', 'epic/epic-001']);
    // Configure a remote that's NOT in allowedRemotes.
    gitc(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);

    const reverter = new EpicReverter({
      projectRoot: repo,
      db,
      allowedRemotes: ['https://allowed.example/**'],
    });
    const r = reverter.revert('epic-001', { remote: true });
    // Local cleanup still happened.
    assert.deepEqual(r.deleted_refs, ['epic/epic-001']);
    // But the remote step was blocked.
    assert.equal(r.status, 'partial');
    assert.equal(r.deleted_remote_refs.length, 0);
  });
});
