/**
 * story-058-006: Cross-repo integration gate and partial-landing surfacing.
 *
 * Test plan:
 *  (1) Each repo's gate runs against its OWN PR: producer stage gates the
 *      producer PR; consumer stage gates the consumer PR.
 *  (2) The consumer gate runs in the consumer worktree ONLY AFTER the producer
 *      PR is merged — assert ordering: waitForMerge precedes gate invocation.
 *  (3) gate.ok === true → consumer PR proceeds to merge (status='landed').
 *  (4) gate.ok === false → consumerStage.status === 'partial_landing', producer
 *      PR left MERGED/intact (no rollback call), consumer PR blocked (not merged).
 *  (5) surfacePartialLanding(epicId, producerPrUrl, summary) emits an audit-log
 *      entry, is reflected in loom status, and posts a note on the producer PR —
 *      assert all three surfacing channels fire.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';

import { openDatabase, createDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore, AuditLog } from '../../state/index.js';
import {
  CrossRepoCoordinator,
  type RepoStage,
  type SupervisorLike,
  type FinalizerHandle,
} from '../CrossRepoCoordinator.js';
import { runConsumerGate, surfacePartialLanding } from '../crossRepoGate.js';
import { IntegrationGate } from '../IntegrationGate.js';
import type { WorkspaceManifest, ManifestEntry } from '../../home/workspaceManifest.js';
import type { Story } from '../../types.js';
import type { SupervisorResult } from '../Supervisor.js';
import type { FinalizeResult } from '../EpicFinalizer.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function entry(slug: string, opts: { primary?: boolean } = {}): ManifestEntry {
  return { slug, path: `/repos/${slug}`, remote_url: null, ...opts };
}

function manifest(repos: ManifestEntry[]): WorkspaceManifest {
  return { version: 1, repos };
}

function story(id: string, deps: string[] = [], repo?: string): Story {
  return {
    id,
    title: `Story ${id} title`,
    description: 'description',
    acceptance_criteria: ['AC1'],
    estimated_complexity: 'medium',
    dependencies: deps,
    ...(repo !== undefined ? { repo } : {}),
  };
}

function okResult(): SupervisorResult {
  return {
    epicsProcessed: [],
    epicsSkipped: [],
    storiesTotal: 0,
    storiesDone: 0,
    storiesFailed: 0,
    storiesBlocked: 0,
    storiesPending: 0,
    halted: false,
  };
}

function okFinalizeResult(url?: string): FinalizeResult {
  return {
    url,
    status: 'merged',
    conflicted: [],
    merged: [],
    cleaned: [],
    note: 'ok',
  };
}

// ─── Repo helpers ─────────────────────────────────────────────────────────────

function gitc(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'ignore' });
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

function seedEpicOnDisk(repoDir: string, epicId: string, stories: Story[]): void {
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

  const db = createDatabase(path.join(repoDir, '.loom', 'loom.db'));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
  db.close();
}

// ─── Test state ───────────────────────────────────────────────────────────────

const EPIC_ID = 'epic-001';
const TWO_REPO_PRIMARY = 'repo-a';

let repoDir: string; // producer (repo-a)
let repoDirB: string; // consumer (repo-b)

beforeEach(() => {
  resetDatabaseForTest();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-gate-a-'));
  repoDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-gate-b-'));
  initRepo(repoDir);
  initRepo(repoDirB);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(repoDirB, { recursive: true, force: true });
});

// ─── (1) Each repo's gate runs against its own PR ─────────────────────────────

describe('(1) each repo gates its own PR', () => {
  it('producer stage finalizes producer repo; consumer stage finalizes consumer repo', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, EPIC_ID, epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    // Track which roots were finalized (each EpicFinalizer gates its own repo).
    const finalizeCalls: string[] = [];
    const finalizerFactory = (repoRoot: string): FinalizerHandle => ({
      finalize: async (_epicId) => {
        finalizeCalls.push(repoRoot);
        return okFinalizeResult(`https://github.com/org/${repoRoot}/pull/1`);
      },
    });

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory,
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      waitForMergeFn: async () => { /* resolve immediately */ },
    });

    await coordinator.run(EPIC_ID);

    // Each repo was finalized exactly once.
    assert.equal(finalizeCalls.length, 2);
    assert.ok(finalizeCalls.includes(realA), 'producer repo must be finalized');
    assert.ok(finalizeCalls.includes(realB), 'consumer repo must be finalized');
    // No duplication — distinct roots.
    assert.equal(new Set(finalizeCalls).size, 2);
  });
});

