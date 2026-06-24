/**
 * story-061-003: Clean auto-retry on stall.
 *
 * Integration-level tests: exercise Supervisor.applyResult()'s stall block
 * with a real RecoveryStore (temp DB), real AuditLog, and test doubles for
 * StoryRetryService so routing/budget/audit wiring is verified without real
 * worktree operations.
 *
 * Key test cases:
 *  (1) Stall under budget → clean retry (audit row + count increment + re-dispatch)
 *  (2) Never resume: resume/clean:false path not invoked for a stall
 *  (3) Budget boundary: count == budget → no retry; count == budget-1 → retry
 *  (4) Budget knob 0 → immediate surface (no retry)
 *  (5) Default budget ?? 2 when option unset
 *  (6) task_error exit → not auto-retried
 *  (7) 'other' exit (cap) → not auto-retried
 *  (8) prep.status !== 'ready' → fall through, no increment
 *  (9) Audit-first: both stall_kill row and auto_recovery row present before return
 * (10) hung_request classified as stall → clean retry path
 * (11) Normal success exit → unchanged (regression)
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
import { AuditLog } from '../../state/AuditLog.js';
import { RecoveryStore } from '../../state/RecoveryStore.js';
import { Supervisor } from '../Supervisor.js';
import { MockWorkerRunner } from '../MockWorkerRunner.js';
import {
  WORKER_AUTO_RECOVERY_ACTION,
  STALL_KILL_ACTION,
  recordAutoRecovery,
  type AutoRecoveryDetail,
} from '../StallKillAudit.js';
import type { StoryRetryResult } from '../StoryRetryService.js';
import { PolicySchema, type Story } from '../../types.js';

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

function makeStory(id: string, deps: string[] = []): Story {
  return {
    id,
    title: `Story ${id}`,
    description: 'Implement it.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: deps,
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

/** Builds a minimal StoryRetryService test double. */
function makeRetryDouble(
  result: Partial<StoryRetryResult> & Pick<StoryRetryResult, 'status'>
) {
  const calls: string[] = [];
  const svc = {
    prepare(storyId: string): StoryRetryResult {
      calls.push(storyId);
      return {
        storyId,
        epicId: 'epic-001',
        cleaned: result.status === 'ready',
        resetStories: result.resetStories ?? [storyId],
        willResume: false,
        message: 'mock',
        ...result,
      };
    },
    calls,
  };
  // Cast to StoryRetryService — we only need prepare() at the call site.
  return svc as unknown as import('../StoryRetryService.js').StoryRetryService & { calls: string[] };
}

// ─── Test state ───────────────────────────────────────────────────────────────

let repoDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ar-'));
  initRepo(repoDir);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  resetDatabaseForTest();
});

// ─── (1) Stall under budget → clean retry ─────────────────────────────────────

describe('autoRecovery — stall under budget → clean retry', () => {
  it('writes worker_auto_recovery audit row and increments RecoveryStore before returning', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    let callCount = 0;
    const worker = new MockWorkerRunner(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 'failed' as const,
          killReason: 'stall' as const,
          commitCount: 0,
          summary: 'stalled',
          logTail: '',
        });
      }
      return Promise.resolve({ status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' });
    });

    const cleanSvc = makeRetryDouble({ status: 'ready', resetStories: ['story-001-001'] });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    await supervisor.run(['epic-001']);

    // Verify clean retry service was called
    assert.deepEqual(cleanSvc.calls, ['story-001-001'], 'prepare() called with storyId');

    // Verify audit row
    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const recoveryRow = rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION);
    assert.ok(recoveryRow, 'worker_auto_recovery audit row present');
    assert.equal(recoveryRow!.command, 'story-001-001', 'command = storyId');

    const detail: AutoRecoveryDetail = JSON.parse(recoveryRow!.detail ?? '{}');
    assert.equal(detail.recovery_attempt, 1, 'recovery_attempt = 1 (1-based)');
    assert.equal(detail.budget, 2, 'budget matches opt');
    assert.equal(detail.kill_reason, 'stall');
    assert.deepEqual(detail.reset_stories, ['story-001-001']);

    // Verify RecoveryStore count
    const recoveryStore = new RecoveryStore(db);
    assert.equal(recoveryStore.getRecoveryCount('story-001-001'), 1);

    // Verify the story eventually succeeded (was re-dispatched)
    assert.equal(callCount, 2, 'worker dispatched twice (stall then success)');
  });

  it('hung_request is also classified as stall → clean retry path', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    let callCount = 0;
    const worker = new MockWorkerRunner(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 'failed' as const,
          killReason: 'hung_request' as const,
          commitCount: 0,
          summary: 'hung',
          logTail: '',
        });
      }
      return Promise.resolve({ status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' });
    });

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    await supervisor.run(['epic-001']);

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const recoveryRow = rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION);
    assert.ok(recoveryRow, 'hung_request → clean retry audit row present');

    const detail: AutoRecoveryDetail = JSON.parse(recoveryRow!.detail ?? '{}');
    assert.equal(detail.kill_reason, 'hung_request');
    assert.equal(callCount, 2, 're-dispatched after hung_request stall');
  });
});

