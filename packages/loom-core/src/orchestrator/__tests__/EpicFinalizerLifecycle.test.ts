import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import { Supervisor } from '../Supervisor.js';
import { MockWorkerRunner } from '../MockWorkerRunner.js';
import { EpicFinalizer } from '../EpicFinalizer.js';
import type { EpicFinalizerOptions } from '../EpicFinalizer.js';
import { IntegrationGate } from '../IntegrationGate.js';
import type { Story } from '../../types.js';

// ─── Story story-005-002 ────────────────────────────────────────────────────
// Finalizing lifecycle + PR-URL recording. These tests exercise the real
// EpicFinalizer.finalize() and the Supervisor done-gate against a real temp
// better-sqlite3 DB and a real EpicStore, but stub the external git-push /
// gh-pr-create / integration-gate seams so each FinalizeResult branch is
// deterministic (no network, no shell). The no-false-done invariant
// (`done ⇒ epic_pr_url != null`) lives in code, so it is asserted directly.

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

/** A worker that drops a real commit so the finalizer has something to merge. */
function committingWorker(): MockWorkerRunner {
  return new MockWorkerRunner(async (a) => {
    execFileSync('git', ['commit', '--allow-empty', '-m', `${a.storyId}: work`], {
      cwd: a.worktreePath,
    });
    return { status: 'done' as const, commitCount: 1, summary: `built ${a.storyId}`, logTail: '' };
  });
}

/** A green integration gate stub — never spawns a process. */
function greenGate(): IntegrationGate {
  return new IntegrationGate({
    testCommand: 'noop',
    runner: () => ({ exitCode: 0, output: 'ok', timedOut: false, durationMs: 1 }),
  });
}

/** A red integration gate stub — exits non-zero. */
function redGate(): IntegrationGate {
  return new IntegrationGate({
    testCommand: 'noop',
    runner: () => ({ exitCode: 1, output: 'boom', timedOut: false, durationMs: 1 }),
  });
}

/**
 * Records the ORDERED sequence of EpicStore lifecycle writes across BOTH the
 * finalizer and the supervisor by monkey-patching EpicStore.prototype. This is
 * how we prove WRITE ORDERING (not just final state) — e.g. that recordPrUrl
 * lands before any status='done' write. Returns the log + a restore fn.
 */
type WriteEvent =
  | { op: 'beginFinalizing'; phase: string }
  | { op: 'updateFinalizePhase'; phase: string }
  | { op: 'recordPrUrl'; url: string }
  | { op: 'updateStatus'; status: string }
  | { op: 'fail'; error: string };

function recordLifecycleWrites(): { log: WriteEvent[]; restore: () => void } {
  const log: WriteEvent[] = [];
  const proto = EpicStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = {
    beginFinalizing: proto.beginFinalizing,
    updateFinalizePhase: proto.updateFinalizePhase,
    recordPrUrl: proto.recordPrUrl,
    updateStatus: proto.updateStatus,
    fail: proto.fail,
  };
  proto.beginFinalizing = function (this: EpicStore, id: unknown, phase: unknown) {
    log.push({ op: 'beginFinalizing', phase: phase as string });
    return orig.beginFinalizing.call(this, id, phase);
  };
  proto.updateFinalizePhase = function (this: EpicStore, id: unknown, phase: unknown) {
    log.push({ op: 'updateFinalizePhase', phase: phase as string });
    return orig.updateFinalizePhase.call(this, id, phase);
  };
  proto.recordPrUrl = function (this: EpicStore, id: unknown, url: unknown) {
    log.push({ op: 'recordPrUrl', url: url as string });
    return orig.recordPrUrl.call(this, id, url);
  };
  proto.updateStatus = function (this: EpicStore, id: unknown, status: unknown, reason?: unknown) {
    log.push({ op: 'updateStatus', status: status as string });
    return orig.updateStatus.call(this, id, status, reason);
  };
  proto.fail = function (this: EpicStore, id: unknown, error: unknown) {
    log.push({ op: 'fail', error: error as string });
    return orig.fail.call(this, id, error);
  };
  return {
    log,
    restore: () => {
      proto.beginFinalizing = orig.beginFinalizing;
      proto.updateFinalizePhase = orig.updateFinalizePhase;
      proto.recordPrUrl = orig.recordPrUrl;
      proto.updateStatus = orig.updateStatus;
      proto.fail = orig.fail;
    },
  };
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-finlife-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
});