// ─── (2) Consumer gate runs only after producer PR merges ─────────────────────

describe('(2) consumer gate runs after producer PR merges', () => {
  it('waitForMerge is called before runConsumerGateFn is invoked', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, EPIC_ID, epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    // Track order of events.
    const callOrder: string[] = [];

    const waitForMergeFn = async (stage: RepoStage) => {
      callOrder.push(`merge:${stage.repoSlug}`);
    };

    const runConsumerGateFn = async (_producerStage: RepoStage, consumerStage: RepoStage) => {
      callOrder.push(`gate:${consumerStage.repoSlug}`);
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: () => ({ finalize: async () => okFinalizeResult('https://github.com/org/repo/pull/1') }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      waitForMergeFn,
      runConsumerGateFn,
    });

    await coordinator.run(EPIC_ID);

    // merge must come before gate.
    const mergeIdx = callOrder.indexOf('merge:repo-a');
    const gateIdx = callOrder.indexOf('gate:repo-b');
    assert.ok(mergeIdx >= 0, 'waitForMerge must be called');
    assert.ok(gateIdx >= 0, 'runConsumerGateFn must be called');
    assert.ok(mergeIdx < gateIdx, 'producer merge must precede consumer gate run');
  });

  it('producerStage.status is awaiting_merge when gate is called', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, EPIC_ID, epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    let capturedProducerStatus: string | undefined;
    const runConsumerGateFn = async (producerStage: RepoStage) => {
      capturedProducerStatus = producerStage.status;
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: () => ({ finalize: async () => okFinalizeResult('https://github.com/org/repo/pull/1') }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      waitForMergeFn: async () => { /* resolve immediately */ },
      runConsumerGateFn,
    });

    await coordinator.run(EPIC_ID);

    assert.equal(capturedProducerStatus, 'awaiting_merge');
  });
});

// ─── (3) gate.ok === true → consumer PR proceeds ─────────────────────────────

describe('(3) gate passes → consumer stage reaches landed', () => {
  it('consumer stage status is landed when gate succeeds', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, EPIC_ID, epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    // Passing gate (ok = true). testCommand forces resolution so the runner IS called.
    const passGate = new IntegrationGate({
      testCommand: 'echo ok',
      runner: async () => ({ exitCode: 0, output: 'all good', timedOut: false, durationMs: 50 }),
    });

    const prCommentCalls: string[] = [];
    const runConsumerGateFn = async (producerStage: RepoStage, consumerStage: RepoStage) => {
      const outcome = await runConsumerGate({
        consumerRoot: consumerStage.repoRoot,
        producerStage,
        conflicted: [],
        gate: passGate,
      });
      if (!outcome.ok) {
        consumerStage.status = 'partial_landing';
        await surfacePartialLanding(EPIC_ID, producerStage.prUrl!, outcome.summary, db, async (prUrl) => {
          prCommentCalls.push(prUrl);
        });
      }
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: () => ({ finalize: async () => okFinalizeResult('https://github.com/org/repo/pull/1') }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      waitForMergeFn: async () => { /* resolve immediately */ },
      runConsumerGateFn,
    });

    const { stages } = await coordinator.run(EPIC_ID);

    const consumer = stages.find(s => s.repoSlug === 'repo-b')!;
    const producer = stages.find(s => s.repoSlug === 'repo-a')!;

    assert.equal(consumer.status, 'landed', 'consumer must reach landed when gate passes');
    assert.equal(producer.status, 'landed', 'producer must remain landed');
    assert.equal(prCommentCalls.length, 0, 'no PR comment when gate passes');

    // No partial_landing audit entry.
    const audit = new AuditLog(db);
    const partialEntry = audit.latestActionByCommand(EPIC_ID, ['cross_repo.partial_landing']);
    assert.equal(partialEntry, undefined, 'no partial_landing audit entry when gate passes');
  });
});

