/**
 * story-059-005: Standalone dispatch and single-PR finalize on story-NNN.
 *
 * Verifies that after story-059-002 (standalone rows stored with PK=story-NNN):
 *  (1) Supervisor dispatch reads the standalone row by story-NNN directly and
 *      dispatches the worker with storyId='story-NNN' and branch='story/story-NNN'
 *      — no epic-NNN container, no derivation.
 *  (2) EpicFinalizer.finalize('story-NNN') opens a PR titled 'story-NNN: <title>'
 *      — uses epicId directly, no replace(/^epic-/, 'story-') derivation.
 *  (3) NFR-5: audit_log entries for both dispatch and finalize record command='story-NNN'.
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
import { Supervisor } from '../Supervisor.js';
import { EpicFinalizer } from '../EpicFinalizer.js';
import type { EpicFinalizerOptions } from '../EpicFinalizer.js';
import { MockWorkerRunner } from '../MockWorkerRunner.js';
import { IntegrationGate } from '../IntegrationGate.js';
import type { Story } from '../../types.js';

// ─── Git helpers ──────────────────────────────────────────────────────────────

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// ─── Seeding helpers ──────────────────────────────────────────────────────────

function standaloneStory(storyId: string): Story {
  return {
    id: storyId,
    title: `Story ${storyId}`,
    description: 'Implement the feature.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: [],
  };
}

/**
 * Seeds a standalone row with PK=storyId (the story-059-002 storage layout).
 * Writes the YAML file, sets yaml_path in the DB, then flips to 'approved'.
 */
function seedStandalone(storyId: string, title: string): void {
  const epicYaml = {
    epic_id: storyId,
    title,
    status: 'planned',
    priority: 'must-have',
    prd_ref: `.loom/planning/${storyId}/project-brief.md`,
    requirements: [],
    stories: [standaloneStory(storyId)],
  };
  const rel = `.loom/planning/${storyId}/epics/${storyId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(path.join(repo, '.loom'));
  const store = new EpicStore(db);
  // createStandalone stores the row with PK=storyId (story-059-002 contract).
  store.createStandalone(storyId, title);
  store.updatePaths(storyId, { yaml_path: rel });
  store.updateStatus(storyId, 'approved');
  resetDatabaseForTest();
}

/** A worker that commits so the finalizer has something to merge. */
function committingWorker(): MockWorkerRunner {
  return new MockWorkerRunner(async (a) => {
    execFileSync('git', ['commit', '--allow-empty', '-m', `${a.storyId}: work`], {
      cwd: a.worktreePath,
    });
    return { status: 'done' as const, commitCount: 1, summary: `built ${a.storyId}`, logTail: '' };
  });
}

/** Green integration gate — never spawns a real process. */
function greenGate(): IntegrationGate {
  return new IntegrationGate({
    testCommand: 'noop',
    runner: () => ({ exitCode: 0, output: 'ok', timedOut: false, durationMs: 1 }),
  });
}

function finalizerOpts(
  db: import('better-sqlite3').Database,
  over: Partial<EpicFinalizerOptions> = {}
): EpicFinalizerOptions {
  return {
    projectRoot: repo,
    db,
    allowedRemotes: ['https://example.com/**'],
    prStrategy: 'per-epic',
    gate: greenGate(),
    integrationGate: 'warn',
    pushBranch: () => ({ ok: true, output: 'pushed' }),
    openPr: ({ title }) => `https://example.com/pr?title=${encodeURIComponent(title)}`,
    ...over,
  };
}

// ─── Fixture lifecycle ────────────────────────────────────────────────────────

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-standalone-df-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
  // openDatabase() auto-creates the schema on first open — no loom init needed.
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

// ─── Suite 1: Standalone dispatch on story-NNN ───────────────────────────────