/**
 * Adds an `origin` remote whose URL matches the default allowed glob so the
 * push + PR path is reachable. The push itself is stubbed via `pushBranch`, so
 * no real remote / network is ever touched — the URL only has to exist and
 * pass the allowed_remotes check.
 */
function addAllowedRemote(): void {
  gitc(['remote', 'add', 'origin', 'https://example.com/acme/loom.git']);
}

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

/**
 * Base finalizer options that make the push + PR seams deterministic. The
 * caller overrides `openPr` per case. A configured remote + allowed glob
 * makes the push path reachable; the push itself is stubbed so no network /
 * real remote is needed.
 */
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
    openPr: () => 'https://example.com/acme/loom/pull/42',
    ...over,
  };
}

describe('story-005-002 — finalize phase overlay + done-requires-PR-URL invariant', () => {
  // (1) Happy PR path — phase advances merging→gate→review→pushing→opening_pr,
  // recordPrUrl is called and epic_pr_url is persisted BEFORE status='done'
  // (ordering proven), and the epic ends 'done'.
  it('happy PR path: advances phases, records the PR URL before done, ends done', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    const db = openDatabase(path.join(repo, '.loom'));
    const spy = recordLifecycleWrites();
    try {
      await new Supervisor({
        projectRoot: repo,
        db,
        worker: committingWorker(),
        maxConcurrent: 1,
        epicFinalizer: new EpicFinalizer(finalizerOpts(db)),
      }).run();
    } finally {
      spy.restore();
    }

    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'done');
    assert.equal(epic?.epic_pr_url, 'https://example.com/acme/loom/pull/42');

    // Phase markers advanced in order (filtering to just the finalize-phase ops).
    const phases = spy.log
      .filter((e) => e.op === 'beginFinalizing' || e.op === 'updateFinalizePhase')
      .map((e) => (e as { phase: string }).phase);
    assert.deepEqual(phases, ['merging', 'gate', 'review', 'pushing', 'opening_pr']);

    // ORDERING: recordPrUrl must come strictly before the status='done' write.
    const prIdx = spy.log.findIndex((e) => e.op === 'recordPrUrl');
    const doneIdx = spy.log.findIndex((e) => e.op === 'updateStatus' && e.status === 'done');
    assert.ok(prIdx >= 0, 'recordPrUrl must have been called');
    assert.ok(doneIdx >= 0, "status='done' must have been written");
    assert.ok(prIdx < doneIdx, 'recordPrUrl MUST be written before status=done (ADR-3)');
  });

  // (2) Invariant — done ⇒ epic_pr_url != null, asserted directly across branches.
  it('invariant: no epic ever reaches done with a null epic_pr_url', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    const epics = new EpicStore(db);

    // Happy path → done with a URL.
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(finalizerOpts(db)),
    }).run();

    // PR-less success (no remote) → not done.
    seedEpic('epic-002', [story('story-002-001')]);
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, { allowedRemotes: [], pushBranch: undefined, openPr: undefined })
      ),
    }).run();

    for (const e of epics.list()) {
      if (e.status === 'done') {
        assert.notEqual(
          e.epic_pr_url,
          null,
          `epic ${e.id} reached done but has a null epic_pr_url — invariant violated`
        );
      }
    }
    // Sanity: at least one epic is done (the happy path) and one is NOT.
    assert.equal(epics.get('epic-001')?.status, 'done');
    assert.notEqual(epics.get('epic-002')?.status, 'done');
  });

  // (3) push-gate confirm → terminal-but-not-done, PR-less success surfaced.
  it('push-gate confirm: terminal non-done at phase review, surfaced via reason, not stranded', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let openPrCalls = 0;
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          pushGate: 'confirm',
          openPr: () => {
            openPrCalls++;
            return 'should-not-open';
          },
        })
      ),
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    assert.notEqual(epic?.status, 'done', 'push-gated success must NOT reach done');
    assert.equal(epic?.epic_pr_url, null, 'no PR URL was recorded');
    assert.equal(epic?.finalize_phase, 'review', 'phase stops at review');
    assert.match(epic?.reason ?? '', /push gated/i, 'reason surfaces the PR-less success');
    assert.equal(openPrCalls, 0, 'push gate stops before opening any PR');
  });

  // (4) no-remote AND remote-not-allowed → PR-less terminal at phase pushing.
  it('no remote: terminal non-done at phase pushing', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      // allowedRemotes irrelevant — there is no remote configured on the repo.
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, { pushBranch: undefined, openPr: undefined })
      ),
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    assert.notEqual(epic?.status, 'done');
    assert.equal(epic?.epic_pr_url, null);
    assert.equal(epic?.finalize_phase, 'pushing');
    assert.match(epic?.reason ?? '', /no remote/i);
  });

  it('remote-not-allowed: terminal non-done at phase pushing', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    // Configure a remote whose URL is NOT in allowed_remotes.
    gitc(['remote', 'add', 'origin', 'https://forbidden.example.com/x/y.git']);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          allowedRemotes: ['https://allowed.example.com/*'],
          pushBranch: undefined,
          openPr: undefined,
        })
      ),
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    assert.notEqual(epic?.status, 'done');
    assert.equal(epic?.epic_pr_url, null);
    assert.equal(epic?.finalize_phase, 'pushing');
    assert.match(epic?.reason ?? '', /allowed_remotes/i);
  });

  // (5) gated (block mode) → status stays in_progress, phase up to gate.
  it('gated (block): status stays in_progress, finalize_phase up to gate, no done', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    let openPrCalls = 0;
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          integrationGate: 'block',
          gate: redGate(),
          openPr: () => {
            openPrCalls++;
            return 'should-not-open';
          },
        })
      ),
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'in_progress', 'a blocked gate returns the epic to in_progress');
    assert.equal(epic?.epic_pr_url, null);
    assert.equal(epic?.finalize_phase, 'gate', 'phase stops at gate');
    assert.equal(openPrCalls, 0, 'a blocked gate never opens a PR');
  });

  // (6) skipped (no succeeded stories) → status unchanged, no PR, no done.
  it('skipped (per-story strategy): no phase, no PR URL, never done', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));
    const epics = new EpicStore(db);
    epics.updateBaseSha('epic-001', gitc(['rev-parse', 'HEAD']));

    // Directly drive finalize with prStrategy='per-story' → skipped no-op.
    const result = await new EpicFinalizer(
      finalizerOpts(db, { prStrategy: 'per-story' as never })
    ).finalize('epic-001');

    assert.equal(result.status, 'skipped');
    const epic = epics.get('epic-001');
    assert.notEqual(epic?.status, 'done');
    assert.equal(epic?.epic_pr_url, null);
    assert.equal(epic?.finalize_phase, null, 'skipped never enters the finalize overlay');
  });

  // (7) push fails → publish_pending (FR-2): epicStore.publishPending() is called,
  //     setting status='publish_pending', finalize_ref (FR-1 persisted before push),
  //     and publish_note carrying the failure message. finalize_phase is cleared.
  it('push fails: epic lands publish_pending (FR-2), finalize_ref persisted (FR-1)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          pushBranch: () => ({ ok: false, output: 'remote rejected: protected branch' }),
        })
      ),
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    // FR-2: publishPending() sets status='publish_pending', not 'finalizing'
    assert.equal(epic?.status, 'publish_pending', 'push failure uses publishPending → publish_pending status');
    assert.equal(epic?.error ?? null, null, 'publish_pending path does not set error');
    // FR-2: failure message goes into publish_note (not reason)
    assert.match(epic?.publish_note ?? '', /push failed/i, 'publish_note carries the push failure message');
    // FR-2: publishPending() clears finalize_phase
    assert.equal(epic?.finalize_phase, null, 'publishPending clears finalize_phase');
    // FR-1: finalize_ref was persisted before the push attempt
    assert.ok(epic?.finalize_ref, 'FR-1: finalize_ref is persisted before push');
    assert.match(epic?.finalize_ref ?? '', /^loom\/finalize\/epic-001-/, 'finalize_ref has expected format');
    assert.equal(epic?.epic_pr_url, null);
  });

  // (8) gh pr create throws → publish_pending (FR-2): push succeeded but PR open failed.
  //     publishPending() records the ref + note; status='publish_pending'.
  it('gh pr create throws: epic lands publish_pending (FR-2), finalize_ref set (FR-1)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    const db = openDatabase(path.join(repo, '.loom'));

    // Push succeeds but opening the PR throws. The finalizer records the pushed
    // ref and calls publishPending — the epic must NOT be 'done' or 'failed'.
    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          openPr: () => {
            throw new Error('gh exploded');
          },
        })
      ),
    }).run();

    const epic0 = new EpicStore(db).get('epic-001');
    // FR-2: status is 'publish_pending' (not 'finalizing', 'done', or 'failed')
    assert.equal(epic0?.status, 'publish_pending', 'PR-open failure uses publishPending → publish_pending status');
    assert.notEqual(epic0?.status, 'done', 'a PR that fails to open must not be done');
    assert.notEqual(epic0?.status, 'failed', 'publish_pending is recoverable — not failed');
    assert.equal(epic0?.epic_pr_url, null);
    // FR-2: failure message goes into publish_note
    assert.match(
      epic0?.publish_note ?? '',
      /loom publish/i,
      'publish_note must reference the loom publish recovery command'
    );
    // FR-1: finalize_ref was persisted before the push attempt
    assert.ok(epic0?.finalize_ref, 'FR-1: finalize_ref is persisted before push');
    // FR-2: publishPending() clears finalize_phase
    assert.equal(epic0?.finalize_phase, null, 'publishPending clears finalize_phase');
  });

  // (8) Crash-between-writes — failure after recordPrUrl but before the done
  // flip: the epic must read finalizing/terminal-non-done, never done.
  it('crash between recordPrUrl and the done flip: never observes a null-URL done', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    const db = openDatabase(path.join(repo, '.loom'));
    const epics = new EpicStore(db);
    epics.updateBaseSha('epic-001', gitc(['rev-parse', 'HEAD']));

    // Mark the single story done so finalize has something to merge.
    const agents = new AgentStore(db);
    const a = agents.create('epic-001', 'story-001-001', 'one');
    agents.updateStatus(a.id, 'done');
    // Give the story branch a commit so the merge is non-trivial.
    gitc(['branch', 'story/story-001-001']);
    gitc(['checkout', '-q', 'story/story-001-001']);
    gitc(['commit', '--allow-empty', '-q', '-m', 'story work']);
    gitc(['checkout', '-q', '-']);

    // Run finalize() in isolation (no Supervisor) — finalize does NOT write
    // done; only the Supervisor's gate does. This SIMULATES the crash window:
    // recordPrUrl ran, the process died before the supervisor flipped done.
    const result = await new EpicFinalizer(finalizerOpts(db)).finalize('epic-001');

    assert.equal(result.status, 'merged');
    assert.equal(result.url, 'https://example.com/acme/loom/pull/42');
    const epic = epics.get('epic-001');
    // The PR URL is durable...
    assert.equal(epic?.epic_pr_url, 'https://example.com/acme/loom/pull/42');
    // ...but the crash before the supervisor's gate ran means status is NOT
    // done — it reads finalizing (the in-flight overlay), never a false done.
    assert.notEqual(epic?.status, 'done', 'finalize alone must never produce done');
    assert.equal(epic?.status, 'finalizing');
  });

  // (9) Step logic untouched — the six early-return paths still return their
  // original FinalizeResult shape and are not reordered (overlay only wraps).
  it('overlay only wraps: each FinalizeResult branch keeps its original status', async () => {
    const db = openDatabase(path.join(repo, '.loom'));

    // skipped (per-story).
    seedEpic('epic-001', [story('story-001-001')]);
    new EpicStore(db).updateBaseSha('epic-001', gitc(['rev-parse', 'HEAD']));
    let r = await new EpicFinalizer(
      finalizerOpts(db, { prStrategy: 'per-story' as never })
    ).finalize('epic-001');
    assert.equal(r.status, 'skipped');

    // skipped (no succeeded stories) — agents exist but none done.
    seedEpic('epic-002', [story('story-002-001')]);
    new EpicStore(db).updateBaseSha('epic-002', gitc(['rev-parse', 'HEAD']));
    r = await new EpicFinalizer(finalizerOpts(db)).finalize('epic-002');
    assert.equal(r.status, 'skipped');
    assert.match(r.note, /no succeeded stories/);

    // failed (no base_sha).
    seedEpic('epic-003', [story('story-003-001')]);
    r = await new EpicFinalizer(finalizerOpts(db)).finalize('epic-003');
    assert.equal(r.status, 'failed');
    assert.match(r.note, /no base_sha/);

    // failed (epic not found).
    r = await new EpicFinalizer(finalizerOpts(db)).finalize('epic-404');
    assert.equal(r.status, 'failed');
    assert.match(r.note, /not found/);
  });

  // Supervisor: a finalizer error never crashes the run and the epic is failed.
  it('supervisor: a finalize() that throws is recorded as a terminal failure, not done', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    const throwingFinalizer = {
      finalize: async () => {
        throw new Error('finalizer blew up');
      },
    } as unknown as EpicFinalizer;

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: throwingFinalizer,
    }).run();

    assert.equal(result.storiesDone, 1);
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'failed', 'a finalizer throw is a terminal failure');
    assert.notEqual(epic?.status, 'done');
    assert.match(epic?.error ?? '', /finalize threw/i);
  });

  // No finalizer wired: legacy "all stories done ⇒ done" preserved (the epic-PR
  // gate only applies to the finalize flow).
  it('no finalizer: legacy all-stories-done ⇒ done is preserved', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repo, '.loom'));

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    assert.equal(new EpicStore(db).get('epic-001')?.status, 'done');
  });
});