// ─── (2) Never resume: shouldAutoResume path not invoked ─────────────────────

describe('autoRecovery — never resume path', () => {
  it('resume-mode retryService.prepare() is NOT called for a stall', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    let callCount = 0;
    const worker = new MockWorkerRunner(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 'failed' as const,
          killReason: 'stall' as const,
          commitCount: 0,
          summary: 'stalled',
          logTail: '',
          checkpointCommitted: true, // has checkpoint — would trigger old resume path
        });
      }
      return Promise.resolve({ status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' });
    });

    const resumeSvc = makeRetryDouble({ status: 'ready', willResume: true });
    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      autoResumeAttempts: 2, // old knob enabled — should NOT trigger
      retryService: resumeSvc, // old resume service — should NOT be called
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    await supervisor.run(['epic-001']);

    // The resume service must NOT have been called
    assert.equal(resumeSvc.calls.length, 0, 'resume-mode retryService.prepare() never called');
    // The clean service must have been called
    assert.equal(cleanSvc.calls.length, 1, 'clean-mode retryService.prepare() called once');
  });
});

// ─── (3) Budget boundary ──────────────────────────────────────────────────────

describe('autoRecovery — budget boundary', () => {
  it('count == budget → no retry (story surfaces as failed)', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    // Pre-populate: already at budget
    const recoveryStore = new RecoveryStore(db);
    recoveryStore.incrementRecoveryCount('story-001-001');
    recoveryStore.incrementRecoveryCount('story-001-001'); // count = 2 = budget

    const worker = new MockWorkerRunner(() =>
      Promise.resolve({
        status: 'failed' as const,
        killReason: 'stall' as const,
        commitCount: 0,
        summary: 'stalled',
        logTail: '',
      })
    );

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    const result = await supervisor.run(['epic-001']);

    // No retry: prepare() not called, story failed
    assert.equal(cleanSvc.calls.length, 0, 'prepare() not called when budget exhausted');
    assert.equal(result.storiesFailed, 1);

    // Count not incremented
    assert.equal(recoveryStore.getRecoveryCount('story-001-001'), 2, 'count unchanged');

    // No auto_recovery row
    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const recoveryRow = rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION);
    assert.equal(recoveryRow, undefined, 'no worker_auto_recovery row');
  });

  it('count == budget-1 → retry allowed', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    // Pre-populate: one below budget (2)
    const recoveryStore = new RecoveryStore(db);
    recoveryStore.incrementRecoveryCount('story-001-001'); // count = 1 < 2

    let callCount = 0;
    const worker = new MockWorkerRunner(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 'failed' as const,
          killReason: 'stall' as const,
          commitCount: 0,
          summary: 'stalled',
          logTail: '',
        });
      }
      return Promise.resolve({ status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' });
    });

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    await supervisor.run(['epic-001']);

    // Retry happened
    assert.equal(cleanSvc.calls.length, 1, 'prepare() called (count was under budget)');
    assert.equal(recoveryStore.getRecoveryCount('story-001-001'), 2, 'count incremented to 2');
    assert.equal(callCount, 2, 're-dispatched after stall');
  });

  it('stops at exactly budget: two stalls use both retries, third stall surfaces', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    let callCount = 0;
    const worker = new MockWorkerRunner(() => {
      callCount++;
      // First 3 calls stall; 4th would succeed (but shouldn't be reached)
      if (callCount <= 3) {
        return Promise.resolve({
          status: 'failed' as const,
          killReason: 'stall' as const,
          commitCount: 0,
          summary: 'stalled',
          logTail: '',
        });
      }
      return Promise.resolve({ status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' });
    });

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    const result = await supervisor.run(['epic-001']);

    // Budget=2: first stall → retry (count=1), second stall → retry (count=2),
    // third stall → budget exhausted, surface.
    assert.equal(callCount, 3, 'dispatched 3 times (1 initial + 2 retries then stopped)');
    assert.equal(cleanSvc.calls.length, 2, 'prepare() called twice (both retry slots used)');
    assert.equal(result.storiesFailed, 1, 'story surfaces as failed');

    const recoveryStore = new RecoveryStore(db);
    assert.equal(recoveryStore.getRecoveryCount('story-001-001'), 2, 'count stopped at budget');
  });
});