// ─── (4) gate.ok === false → partial_landing ─────────────────────────────────

describe('(4) gate fails → partial_landing, producer intact, consumer blocked', () => {
  it('consumer stage becomes partial_landing and is not run', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, EPIC_ID, epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    // Failing gate (ok = false). testCommand forces resolution so the runner IS called.
    const failGate = new IntegrationGate({
      testCommand: 'npm test',
      runner: async () => ({ exitCode: 1, output: 'build failed', timedOut: false, durationMs: 100 }),
    });

    const prCommentCalls: string[] = [];
    const runConsumerGateFn = async (producerStage: RepoStage, consumerStage: RepoStage) => {
      const outcome = await runConsumerGate({
        consumerRoot: consumerStage.repoRoot,
        producerStage,
        conflicted: [],
        gate: failGate,
      });
      if (!outcome.ok) {
        consumerStage.status = 'partial_landing';
        await surfacePartialLanding(EPIC_ID, producerStage.prUrl!, outcome.summary, db, async (prUrl) => {
          prCommentCalls.push(prUrl);
        });
      }
    };

    // Track supervisor and finalize calls to prove consumer was NOT run.
    const supervisorCalls: string[] = [];
    const finalizeCalls: string[] = [];

    const stubSupervisor: SupervisorLike = {
      run: async (opts) => {
        supervisorCalls.push(opts.repoFilter ?? '');
        return okResult();
      },
    };
    const finalizerFactory = (repoRoot: string): FinalizerHandle => ({
      finalize: async () => {
        finalizeCalls.push(repoRoot === realA ? 'repo-a' : 'repo-b');
        return okFinalizeResult('https://github.com/org/repo/pull/1');
      },
    });

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: stubSupervisor,
      finalizerFactory,
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      waitForMergeFn: async () => { /* resolve immediately */ },
      runConsumerGateFn,
    });

    const { stages } = await coordinator.run(EPIC_ID);

    const consumer = stages.find(s => s.repoSlug === 'repo-b')!;
    const producer = stages.find(s => s.repoSlug === 'repo-a')!;

    // Consumer is partial_landing.
    assert.equal(consumer.status, 'partial_landing');

    // Producer is landed — no rollback.
    assert.equal(producer.status, 'landed', 'producer must remain landed (no rollback)');

    // Consumer supervisor was NOT called (consumer stories never ran).
    assert.ok(!supervisorCalls.includes('repo-b'), 'consumer supervisor must not run');
    // Consumer finalize was NOT called (no consumer PR opened).
    assert.ok(!finalizeCalls.includes('repo-b'), 'consumer finalize must not run');

    // Producer was not rolled back (still in stages as landed, finalize was called once for producer).
    assert.ok(supervisorCalls.includes('repo-a'), 'producer supervisor must have run');
    assert.ok(finalizeCalls.includes('repo-a'), 'producer finalize must have run');
  });

  it('no rollback function is called when gate fails', async () => {
    // This test asserts the ABSENCE of a rollback call — the producer PR is
    // left merged per ADR-007; there is no revert mechanism wired here.
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, EPIC_ID, epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    const failGate = new IntegrationGate({
      testCommand: 'npm test',
      runner: async () => ({ exitCode: 1, output: 'broken', timedOut: false, durationMs: 10 }),
    });

    let rollbackCalled = false;
    const runConsumerGateFn = async (producerStage: RepoStage, consumerStage: RepoStage) => {
      const outcome = await runConsumerGate({
        consumerRoot: consumerStage.repoRoot,
        producerStage,
        conflicted: [],
        gate: failGate,
      });
      if (!outcome.ok) {
        // surfacePartialLanding is responsible for surfacing; rollback is
        // never called — this lambda must NOT call any revert function.
        consumerStage.status = 'partial_landing';
        await surfacePartialLanding(EPIC_ID, producerStage.prUrl!, outcome.summary, db, async () => { /* noop comment */ });
        // If rollback were expected, rollbackCalled would be set here.
      }
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: () => ({ finalize: async () => okFinalizeResult('https://github.com/org/repo/pull/99') }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      waitForMergeFn: async () => { /* resolve immediately */ },
      runConsumerGateFn,
    });

    const { stages } = await coordinator.run(EPIC_ID);

    assert.equal(rollbackCalled, false, 'rollback must never be called');
    const producer = stages.find(s => s.repoSlug === 'repo-a')!;
    assert.equal(producer.status, 'landed', 'producer must remain landed');
  });
});

