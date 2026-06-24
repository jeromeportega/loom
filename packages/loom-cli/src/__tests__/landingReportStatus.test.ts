/**
 * story-060-005: Integration tests for landing report surfacing in loom status + loom audit.
 *
 * Test plan cases:
 *  (blocked, AC1)     loom status shows blocked check + repo for a blocked attempt
 *  (rolled-back, AC2) loom status shows all repos reverted + originating failure cause
 *  (clean-retry, AC3) loom status makes "retry as new attempt" guidance unambiguous
 *  (audit)            cross_repo.* action types recorded via AuditLog.record appear in loom audit
 *  (no-new-channel)   status rendering derives from landing_attempts ledger, not a separate store
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase,
  LandingStore,
  AuditLog,
  CROSS_REPO_ACTIONS,
  prepareRepoState,
} from '@loom-ai/core';
import { runStatus } from '../commands/status.js';
import { runAudit } from '../commands/audit.js';

let repo: string;
let realRepo: string;
let loomHome: string;
let dbPath: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-landing-status-test-'));
  realRepo = fs.realpathSync(repo);
  loomHome = path.join(realRepo, 'loom-home');
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  // Set loom_home to a subdirectory within this test's temp dir so each test
  // has an isolated DB that prepareRepoState will use.
  fs.writeFileSync(
    path.join(repo, '.loom', 'policy.yaml'),
    `version: 1\nloom_home: ${loomHome}\n`,
  );
  // Pre-create the namespace dir and get the DB path that status will use.
  const paths = prepareRepoState(realRepo, { loom_home: loomHome });
  dbPath = paths.dbPath;
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function captureStatus(opts: { projectRoot?: string } = {}): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    runStatus({ projectRoot: opts.projectRoot ?? realRepo });
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

function captureAudit(opts: Parameters<typeof runAudit>[0] = {}): string {
  const lines: string[] = [];
  const logOrig = console.log;
  const errOrig = console.error;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    runAudit(opts);
  } finally {
    console.log = logOrig;
    console.error = errOrig;
  }
  return lines.join('\n');
}

function seedEpic(epicId: string, title = 'Test Epic'): void {
  const db = createDatabase(dbPath);
  try {
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES (?, ?, 'planned')").run(epicId, title);
  } finally {
    db.close();
  }
}

function makeStage(repoSlug: string, dependsOn: string[] = []) {
  return {
    repoSlug,
    repoRoot: '/tmp/fake',
    storyIds: [] as string[],
    dependsOnRepos: dependsOn,
    status: 'pending' as const,
    prUrl: `https://github.com/org/${repoSlug}/pull/1`,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('loom status — blocked landing attempt (AC1)', () => {
  it('surfaces the blocked check and repo in status output', () => {
    seedEpic('epic-001');
    const db = createDatabase(dbPath);
    try {
      const store = new LandingStore(db, () => 'sha0');
      const attemptId = store.beginAttempt('epic-001', [makeStage('api-service'), makeStage('frontend')]);
      const blocker = { repoSlug: 'api-service', check: 'pr_open' as const, reason: 'PR not open' };
      store.setStatus(attemptId, 'blocked', blocker);
    } finally {
      db.close();
    }

    const out = captureStatus();
    assert.ok(out.includes('blocked'), `Expected 'blocked' in output:\n${out}`);
    assert.ok(out.includes('api-service'), `Expected blocking repo 'api-service' in output:\n${out}`);
    assert.ok(out.includes('pr_open'), `Expected check name 'pr_open' in output:\n${out}`);
    assert.ok(out.includes('PR not open'), `Expected failure reason in output:\n${out}`);
  });

  it('ADR-006: output includes guidance to retry as a new landing attempt', () => {
    seedEpic('epic-002');
    const db = createDatabase(dbPath);
    try {
      const store = new LandingStore(db, () => 'sha0');
      const attemptId = store.beginAttempt('epic-002', [makeStage('svc-a')]);
      store.setStatus(attemptId, 'blocked', {
        repoSlug: 'svc-a',
        check: 'integration_gate',
        reason: 'gate red',
      });
    } finally {
      db.close();
    }

    const out = captureStatus();
    // Must make "retry as new attempt" unambiguous (ADR-006)
    assert.ok(
      out.toLowerCase().includes('new') || out.toLowerCase().includes('retry'),
      `Expected retry guidance in output:\n${out}`
    );
    // Must clarify that reverted PRs do NOT reopen (exact text or equivalent)
    // The output may say "reverted PRs do not reopen" — that is correct and intentional.
    assert.ok(
      out.toLowerCase().includes('do not reopen') || out.toLowerCase().includes('not reopen'),
      `Expected explicit "do not reopen" statement in output:\n${out}`
    );
  });
});

describe('loom status — rolled_back landing attempt (AC2)', () => {
  it('surfaces all repos reverted and originating failure cause', () => {
    seedEpic('epic-003');
    const db = createDatabase(dbPath);
    try {
      const store = new LandingStore(db, () => 'sha0');
      const attemptId = store.beginAttempt('epic-003', [makeStage('svc-a'), makeStage('svc-b', ['svc-a'])]);
      store.recordMerge(attemptId, { repoSlug: 'svc-a', prNumber: 1, prUrl: 'https://github.com/org/svc-a/pull/1', mergeCommitSha: 'sha-a' });
      store.recordMerge(attemptId, { repoSlug: 'svc-b', prNumber: 2, prUrl: 'https://github.com/org/svc-b/pull/2', mergeCommitSha: 'sha-b' });
      store.markRevertPending(attemptId, 'svc-b', 'https://github.com/org/svc-b/pull/99');
      store.markReverted(attemptId, 'svc-b', 'sha-b-rev');
      store.markRevertPending(attemptId, 'svc-a', 'https://github.com/org/svc-a/pull/98');
      store.markReverted(attemptId, 'svc-a', 'sha-a-rev');
      store.setStatus(attemptId, 'rolled_back', {
        repoSlug: 'svc-b',
        check: 'integration_gate',
        reason: 'tests failed after merge',
      });
    } finally {
      db.close();
    }

    const out = captureStatus();
    assert.ok(out.includes('rolled_back'), `Expected 'rolled_back' in output:\n${out}`);
    // AC2: surfaces originating failure cause
    assert.ok(out.includes('svc-b'), `Expected failing repo 'svc-b' in output:\n${out}`);
    assert.ok(out.includes('integration_gate'), `Expected check name 'integration_gate' in output:\n${out}`);
    // AC2: confirms repos restored
    assert.ok(out.includes('reverted'), `Expected repos in reverted state in output:\n${out}`);
    assert.ok(
      out.includes('pre-landing') || out.includes('clean state'),
      `Expected clean state confirmation in output:\n${out}`
    );
  });

  it('ADR-006: rolled_back output makes "retry as new attempt" unambiguous', () => {
    seedEpic('epic-004');
    const db = createDatabase(dbPath);
    try {
      const store = new LandingStore(db, () => 'sha0');
      const attemptId = store.beginAttempt('epic-004', [makeStage('svc-x')]);
      store.recordMerge(attemptId, { repoSlug: 'svc-x', prNumber: 3, prUrl: 'https://github.com/org/svc-x/pull/3', mergeCommitSha: 'sha-x' });
      store.markRevertPending(attemptId, 'svc-x', 'https://github.com/org/svc-x/pull/100');
      store.markReverted(attemptId, 'svc-x', 'sha-x-rev');
      store.setStatus(attemptId, 'rolled_back', {
        repoSlug: 'svc-x',
        check: 'consumer_gate',
        reason: 'consumer broke',
      });
    } finally {
      db.close();
    }

    const out = captureStatus();
    // Must make "retry as new attempt with new PRs" clear (ADR-006)
    assert.ok(
      out.includes('new PRs') || (out.includes('new') && out.includes('attempt')),
      `Expected new-attempt retry guidance in output:\n${out}`
    );
    // The output must clarify reverted PRs do not reopen
    assert.ok(
      out.toLowerCase().includes('do not reopen') || out.toLowerCase().includes('not reopen'),
      `Expected explicit "do not reopen" statement in output:\n${out}`
    );
  });
});

describe('loom audit — cross_repo.* entries appear in output', () => {
  it('cross_repo.blocked and cross_repo.staged written via AuditLog.record appear in loom audit', () => {
    // Write both action types to the same DB so they appear in one audit call.
    const db = createDatabase(dbPath);
    const audit = new AuditLog(db);
    audit.record({
      action: CROSS_REPO_ACTIONS.BLOCKED,
      command: 'epic-005',
      allowed: false,
      detail: {
        attemptId: 'landing-epic-005-0',
        blocker: { repoSlug: 'api', check: 'pr_open', reason: 'PR closed' },
      },
    });
    audit.record({
      action: CROSS_REPO_ACTIONS.STAGED,
      command: 'epic-006',
      allowed: true,
      detail: { attemptId: 'landing-epic-006-0' },
    });
    db.close();

    const out = captureAudit({ limit: 10, projectRoot: realRepo });
    assert.ok(
      out.includes(CROSS_REPO_ACTIONS.BLOCKED),
      `Expected '${CROSS_REPO_ACTIONS.BLOCKED}' in audit output:\n${out}`
    );
    assert.ok(
      out.includes(CROSS_REPO_ACTIONS.STAGED),
      `Expected '${CROSS_REPO_ACTIONS.STAGED}' in audit output:\n${out}`
    );
  });
});

describe('loom status — no landing attempt (no crash)', () => {
  it('renders normally when no landing attempts exist for an epic', () => {
    seedEpic('epic-007');
    assert.doesNotThrow(() => captureStatus());
  });
});