// ─── (4) Budget knob 0 → no recovery ─────────────────────────────────────────

describe('autoRecovery — budget 0 disables recovery', () => {
  it('stallRecoveryBudget: 0 → no retry, story surfaces immediately', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    const worker = new MockWorkerRunner(() =>
      Promise.resolve({
        status: 'failed' as const,
        killReason: 'stall' as const,
        commitCount: 0,
        summary: 'stalled',
        logTail: '',
      })
    );

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 0,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    const result = await supervisor.run(['epic-001']);

    assert.equal(cleanSvc.calls.length, 0, 'prepare() never called (budget=0)');
    assert.equal(result.storiesFailed, 1, 'story surfaces as failed');
  });
});

// ─── (5) Default budget ?? 2 ─────────────────────────────────────────────────

describe('autoRecovery — default budget', () => {
  it('stallRecoveryBudget unset → effective budget 2 (default)', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    let callCount = 0;
    const worker = new MockWorkerRunner(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 'failed' as const,
          killReason: 'stall' as const,
          commitCount: 0,
          summary: 'stalled',
          logTail: '',
        });
      }
      return Promise.resolve({ status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' });
    });

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      // stallRecoveryBudget not set → defaults to 2
      cleanRetryService: cleanSvc,
      lease: false,
    });

    await supervisor.run(['epic-001']);

    // Recovery happened → budget was effectively 2, count=0 < 2 → allowed
    assert.equal(cleanSvc.calls.length, 1, 'default budget=2: retry allowed');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const detail: AutoRecoveryDetail = JSON.parse(
      rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION)?.detail ?? '{}'
    );
    assert.equal(detail.budget, 2, 'budget=2 recorded in audit detail');
  });
});

// ─── (6) task_error exit → not auto-retried ───────────────────────────────────

describe('autoRecovery — task_error exit not auto-retried', () => {
  it('status=failed with logTail (task_error) → no recovery, RecoveryStore untouched', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    const worker = new MockWorkerRunner({
      status: 'failed',
      commitCount: 0,
      summary: 'tests failed',
      logTail: 'Error: test suite failed with 3 failures',
      // No killReason → classifyWorkerExit returns 'task_error'
    });

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    const result = await supervisor.run(['epic-001']);

    // No recovery
    assert.equal(cleanSvc.calls.length, 0, 'prepare() not called for task_error');
    assert.equal(result.storiesFailed, 1);

    const recoveryStore = new RecoveryStore(db);
    assert.equal(recoveryStore.getRecoveryCount('story-001-001'), 0, 'RecoveryStore untouched');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    assert.equal(
      rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION),
      undefined,
      'no worker_auto_recovery row'
    );
    // Also no stall_kill row (task_error is not a stall)
    assert.equal(
      rows.find((r) => r.action === STALL_KILL_ACTION),
      undefined,
      'no worker_stall_kill row'
    );
  });
});