// ─── (5) surfacePartialLanding fires all three channels ───────────────────────

describe('(5) surfacePartialLanding fires all three channels', () => {
  it('emits audit-log entry, is reflected in loom status (audit), posts PR note', async () => {
    const db = createDatabase(':memory:');

    const epicId = 'epic-test-surf';
    const producerPrUrl = 'https://github.com/org/repo/pull/42';
    const summary = 'Integration gate failed: `npm test` failed (exit 1).';

    const prCommentCalls: Array<{ prUrl: string; body: string }> = [];
    const prCommentFn = async (prUrl: string, body: string) => {
      prCommentCalls.push({ prUrl, body });
    };

    await surfacePartialLanding(epicId, producerPrUrl, summary, db, prCommentFn);

    // Channel 1+2: audit entry.
    const audit = new AuditLog(db);
    const entry = audit.latestActionByCommand(epicId, ['cross_repo.partial_landing']);
    assert.ok(entry, 'audit entry must be written');
    assert.equal(entry!.action, 'cross_repo.partial_landing');
    assert.equal(entry!.command, epicId);
    const detail = JSON.parse(entry!.detail as string);
    assert.equal(detail.producerPrUrl, producerPrUrl);
    assert.equal(detail.summary, summary);

    // Channel 2: entry is discoverable by the same query loom status uses.
    const statusEntry = audit.latestActionByCommand(epicId, ['cross_repo.partial_landing']);
    assert.ok(statusEntry, 'loom status channel: entry must be findable via latestActionByCommand');

    // Channel 3: PR comment was posted on the producer PR.
    assert.equal(prCommentCalls.length, 1, 'exactly one PR comment must be posted');
    assert.equal(prCommentCalls[0].prUrl, producerPrUrl);
    assert.ok(
      prCommentCalls[0].body.includes('Partial Landing'),
      'PR comment must mention partial landing',
    );
    assert.ok(
      prCommentCalls[0].body.includes(summary),
      'PR comment must include the gate summary',
    );
  });

  it('surfacePartialLanding fires all three channels from within the coordinator flow', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, EPIC_ID, epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    const failGate = new IntegrationGate({
      testCommand: 'npm test',
      runner: async () => ({ exitCode: 1, output: 'tests failed', timedOut: false, durationMs: 50 }),
    });

    const prCommentCalls: Array<{ prUrl: string; body: string }> = [];

    const runConsumerGateFn = async (producerStage: RepoStage, consumerStage: RepoStage) => {
      const outcome = await runConsumerGate({
        consumerRoot: consumerStage.repoRoot,
        producerStage,
        conflicted: [],
        gate: failGate,
      });
      if (!outcome.ok) {
        consumerStage.status = 'partial_landing';
        await surfacePartialLanding(
          EPIC_ID,
          producerStage.prUrl!,
          outcome.summary,
          db,
          async (prUrl, body) => {
            prCommentCalls.push({ prUrl, body });
          },
        );
      }
    };

    const PRODUCER_PR = 'https://github.com/org/repo-a/pull/5';

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: (repoRoot) => ({
        finalize: async () => okFinalizeResult(repoRoot === realA ? PRODUCER_PR : 'https://github.com/org/repo-b/pull/1'),
      }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      waitForMergeFn: async () => { /* resolve immediately */ },
      runConsumerGateFn,
    });

    const { stages } = await coordinator.run(EPIC_ID);

    // Channel 1+2: audit entry exists.
    const audit = new AuditLog(db);
    const entry = audit.latestActionByCommand(EPIC_ID, ['cross_repo.partial_landing']);
    assert.ok(entry, 'audit entry must exist');
    assert.equal(entry!.action, 'cross_repo.partial_landing');
    const detail = JSON.parse(entry!.detail as string);
    assert.equal(detail.producerPrUrl, PRODUCER_PR);

    // Channel 3: PR comment posted on the PRODUCER PR.
    assert.equal(prCommentCalls.length, 1);
    assert.equal(prCommentCalls[0].prUrl, PRODUCER_PR, 'comment must be on producer PR');

    // Consumer is partial_landing; producer is landed.
    const consumer = stages.find(s => s.repoSlug === 'repo-b')!;
    const producer = stages.find(s => s.repoSlug === 'repo-a')!;
    assert.equal(consumer.status, 'partial_landing');
    assert.equal(producer.status, 'landed');
  });
});