describe('standalone dispatch — story-NNN id used end-to-end (AC1)', () => {
  it('Supervisor dispatches worker with storyId=story-NNN and branch=story/story-NNN', async () => {
    seedStandalone('story-042', 'Standalone dispatch test');

    const dispatched: Array<{ storyId: string; branchName: string }> = [];
    const worker = new MockWorkerRunner(async (a) => {
      dispatched.push({ storyId: a.storyId, branchName: a.branchName });
      execFileSync('git', ['commit', '--allow-empty', '-m', `${a.storyId}: work`], {
        cwd: a.worktreePath,
      });
      return { status: 'done' as const, commitCount: 1, summary: 'done', logTail: '' };
    });

    const db = openDatabase(path.join(repo, '.loom'));
    await new Supervisor({ projectRoot: repo, db, worker, maxConcurrent: 1 }).run();

    assert.equal(dispatched.length, 1, 'exactly one story must have been dispatched');
    assert.equal(
      dispatched[0].storyId,
      'story-042',
      'dispatched storyId must be story-042, not epic-042'
    );
    assert.equal(
      dispatched[0].branchName,
      'story/story-042',
      'dispatch branch must be story/story-042, not story/epic-042'
    );
  });

  it('audit_log dispatch entry has command=story-NNN (NFR-5)', async () => {
    seedStandalone('story-043', 'Audit dispatch test');

    const db = openDatabase(path.join(repo, '.loom'));
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
    }).run();

    const auditLog = new AuditLog(db);
    const entry = auditLog.latestActionByCommand('story-043', ['dispatch']);
    assert.ok(entry, 'a dispatch audit entry with command=story-043 must exist');
    assert.equal(
      entry.command,
      'story-043',
      'dispatch audit command must be story-043, not epic-043'
    );
  });
});

// ─── Suite 2: Single-PR finalize on story-NNN ────────────────────────────────

describe('standalone finalize — story-NNN id in PR title, no derivation (AC2)', () => {
  it('EpicFinalizer opens PR titled story-NNN: <title> (not epic-NNN)', async () => {
    seedStandalone('story-044', 'Standalone finalize test');
    gitc(['remote', 'add', 'origin', 'https://example.com/acme/loom.git']);

    const prInputs: Array<{ title: string }> = [];
    const db = openDatabase(path.join(repo, '.loom'));
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          openPr: ({ title, branch }) => {
            prInputs.push({ title });
            return `https://example.com/pr?branch=${branch}`;
          },
        })
      ),
    }).run();

    assert.equal(prInputs.length, 1, 'exactly one PR must have been opened');
    assert.ok(
      prInputs[0].title.startsWith('story-044:'),
      `PR title must start with "story-044:", got: ${prInputs[0].title}`
    );
    assert.ok(
      !prInputs[0].title.includes('epic-044'),
      `PR title must NOT include "epic-044", got: ${prInputs[0].title}`
    );
  });

  it('local merge branch for standalone story-NNN is epic/story-NNN (no derivation)', async () => {
    seedStandalone('story-045', 'Branch name test');
    gitc(['remote', 'add', 'origin', 'https://example.com/acme/loom.git']);

    const db = openDatabase(path.join(repo, '.loom'));
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(finalizerOpts(db)),
    }).run();

    // EpicFinalizer creates the local merge branch epic/<epicId> before pushing.
    // For standalone story-045, epicBranch = 'epic/story-045' (no derivation).
    const branches = gitc(['branch', '--list', 'epic/story-045']);
    assert.ok(
      branches.trim().includes('epic/story-045'),
      `local branch epic/story-045 must exist after finalize, got: ${branches}`
    );
    const wrongBranch = gitc(['branch', '--list', 'epic/epic-045']);
    assert.ok(
      !wrongBranch.trim().includes('epic/epic-045'),
      'epic/epic-045 must NOT be created — that would indicate derivation'
    );
  });

  it('audit_log records command=story-NNN for epic_finalize entry (NFR-5)', async () => {
    seedStandalone('story-046', 'Audit finalize test');
    gitc(['remote', 'add', 'origin', 'https://example.com/acme/loom.git']);

    const db = openDatabase(path.join(repo, '.loom'));
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(finalizerOpts(db)),
    }).run();

    const epic = new EpicStore(db).get('story-046');
    assert.equal(epic?.status, 'done', 'standalone epic must reach done after finalize');

    const auditLog = new AuditLog(db);
    // EpicFinalizer writes action='epic_finalize' with command=epicId on success.
    const finalizeEntry = auditLog.latestActionByCommand('story-046', ['epic_finalize']);
    assert.ok(finalizeEntry, 'an epic_finalize audit entry with command=story-046 must exist (NFR-5)');
    assert.equal(
      finalizeEntry.command,
      'story-046',
      'epic_finalize audit command must be story-046, not epic-046'
    );
  });
});