// ─── (7) 'other' exit (cap) → not auto-retried ───────────────────────────────

describe('autoRecovery — cap (other) exit not auto-retried', () => {
  it('killReason=cap → no recovery', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    const worker = new MockWorkerRunner(() =>
      Promise.resolve({
        status: 'failed' as const,
        killReason: 'cap',
        commitCount: 0,
        summary: 'cap hit',
        logTail: '',
      })
    );

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    const result = await supervisor.run(['epic-001']);

    assert.equal(cleanSvc.calls.length, 0, 'prepare() not called for cap exit');
    assert.equal(result.storiesFailed, 1);

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    assert.equal(
      rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION),
      undefined,
      'no worker_auto_recovery row for cap exit'
    );
    assert.equal(
      rows.find((r) => r.action === STALL_KILL_ACTION),
      undefined,
      'no worker_stall_kill row for cap exit'
    );
  });
});

// ─── (8) prep.status !== 'ready' → fall through ──────────────────────────────

describe('autoRecovery — prep rejected → no increment, story surfaces', () => {
  it('prepare() returns rejected → no increment, no audit row, story left failed', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    const worker = new MockWorkerRunner(() =>
      Promise.resolve({
        status: 'failed' as const,
        killReason: 'stall' as const,
        commitCount: 0,
        summary: 'stalled',
        logTail: '',
      })
    );

    const cleanSvc = makeRetryDouble({ status: 'rejected' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    const result = await supervisor.run(['epic-001']);

    // prepare() was called but returned rejected → no increment or audit row
    assert.equal(cleanSvc.calls.length, 1, 'prepare() called but returned rejected');
    assert.equal(result.storiesFailed, 1, 'story surfaces as failed');

    const recoveryStore = new RecoveryStore(db);
    assert.equal(recoveryStore.getRecoveryCount('story-001-001'), 0, 'count not incremented');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    assert.equal(
      rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION),
      undefined,
      'no worker_auto_recovery row when prep rejected'
    );
  });
});

// ─── (9) Audit-first invariant ────────────────────────────────────────────────

describe('autoRecovery — audit-first invariant', () => {
  it('stall_kill row AND auto_recovery row both persisted before return', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    let callCount = 0;
    const worker = new MockWorkerRunner(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 'failed' as const,
          killReason: 'stall' as const,
          commitCount: 0,
          summary: 'stalled',
          logTail: '',
        });
      }
      return Promise.resolve({ status: 'done' as const, commitCount: 1, summary: 'ok', logTail: '' });
    });

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    await supervisor.run(['epic-001']);

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');

    const killRow = rows.find((r) => r.action === STALL_KILL_ACTION);
    const recoveryRow = rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION);

    assert.ok(killRow, 'stall_kill row present');
    assert.ok(recoveryRow, 'auto_recovery row present');

    // Both rows for the same story (recovery is reconstructable from audit)
    assert.equal(killRow!.command, 'story-001-001');
    assert.equal(recoveryRow!.command, 'story-001-001');
  });
});

// ─── (10) Normal success exit → no recovery ───────────────────────────────────