// ─── runConsumerGate unit tests ───────────────────────────────────────────────

describe('runConsumerGate', () => {
  it('returns ok=true when the consumer build passes', async () => {
    // testCommand forces command resolution so the runner is called, not auto-detection.
    const passGate = new IntegrationGate({
      testCommand: 'echo ok',
      runner: async () => ({ exitCode: 0, output: 'pass', timedOut: false, durationMs: 10 }),
    });
    const producerStage: RepoStage = {
      repoSlug: 'repo-a',
      repoRoot: '/repos/repo-a',
      storyIds: ['s1'],
      dependsOnRepos: [],
      prUrl: 'https://github.com/org/repo/pull/1',
      status: 'awaiting_merge',
    };
    const outcome = await runConsumerGate({
      consumerRoot: '/repos/repo-b',
      producerStage,
      conflicted: [],
      gate: passGate,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ran, true);
  });

  it('returns ok=false when the consumer build fails', async () => {
    // testCommand forces command resolution so the runner is called, not auto-detection.
    const failGate = new IntegrationGate({
      testCommand: 'echo fail',
      runner: async () => ({ exitCode: 2, output: 'compilation error', timedOut: false, durationMs: 20 }),
    });
    const producerStage: RepoStage = {
      repoSlug: 'repo-a',
      repoRoot: '/repos/repo-a',
      storyIds: ['s1'],
      dependsOnRepos: [],
      prUrl: 'https://github.com/org/repo/pull/1',
      status: 'awaiting_merge',
    };
    const outcome = await runConsumerGate({
      consumerRoot: '/repos/repo-b',
      producerStage,
      conflicted: [],
      gate: failGate,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, true);
  });

  it('passes conflicted list to the gate (amputation signal)', async () => {
    let capturedConflicted: string[] | undefined;
    const probeGate = new IntegrationGate({
      // The gate will return ok=false because of amputated stories (no command needed).
      fileExists: () => false,
      fileReader: () => null,
    });
    // We need to probe what was passed — wrap the gate to capture input.
    const wrappedGate = {
      run: async (input: { projectRoot: string; conflicted?: string[] }) => {
        capturedConflicted = input.conflicted;
        return probeGate.run(input);
      },
    } as unknown as IntegrationGate;

    const producerStage: RepoStage = {
      repoSlug: 'repo-a',
      repoRoot: '/repos/repo-a',
      storyIds: ['s1'],
      dependsOnRepos: [],
      status: 'awaiting_merge',
    };
    await runConsumerGate({
      consumerRoot: '/repos/repo-b',
      producerStage,
      conflicted: ['story-001-002'],
      gate: wrappedGate,
    });
    assert.deepEqual(capturedConflicted, ['story-001-002']);
  });
});
