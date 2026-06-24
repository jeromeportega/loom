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
import { runConsumerGate, surfacePartialLanding, type GateRunner } from '../crossRepoGate.js';
import { IntegrationGate } from '../IntegrationGate.js';
import type { WorkspaceManifest } from '../../home/workspaceManifest.js';
import type { Story } from '../../types.js';
import type { SupervisorResult } from '../Supervisor.js';
import type { FinalizeResult } from '../EpicFinalizer.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

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

// ─── (2) STAGE phase: all repos stage before any merge (story-060-001) ────────
// The old "consumer gate runs after producer PR merges" suite tested the
// sequential STAGE=MERGE flow. Story-060-001 restructures the coordinator into
// an explicit STAGE→MERGE phasing: all repos stage (open PRs) first, then
// merge only when allReady. These tests verify the new phasing.

describe('(2) STAGE phase: all repos open PRs before any merge', () => {
  it('both repos are staged (finalized) before mergeRepo is called for either', async () => {
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

    const callOrder: string[] = [];

    const finalizerFactory = (repoRoot: string): FinalizerHandle => ({
      finalize: async () => {
        callOrder.push(`stage:${repoRoot === realA ? 'repo-a' : 'repo-b'}`);
        return okFinalizeResult('https://github.com/org/repo/pull/1');
      },
    });

    const mergeRepo = async (stage: RepoStage) => {
      callOrder.push(`merge:${stage.repoSlug}`);
      return {
        attemptId: 'a', repoSlug: stage.repoSlug, dependsOn: stage.dependsOnRepos,
        prNumber: 1, prUrl: null, mergeCommitSha: 'sha', mergeState: 'merged' as const,
        revertPrUrl: null, revertMergeSha: null, mergedAt: null, revertedAt: null,
      };
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory,
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      mergeRepo,
    });

    await coordinator.run(EPIC_ID);

    // All staging must come before any merge.
    const firstMergeIdx = callOrder.findIndex(e => e.startsWith('merge:'));
    const lastStageIdx = callOrder.reduce((acc, e, i) => e.startsWith('stage:') ? i : acc, -1);
    assert.ok(lastStageIdx >= 0, 'both repos must be staged');
    assert.ok(firstMergeIdx >= 0, 'mergeRepo must be called after staging');
    assert.ok(lastStageIdx < firstMergeIdx,
      'all staging must complete before any merge (STAGE before MERGE)');
  });

  it('stage statuses go finalizing→landed (no awaiting_merge in new design)', async () => {
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

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: () => ({
        finalize: async () => okFinalizeResult('https://github.com/org/repo/pull/1'),
      }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
    });

    const { stages } = await coordinator.run(EPIC_ID);

    // Both stages reach 'landed' via the new STAGE→MERGE path.
    for (const stage of stages) {
      assert.equal(stage.status, 'landed',
        `${stage.repoSlug} must reach landed in the new STAGE→MERGE design`);
    }
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

// ─── (4) gate fails → all-or-none blocked (story-060-001 STAGE→MERGE) ────────
// story-060-001 changed partial_landing semantics: when any repo's gate fails,
// NO repo merges (AC2). Both PRs are open (STAGE completed), but the MERGE phase
// is skipped. All stages end as partial_landing.

describe('(4) gate fails → all-or-none blocked, no repo merges (AC2)', () => {
  it('both stages become partial_landing when consumer stageForLanding fails to open PR (AC2)', async () => {
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

    // Both repos stage successfully (PRs open). But because the coordinator's
    // assessLandingReadiness uses the default IntegrationGate with no test command
    // detected, the gate is ok=true (no-command fallback = passes). Both land.
    // To test blocked path: consumer PR does NOT open (stageForLanding returns no url).
    const supervisorCalls: string[] = [];
    const finalizeCalls: string[] = [];

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: {
        run: async (opts) => {
          supervisorCalls.push(opts.repoFilter ?? '');
          return okResult();
        },
      },
      finalizerFactory: (repoRoot: string): FinalizerHandle => ({
        finalize: async () => {
          const slug = repoRoot === realA ? 'repo-a' : 'repo-b';
          finalizeCalls.push(slug);
          // Consumer (repo-b) stageForLanding doesn't return a prUrl → prOpen:false → blocked.
          if (repoRoot === realB) {
            return { url: undefined, status: 'gated', conflicted: [], merged: [], cleaned: [], note: 'gated' };
          }
          return okFinalizeResult('https://github.com/org/repo-a/pull/1');
        },
      }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
    });

    const mergeRepoCalled: string[] = [];
    // Inject a mergeRepo spy — it should NOT be called.
    const coordinatorWithSpy = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: {
        run: async (opts) => {
          supervisorCalls.push(opts.repoFilter ?? '');
          return okResult();
        },
      },
      finalizerFactory: (repoRoot: string): FinalizerHandle => ({
        finalize: async () => {
          const slug = repoRoot === realA ? 'repo-a' : 'repo-b';
          finalizeCalls.push(slug);
          if (repoRoot === realB) {
            return { url: undefined, status: 'gated', conflicted: [], merged: [], cleaned: [], note: 'gated' };
          }
          return okFinalizeResult('https://github.com/org/repo-a/pull/1');
        },
      }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
      mergeRepo: async (stage) => {
        mergeRepoCalled.push(stage.repoSlug);
        return {
          attemptId: 'a', repoSlug: stage.repoSlug, dependsOn: stage.dependsOnRepos,
          prNumber: 1, prUrl: null, mergeCommitSha: 'sha', mergeState: 'merged' as const,
          revertPrUrl: null, revertMergeSha: null, mergedAt: null, revertedAt: null,
        };
      },
    });

    const { stages } = await coordinatorWithSpy.run(EPIC_ID);

    const consumer = stages.find(s => s.repoSlug === 'repo-b')!;
    const producer = stages.find(s => s.repoSlug === 'repo-a')!;

    // All stages are partial_landing (AC2: neither repo merges).
    assert.equal(consumer.status, 'partial_landing', 'consumer must be partial_landing');
    assert.equal(producer.status, 'partial_landing', 'producer must also be partial_landing (nothing merged)');

    // mergeRepo must NEVER be called when not allReady (AC2).
    assert.equal(mergeRepoCalled.length, 0, 'mergeRepo must not be called when gate fails (AC2)');

    // Both supervisor + finalize DID run (STAGE phase is complete; MERGE is blocked).
    assert.ok(supervisorCalls.includes('repo-a'), 'producer supervisor must run in STAGE');
    assert.ok(supervisorCalls.includes('repo-b'), 'consumer supervisor must run in STAGE');
    assert.ok(finalizeCalls.includes('repo-a'), 'producer finalize must run in STAGE');
    assert.ok(finalizeCalls.includes('repo-b'), 'consumer finalize must run in STAGE');
  });

  it('3-repo chain: all stages partial_landing when any gate fails (no topo-sort throw)', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);
    const repoDirC = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-gate-c-'));
    initRepo(repoDirC);
    const realC = fs.realpathSync(repoDirC);

    try {
      const epicStories = [
        story('story-001-001', [], 'repo-a'),
        story('story-001-002', ['story-001-001'], 'repo-b'),
        story('story-001-003', ['story-001-002'], 'repo-c'),
      ];
      seedEpicOnDisk(repoDir, EPIC_ID, epicStories);
      const db = openDatabase(path.join(repoDir, '.loom'));

      const mf: WorkspaceManifest = {
        version: 1,
        repos: [
          { slug: 'repo-a', path: realA, remote_url: null, primary: true },
          { slug: 'repo-b', path: realB, remote_url: null },
          { slug: 'repo-c', path: realC, remote_url: null },
        ],
      };

      // B fails to open its PR (gated) → allReady:false → all blocked.
      const coordinator = new CrossRepoCoordinator({
        projectRoot: repoDir,
        supervisor: { run: async () => okResult() },
        finalizerFactory: (repoRoot: string): FinalizerHandle => ({
          finalize: async () => {
            if (repoRoot === realB) {
              return { url: undefined, status: 'gated', conflicted: [], merged: [], cleaned: [], note: 'b gated' };
            }
            return okFinalizeResult('https://github.com/org/repo/pull/1');
          },
        }),
        db,
        manifest: mf,
        primarySlug: 'repo-a',
      });

      // Must NOT throw "topo-sort invariant violated" for stage C.
      const { stages } = await coordinator.run(EPIC_ID);

      const stageA = stages.find(s => s.repoSlug === 'repo-a')!;
      const stageB = stages.find(s => s.repoSlug === 'repo-b')!;
      const stageC = stages.find(s => s.repoSlug === 'repo-c')!;

      // In the new all-or-none design, ALL repos are partial_landing when any is blocked.
      assert.equal(stageA.status, 'partial_landing', 'A must be partial_landing (all-or-none)');
      assert.equal(stageB.status, 'partial_landing', 'B (gated) must be partial_landing');
      assert.equal(stageC.status, 'partial_landing', 'C must be partial_landing (all-or-none)');
    } finally {
      fs.rmSync(repoDirC, { recursive: true, force: true });
    }
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

    // Channel 1: audit entry exists and carries the expected payload.
    const audit = new AuditLog(db);
    const entry = audit.latestActionByCommand(epicId, ['cross_repo.partial_landing']);
    assert.ok(entry, 'audit entry must be written');
    assert.equal(entry!.action, 'cross_repo.partial_landing');
    assert.equal(entry!.command, epicId);
    const detail = JSON.parse(entry!.detail as string);
    assert.equal(detail.producerPrUrl, producerPrUrl);
    assert.equal(detail.summary, summary);

    // Channel 2 (loom status): the audit query loom status uses returns the entry.
    // `latestActionByCommand` is the exact query path the status command calls;
    // the entry verified above is the same one that will appear in `loom status`.

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

  it('coordinator blocked state: both stages partial_landing and prUrl set when gate fails', async () => {
    // story-060-001: surfacePartialLanding is no longer called from within the
    // coordinator flow (the old sequential design called it via runConsumerGateFn).
    // Instead, both PRs are open (STAGE completed), all stages are partial_landing
    // (MERGE blocked), and the blocker is recorded in assessLandingReadiness.
    // This test verifies the new coordinator blocked state is observable.
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

    const PRODUCER_PR = 'https://github.com/org/repo-a/pull/5';
    const CONSUMER_PR = 'https://github.com/org/repo-b/pull/6';

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: (repoRoot) => ({
        finalize: async () => {
          // Consumer PR fails to open (gated).
          if (repoRoot === realB) {
            return { url: undefined, status: 'gated', conflicted: [], merged: [], cleaned: [], note: 'gated' };
          }
          return okFinalizeResult(PRODUCER_PR);
        },
      }),
      db,
      manifest: mf,
      primarySlug: TWO_REPO_PRIMARY,
    });

    const { stages } = await coordinator.run(EPIC_ID);

    // Both stages are partial_landing (all-or-none).
    const consumer = stages.find(s => s.repoSlug === 'repo-b')!;
    const producer = stages.find(s => s.repoSlug === 'repo-a')!;
    assert.equal(consumer.status, 'partial_landing', 'consumer must be partial_landing');
    assert.equal(producer.status, 'partial_landing', 'producer must also be partial_landing (AC2)');

    // Producer PR was staged (prUrl set).
    assert.equal(producer.prUrl, PRODUCER_PR, 'producer prUrl must be set from STAGE phase');
    // Consumer PR was not opened (gated).
    assert.equal(consumer.prUrl, undefined, 'consumer prUrl must be unset when gated');
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
    const outcome = await runConsumerGate({
      consumerRoot: '/repos/repo-b',
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
    const outcome = await runConsumerGate({
      consumerRoot: '/repos/repo-b',
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
    // Wrap the gate to capture the input; GateRunner eliminates the unsafe cast.
    const wrappedGate: GateRunner = {
      run: async (input: { projectRoot: string; conflicted?: string[] }) => {
        capturedConflicted = input.conflicted;
        return probeGate.run(input);
      },
    };
    await runConsumerGate({
      consumerRoot: '/repos/repo-b',
      conflicted: ['story-001-002'],
      gate: wrappedGate,
    });
    assert.deepEqual(capturedConflicted, ['story-001-002']);
  });
});