describe('autoRecovery — normal success not affected', () => {
  it('status=done → no stall_kill or auto_recovery rows, RecoveryStore untouched', async () => {
    seedEpic(repoDir, 'epic-001', [makeStory('story-001-001')]);
    const loomDir = path.join(repoDir, '.loom');
    const db = openDatabase(loomDir);

    const worker = new MockWorkerRunner({
      status: 'done',
      commitCount: 1,
      summary: 'implemented',
      logTail: '',
    });

    const cleanSvc = makeRetryDouble({ status: 'ready' });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      stallRecoveryBudget: 2,
      cleanRetryService: cleanSvc,
      lease: false,
    });

    const result = await supervisor.run(['epic-001']);

    assert.equal(cleanSvc.calls.length, 0, 'prepare() not called on success');
    assert.equal(result.storiesDone, 1);

    const recoveryStore = new RecoveryStore(db);
    assert.equal(recoveryStore.getRecoveryCount('story-001-001'), 0, 'count untouched');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    assert.equal(rows.find((r) => r.action === STALL_KILL_ACTION), undefined);
    assert.equal(rows.find((r) => r.action === WORKER_AUTO_RECOVERY_ACTION), undefined);
  });
});

// ─── Unit: recordAutoRecovery (StallKillAudit additions) ─────────────────────

type AuditRecord = Parameters<AuditLog['record']>[0];

describe('recordAutoRecovery — row shape', () => {
  it('action === WORKER_AUTO_RECOVERY_ACTION ("worker_auto_recovery")', () => {
    const calls: AuditRecord[] = [];
    const audit = {
      record: (entry: AuditRecord) => calls.push(entry),
    } as unknown as AuditLog;

    recordAutoRecovery(audit, {
      agentId: 'agent-story-001-001-aabbccdd',
      storyId: 'story-001-001',
      detail: { recovery_attempt: 1, budget: 2, kill_reason: 'stall', reset_stories: ['story-001-001'] },
    });

    assert.equal(calls[0].action, WORKER_AUTO_RECOVERY_ACTION);
    assert.equal(WORKER_AUTO_RECOVERY_ACTION, 'worker_auto_recovery');
  });

  it('command === storyId so getByStory finds it across retries', () => {
    const calls: AuditRecord[] = [];
    const audit = {
      record: (entry: AuditRecord) => calls.push(entry),
    } as unknown as AuditLog;

    recordAutoRecovery(audit, {
      agentId: 'agent-aabb',
      storyId: 'story-001-001',
      detail: { recovery_attempt: 1, budget: 2, kill_reason: 'hung_request', reset_stories: [] },
    });

    assert.equal(calls[0].command, 'story-001-001');
    assert.equal(calls[0].agent_id, 'agent-aabb');
    assert.equal(calls[0].allowed, true);
  });

  it('detail carries all AutoRecoveryDetail fields', () => {
    const calls: AuditRecord[] = [];
    const audit = {
      record: (entry: AuditRecord) => calls.push(entry),
    } as unknown as AuditLog;

    recordAutoRecovery(audit, {
      agentId: 'agent-aabb',
      storyId: 'story-001-001',
      detail: {
        recovery_attempt: 2,
        budget: 3,
        kill_reason: 'stall',
        reset_stories: ['story-001-001', 'story-001-002'],
      },
    });

    const detail: AutoRecoveryDetail = calls[0].detail as unknown as AutoRecoveryDetail;
    assert.equal(detail.recovery_attempt, 2);
    assert.equal(detail.budget, 3);
    assert.equal(detail.kill_reason, 'stall');
    assert.deepEqual(detail.reset_stories, ['story-001-001', 'story-001-002']);
  });
});

// ─── Unit: PolicySchema — stall_recovery_budget ───────────────────────────────

describe('PolicySchema — stall_recovery_budget', () => {
  it('defaults to 2 when unset', () => {
    const policy = PolicySchema.parse({});
    assert.equal(policy.agents.stall_recovery_budget, 2);
  });

  it('honours an explicit value', () => {
    const policy = PolicySchema.parse({ agents: { stall_recovery_budget: 3 } });
    assert.equal(policy.agents.stall_recovery_budget, 3);
  });

  it('accepts 0 (disable sentinel)', () => {
    const policy = PolicySchema.parse({ agents: { stall_recovery_budget: 0 } });
    assert.equal(policy.agents.stall_recovery_budget, 0);
  });

  it('rejects negative values', () => {
    const result = PolicySchema.safeParse({ agents: { stall_recovery_budget: -1 } });
    assert.equal(result.success, false);
  });
});