describe('story-005-001 — finalizer-owned ref push target', () => {
  // (1) The push target is a fresh loom/finalize/* ref, never epic/*.
  //     The --head for gh pr create must use the same fresh ref.
  it('push goes to loom/finalize/* ref, not epic/*; --head matches push ref', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    const db = openDatabase(path.join(repo, '.loom'));

    const pushedBranches: string[] = [];
    const openedBranches: string[] = [];

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          pushBranch: (remote, branch) => {
            pushedBranches.push(branch);
            return { ok: true, output: 'pushed' };
          },
          openPr: ({ branch }) => {
            openedBranches.push(branch);
            return 'https://example.com/acme/loom/pull/42';
          },
        })
      ),
    }).run();

    assert.equal(pushedBranches.length, 1, 'exactly one push issued');
    assert.equal(openedBranches.length, 1, 'exactly one PR opened');

    const pushedRef = pushedBranches[0];
    const prHeadRef = openedBranches[0];

    // Push must use a loom/finalize/* ref, NEVER epic/*.
    assert.ok(
      pushedRef.startsWith('loom/finalize/'),
      `push ref must start with loom/finalize/: got "${pushedRef}"`
    );
    assert.ok(
      !pushedRef.startsWith('epic/'),
      `push ref must NOT start with epic/: got "${pushedRef}"`
    );

    // gh pr create --head must use the same fresh ref.
    assert.equal(prHeadRef, pushedRef, '--head must match the push ref');

    // Ref must follow the loom/finalize/<epicId>-<7charsha> pattern.
    assert.match(
      pushedRef,
      /^loom\/finalize\/epic-001-[0-9a-f]{7}$/,
      `ref must match loom/finalize/<epicId>-<7charsha>: got "${pushedRef}"`
    );
  });

  // (2) Non-fast-forward survival: the remote's epic/<id> ref has diverged (a
  //     push to it would be non-fast-forward), but the finalizer pushes to the
  //     fresh loom/finalize/* ref which is a brand-new ref on the remote —
  //     always a fast-forward. finalize proceeds to open a PR with no retry.
  it('non-fast-forward survival: push to fresh ref succeeds even when epic/<id> diverged', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    const db = openDatabase(path.join(repo, '.loom'));

    // Simulate a diverged remote: create an orphan commit and point
    // refs/remotes/origin/epic/epic-001 at it. A push to epic/<id> would be
    // rejected as non-fast-forward; the finalizer must avoid that ref entirely.
    const orphanSha = execFileSync(
      'git',
      ['commit-tree', '-m', 'orphan on remote', gitc(['rev-parse', 'HEAD^{tree}'])],
      { cwd: repo, encoding: 'utf8' }
    ).trim();
    gitc(['update-ref', 'refs/remotes/origin/epic/epic-001', orphanSha]);

    let pushCount = 0;

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          // The push stub simulates the remote accepting the fresh loom/finalize/*
          // ref (new ref — never a non-fast-forward), while the diverged
          // refs/remotes/origin/epic/epic-001 above would have been rejected.
          pushBranch: (_remote, branch) => {
            pushCount++;
            assert.ok(
              branch.startsWith('loom/finalize/'),
              `push must go to fresh loom/finalize/* ref, not epic/<id>: got "${branch}"`
            );
            return { ok: true, output: 'pushed' };
          },
        })
      ),
    }).run();

    assert.equal(pushCount, 1, 'exactly one push issued — no retry');
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'done', 'finalize proceeds to done after successful push');
    assert.notEqual(epic?.epic_pr_url, null, 'PR URL was recorded');
  });

  // (3) No force flags: no --force or --force-with-lease in any captured push call.
  //
  // Structural guarantee: the non-stub gitSafe path calls
  //   gitSafe(cwd, ['push', remote, `${epicBranch}:${finalRef}`])
  // — no --force or --force-with-lease flag is present. This stub-based test
  // catches the complementary case: a force flag accidentally injected into the
  // ref arg itself (which is what `pushBranch` captures). It cannot catch a
  // flag added directly to the gitSafe args array on the non-stub path; that
  // invariant is structural (inspect EpicFinalizer.ts push call directly).
  it('no --force or --force-with-lease in any push invocation', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    const db = openDatabase(path.join(repo, '.loom'));

    const allPushedRefs: string[] = [];

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: committingWorker(),
      maxConcurrent: 1,
      epicFinalizer: new EpicFinalizer(
        finalizerOpts(db, {
          pushBranch: (_remote, branch) => {
            allPushedRefs.push(branch);
            return { ok: true, output: 'pushed' };
          },
        })
      ),
    }).run();

    for (const ref of allPushedRefs) {
      assert.ok(!ref.includes('--force'), `force flag must not appear in push ref arg: "${ref}"`);
      assert.ok(
        !ref.includes('--force-with-lease'),
        `force-with-lease must not appear in push ref arg: "${ref}"`
      );
    }
    assert.ok(allPushedRefs.length > 0, 'at least one push must have been issued');
  });

  // (4) Determinism: the pushed ref embeds the integrated HEAD SHA, so the same
  //     integrated tree always produces the same ref name (retry is idempotent).
  it('pushed ref is deterministic — encodes the integrated HEAD sha', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    addAllowedRemote();
    const db = openDatabase(path.join(repo, '.loom'));

    const agents = new AgentStore(db);
    const a = agents.create('epic-001', 'story-001-001', 'one');
    agents.updateStatus(a.id, 'done');
    gitc(['branch', 'story/story-001-001']);
    gitc(['checkout', '-q', 'story/story-001-001']);
    gitc(['commit', '--allow-empty', '-q', '-m', 'story work']);
    gitc(['checkout', '-q', '-']);
    new EpicStore(db).updateBaseSha('epic-001', gitc(['rev-parse', 'HEAD']));

    const pushedRefs: string[] = [];

    await new EpicFinalizer(
      finalizerOpts(db, {
        pushBranch: (_r, b) => { pushedRefs.push(b); return { ok: true, output: 'ok' }; },
        openPr: () => 'https://example.com/acme/loom/pull/1',
      })
    ).finalize('epic-001');

    assert.equal(pushedRefs.length, 1, 'exactly one push');
    const pushedRef = pushedRefs[0];

    // The ref encodes the integrated HEAD: loom/finalize/<epicId>-<head7>.
    // Extract the 7-char sha from the pushed ref and verify it matches the
    // actual HEAD of epic/epic-001 after the merge.
    const match = pushedRef.match(/^loom\/finalize\/epic-001-([0-9a-f]{7})$/);
    assert.ok(match, `pushed ref must match pattern: got "${pushedRef}"`);
    const head7InRef = match[1];

    // Read the actual HEAD sha of epic/<id> from git.
    const actualHead = gitc(['rev-parse', 'epic/epic-001']);
    const actualHead7 = actualHead.slice(0, 7);

    assert.equal(
      head7InRef,
      actualHead7,
      `ref must encode the actual integrated HEAD: expected ${actualHead7}, got ${head7InRef}`
    );
  });
});
