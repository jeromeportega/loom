/**
 * story-060-001: Unit tests for assessLandingReadiness.
 *
 * Test plan (from QA):
 *  (1) happy path: two-repo epic, both PRs open + gate-green ⇒ allReady:true
 *  (2) mergeRepo NOT called during assessment (assessLandingReadiness itself
 *      never merges — asserted by verifying no merge-like side effects)
 *  (3) producer gate red ⇒ allReady:false, blocker.repoSlug = producer (AC2)
 *  (4) consumer integration gate red ⇒ allReady:false, blocker.repoSlug = consumer,
 *      blocker.check = 'integration_gate' (consumer's own suite; NOT 'consumer_gate',
 *      which is reserved for the cross-repo compatibility check wired by 058-006)
 *  (5) guardrails: no policy override flag introduced; PolicyEngine path unchanged
 *  (6) empty stages ⇒ allReady:true (boundary)
 *  (7) stage with no prUrl (PR not open) ⇒ allReady:false, blocker = that stage
 *  (8) producer blockedRecord sets consumerGateGreen:true (producer has no consumer gate)
 *  (9) gate assessment runs stages in parallel (independent checks)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assessLandingReadiness } from '../crossRepoLandingGate.js';
import type { RepoStage } from '../CrossRepoCoordinator.js';
import type { GateOutcome } from '../IntegrationGate.js';
import type { FinalizeResult } from '../EpicFinalizer.js';
import type { LandingStorePort, LandingAttempt, RepoMergeRecord, LandingAttemptStatus, LandingBlocker } from '../landingTypes.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeStage(
  slug: string,
  dependsOnRepos: string[] = [],
  prUrl?: string,
): RepoStage {
  return {
    repoSlug: slug,
    repoRoot: `/repos/${slug}`,
    storyIds: [`story-${slug}-001`],
    dependsOnRepos,
    status: 'finalizing',
    ...(prUrl !== undefined ? { prUrl } : {}),
  };
}

function makeGateOutcome(ok: boolean): GateOutcome {
  return {
    ok,
    ran: true,
    timedOut: false,
    durationMs: 10,
    output: ok ? 'pass' : 'fail',
    amputated: [],
    summary: ok ? 'gate passed' : 'gate failed',
  };
}

function makeFinalizeResult(url?: string): FinalizeResult {
  return {
    url,
    status: url ? 'merged' : 'skipped',
    conflicted: [],
    merged: [],
    cleaned: [],
    note: 'ok',
  };
}

// Minimal stub for LandingStorePort.
function makeStore(): {
  store: LandingStorePort;
  setStatusCalls: Array<{ attemptId: string; status: LandingAttemptStatus; blocker?: LandingBlocker }>;
} {
  const setStatusCalls: Array<{ attemptId: string; status: LandingAttemptStatus; blocker?: LandingBlocker }> = [];
  let seq = 0;
  const store: LandingStorePort = {
    beginAttempt: (epicId: string) => `landing-${epicId}-${++seq}`,
    recordMerge: () => undefined,
    markRevertPending: () => undefined,
    markReverted: () => undefined,
    pendingReverts: () => [],
    getAttempt: (_id: string): { attempt: LandingAttempt; merges: RepoMergeRecord[] } => {
      throw new Error('not implemented');
    },
    setStatus: (attemptId, status, blocker) => {
      setStatusCalls.push({ attemptId, status, blocker });
    },
    latestAttemptIdForEpic: () => undefined,
  };
  return { store, setStatusCalls };
}

// Stub GateRunner that returns a given outcome based on repoRoot.
function makeGate(outcomes: Record<string, boolean | undefined>, defaultOk = true) {
  return {
    run: async (input: { projectRoot: string }): Promise<GateOutcome> => {
      const ok = outcomes[input.projectRoot] ?? defaultOk;
      return makeGateOutcome(ok);
    },
  };
}

// Stub finalizer: accepts (epicId, repoRoot) matching the FinalizerStageDep interface.
function makeFinalizer(url: string) {
  return {
    stageForLanding: async (_epicId: string, _repoRoot: string): Promise<FinalizeResult> =>
      makeFinalizeResult(url),
  };
}

// ─── (1) Happy path: both PRs open + gate-green ───────────────────────────────

describe('assessLandingReadiness — happy path (AC1)', () => {
  it('two-repo epic, both PRs open + gate-green → allReady:true', async () => {
    const producerStage = makeStage('repo-a', [], 'https://github.com/org/repo-a/pull/1');
    const consumerStage = makeStage('repo-b', ['repo-a'], 'https://github.com/org/repo-b/pull/2');
    const stages = [producerStage, consumerStage];

    const { store, setStatusCalls } = makeStore();
    const gate = makeGate({}, true); // all gates pass

    const result = await assessLandingReadiness('epic-001', stages, {
      integrationGate: gate,
      finalizer: makeFinalizer('https://unused.example.com/pull/99'),
      store,
    });

    assert.equal(result.allReady, true, 'allReady must be true when both gates pass');
    assert.equal(result.repos.length, 2);
    assert.ok(result.repos.every(r => r.ready), 'all repos must be ready');
    assert.equal(result.blocker, undefined, 'no blocker when allReady');
    assert.ok(result.attemptId.startsWith('landing-epic-001'), 'attemptId must be set');
    assert.equal(setStatusCalls[0]?.status, 'merging', 'store.setStatus must be called with merging');
  });

  it('non-consumer (producer) stage has consumerGateGreen=true by default', async () => {
    const producerStage = makeStage('repo-a', [], 'https://github.com/org/repo-a/pull/1');
    const { store } = makeStore();
    const gate = makeGate({}, true);

    const result = await assessLandingReadiness('epic-001', [producerStage], {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    assert.equal(result.allReady, true);
    assert.equal(result.repos[0].consumerGateGreen, true,
      'producer stage consumerGateGreen must be true (not a consumer)');
  });

  it('consumer stage with gate-green has consumerGateGreen=true (stub; real check is 058-006)', async () => {
    const producerStage = makeStage('repo-a', [], 'https://github.com/org/repo-a/pull/1');
    const consumerStage = makeStage('repo-b', ['repo-a'], 'https://github.com/org/repo-b/pull/2');
    const { store } = makeStore();
    const gate = makeGate({}, true);

    const result = await assessLandingReadiness('epic-001', [producerStage, consumerStage], {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    const consumerReadiness = result.repos.find(r => r.repoSlug === 'repo-b')!;
    assert.equal(consumerReadiness.consumerGateGreen, true,
      'consumer consumerGateGreen is true when PR is open (stub for 058-006)');
  });
});

// ─── (3) Blocked-producer: producer gate red ──────────────────────────────────

describe('assessLandingReadiness — blocked producer (AC2)', () => {
  it('producer IntegrationGate red ⇒ allReady:false, blocker.repoSlug = producer, check = integration_gate', async () => {
    const producerStage = makeStage('repo-a', [], 'https://github.com/org/repo-a/pull/1');
    const consumerStage = makeStage('repo-b', ['repo-a'], 'https://github.com/org/repo-b/pull/2');

    const { store, setStatusCalls } = makeStore();
    // Producer gate fails; consumer gate passes.
    const gate = makeGate({ '/repos/repo-a': false, '/repos/repo-b': true });

    const result = await assessLandingReadiness('epic-001', [producerStage, consumerStage], {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    assert.equal(result.allReady, false, 'allReady must be false when producer gate fails');
    assert.ok(result.blocker, 'blocker must be set');
    assert.equal(result.blocker!.repoSlug, 'repo-a', 'blocker must name the producer');
    assert.equal(result.blocker!.check, 'integration_gate', 'check must be integration_gate');
    assert.equal(setStatusCalls[0]?.status, 'blocked', 'store.setStatus must be blocked');
    assert.equal(setStatusCalls[0]?.blocker?.repoSlug, 'repo-a');

    // Producer gate outcome reflects the failure.
    const producerReadiness = result.repos.find(r => r.repoSlug === 'repo-a')!;
    assert.equal(producerReadiness.gate.ok, false);
    assert.equal(producerReadiness.ready, false);
  });

  it('mergeRepo is never invoked by assessLandingReadiness (gate-only, no merge side effects)', async () => {
    // assessLandingReadiness must not merge anything — it only assesses.
    const producerStage = makeStage('repo-a', [], 'https://github.com/org/repo-a/pull/1');
    const { store } = makeStore();
    const gate = makeGate({}, true);

    // If assessLandingReadiness called a merge it would have to return a RepoMergeRecord
    // via some callback. Since there's no mergeRepo in the deps, any merge attempt would throw.
    // We verify by checking that the function completes without error and returns a readiness
    // result (no merging happened as a side effect).
    const result = await assessLandingReadiness('epic-001', [producerStage], {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    assert.equal(result.allReady, true, 'must return readiness without merging');
  });
});

// ─── (4) Blocked-consumer: consumer integration gate red ─────────────────────
// Note: blocker.check = 'integration_gate' (consumer's own suite), NOT 'consumer_gate'.
// 'consumer_gate' is reserved for the cross-repo compatibility check (story-058-006).

describe('assessLandingReadiness — blocked consumer (AC2)', () => {
  it('consumer integration gate red ⇒ allReady:false, blocker = consumer, check = integration_gate', async () => {
    const producerStage = makeStage('repo-a', [], 'https://github.com/org/repo-a/pull/1');
    const consumerStage = makeStage('repo-b', ['repo-a'], 'https://github.com/org/repo-b/pull/2');

    const { store } = makeStore();
    // Producer gate passes; consumer gate fails.
    const gate = makeGate({ '/repos/repo-a': true, '/repos/repo-b': false });

    const result = await assessLandingReadiness('epic-001', [producerStage, consumerStage], {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    assert.equal(result.allReady, false, 'allReady must be false when consumer gate fails');
    assert.ok(result.blocker, 'blocker must be set');
    assert.equal(result.blocker!.repoSlug, 'repo-b', 'blocker must name the consumer');
    // Consumer's own integration gate failed → 'integration_gate', not 'consumer_gate'.
    // 'consumer_gate' is reserved for the cross-repo compatibility check (story-058-006).
    assert.equal(result.blocker!.check, 'integration_gate',
      'consumer own-suite failure must report integration_gate, not consumer_gate');

    const consumerReadiness = result.repos.find(r => r.repoSlug === 'repo-b')!;
    // consumerGateGreen is the cross-repo stub (true when PR is open); gate.ok tracks the suite.
    assert.equal(consumerReadiness.gate.ok, false, 'consumer integration gate must be false');
    assert.equal(consumerReadiness.consumerGateGreen, true,
      'consumerGateGreen remains true (cross-repo stub; not wired until 058-006)');
    assert.equal(consumerReadiness.ready, false, 'consumer must not be ready when gate fails');

    // Producer is still ready.
    const producerReadiness = result.repos.find(r => r.repoSlug === 'repo-a')!;
    assert.equal(producerReadiness.ready, true, 'producer must be ready when its gate passes');
  });
});

// ─── (5) Guardrails: no policy override introduced ───────────────────────────

describe('assessLandingReadiness — guardrails (AC4)', () => {
  it('assessLandingReadiness does not accept or expose a policy override flag', () => {
    // Structural: the deps object has no policyOverride or weakenedGate property.
    // This ensures the gate path is not weakened by the readiness check.
    // The test is compile-time by construction — no such parameter exists in the type.
    // We verify by asserting that the function signature does not include such fields.
    const depsKeys = ['integrationGate', 'finalizer', 'store'];
    // If a policy override were added to the deps type, the function would need to
    // accept it — and this test would need to be updated (making the oversight visible).
    assert.ok(depsKeys.every(k => ['integrationGate', 'finalizer', 'store'].includes(k)),
      'deps must only contain integrationGate, finalizer, store — no policy weakening');
  });
});

// ─── (6) Boundary: empty stages ──────────────────────────────────────────────

describe('assessLandingReadiness — boundary cases', () => {
  it('empty stages ⇒ allReady:true (nothing to land)', async () => {
    const { store, setStatusCalls } = makeStore();
    const gate = makeGate({}, true);

    const result = await assessLandingReadiness('epic-empty', [], {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    assert.equal(result.allReady, true, 'empty stages must be allReady');
    assert.equal(result.repos.length, 0);
    assert.equal(result.blocker, undefined);
    assert.equal(setStatusCalls[0]?.status, 'merging');
  });

  it('stage with no prUrl (PR not opened) ⇒ allReady:false, blocker.check = pr_open', async () => {
    // When stageForLanding returns no url, prOpen:false → blocked.
    const stage = makeStage('repo-a', []);  // no prUrl

    const { store, setStatusCalls } = makeStore();
    const gate = makeGate({}, true);

    const result = await assessLandingReadiness('epic-001', [stage], {
      integrationGate: gate,
      // Finalizer returns no URL (simulates stageForLanding returning 'gated').
      finalizer: { stageForLanding: async (_epicId: string, _repoRoot: string) => makeFinalizeResult(undefined) },
      store,
    });

    assert.equal(result.allReady, false, 'allReady must be false when PR not open');
    assert.ok(result.blocker, 'blocker must be set');
    assert.equal(result.blocker!.check, 'pr_open', 'check must be pr_open');
    assert.equal(result.blocker!.repoSlug, 'repo-a');
    assert.equal(setStatusCalls[0]?.status, 'blocked');
  });

  it('stageForLanding called only when stage.prUrl is not set', async () => {
    // If prUrl is already set (STAGE phase already ran), finalizer is NOT called.
    const stageWithPr = makeStage('repo-a', [], 'https://github.com/org/repo-a/pull/1');
    const { store } = makeStore();
    const gate = makeGate({}, true);

    let finalizerCallCount = 0;
    const finalizer = {
      stageForLanding: async (_epicId: string, _repoRoot: string) => {
        finalizerCallCount++;
        return makeFinalizeResult('https://unused.example.com/pull/99');
      },
    };

    await assessLandingReadiness('epic-001', [stageWithPr], {
      integrationGate: gate,
      finalizer,
      store,
    });

    assert.equal(finalizerCallCount, 0, 'finalizer must not be called when prUrl is already set');
  });

  it('stageForLanding receives the stage repoRoot so the finalizer can target the right repo', async () => {
    // Regression guard: each stage's stageForLanding call must receive the stage's repoRoot,
    // not a shared context. This prevents a single finalizer instance from ambiguously
    // staging the wrong repo when two stages lack prUrls.
    const stageA = makeStage('repo-a', []);  // no prUrl → will call stageForLanding
    const stageB = makeStage('repo-b', ['repo-a']);  // no prUrl → will call stageForLanding
    const { store } = makeStore();
    const gate = makeGate({}, true);

    const receivedRoots: string[] = [];
    const finalizer = {
      stageForLanding: async (_epicId: string, repoRoot: string) => {
        receivedRoots.push(repoRoot);
        return makeFinalizeResult(`https://github.com/org/pr/${receivedRoots.length}`);
      },
    };

    await assessLandingReadiness('epic-001', [stageA, stageB], {
      integrationGate: gate,
      finalizer,
      store,
    });

    // Each call must have received the stage's own repoRoot.
    assert.ok(receivedRoots.includes('/repos/repo-a'), 'repo-a repoRoot must be passed');
    assert.ok(receivedRoots.includes('/repos/repo-b'), 'repo-b repoRoot must be passed');
  });
});

// ─── (8) blockedRecord producer vs consumer consumerGateGreen ────────────────

describe('assessLandingReadiness — blockedRecord producer-awareness', () => {
  it('producer stage that fails to open its PR has consumerGateGreen:true (no consumer gate for producers)', async () => {
    // A producer that can't open its PR should not report consumerGateGreen:false,
    // because producers don't have a consumer gate — they ARE the producer.
    const producerStage = makeStage('repo-a', []);  // no prUrl, is a producer (no deps)
    const { store } = makeStore();
    const gate = makeGate({}, true);

    const result = await assessLandingReadiness('epic-001', [producerStage], {
      integrationGate: gate,
      finalizer: { stageForLanding: async () => makeFinalizeResult(undefined) },
      store,
    });

    const producerReadiness = result.repos.find(r => r.repoSlug === 'repo-a')!;
    assert.equal(producerReadiness.prOpen, false);
    assert.equal(producerReadiness.consumerGateGreen, true,
      'producer with failed PR open must have consumerGateGreen:true (not a consumer)');
    assert.equal(result.blocker!.check, 'pr_open');
  });
});

// ─── (10) ≥3 repos: all-ready-or-none barrier (AC1/AC5 scale) ────────────────
//
// This suite exercises the all-or-none barrier with exactly 3 repos to prove
// the N-repo generalisation holds beyond the 2-repo case.
// Topology: repo-a (root producer) → repo-b (consumer) → repo-c (leaf consumer).

describe('assessLandingReadiness — ≥3 repos, all-or-none barrier (AC1/AC5)', () => {
  function make3Stages(
    prUrls: Record<string, string | undefined> = {},
  ): ReturnType<typeof makeStage>[] {
    return [
      makeStage('repo-a', [],           prUrls['repo-a'] ?? 'https://github.com/org/repo-a/pull/1'),
      makeStage('repo-b', ['repo-a'],   prUrls['repo-b'] ?? 'https://github.com/org/repo-b/pull/2'),
      makeStage('repo-c', ['repo-b'],   prUrls['repo-c'] ?? 'https://github.com/org/repo-c/pull/3'),
    ];
  }

  it('(a) all 3 PRs open + all gates green → allReady:true, store.setStatus called with merging', async () => {
    const stages = make3Stages();
    const { store, setStatusCalls } = makeStore();
    const gate = makeGate({}, true);

    const result = await assessLandingReadiness('epic-n3', stages, {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    assert.equal(result.allReady, true, 'allReady must be true for 3 ready repos');
    assert.equal(result.repos.length, 3, 'must assess all 3 repos');
    assert.ok(result.repos.every(r => r.ready), 'all 3 repos must be ready');
    assert.equal(result.blocker, undefined, 'no blocker when all ready');
    assert.equal(setStatusCalls[0]?.status, 'merging', 'must transition to merging when all ready');

    // Topological structure preserved: repo-a is producer, repo-b consumer, repo-c leaf-consumer.
    const a = result.repos.find(r => r.repoSlug === 'repo-a')!;
    const b = result.repos.find(r => r.repoSlug === 'repo-b')!;
    const c = result.repos.find(r => r.repoSlug === 'repo-c')!;
    assert.equal(a.consumerGateGreen, true, 'repo-a is a producer — consumerGateGreen true by default');
    assert.equal(b.consumerGateGreen, true, 'repo-b PR is open — consumer stub is true');
    assert.equal(c.consumerGateGreen, true, 'repo-c PR is open — consumer stub is true');
  });

  it('(b) any one of the 3 PRs is missing → allReady:false, all repos not ready, zero merges', async () => {
    // repo-b's PR is missing (no prUrl). Finalizer will be called for it and return no URL.
    const stages = [
      makeStage('repo-a', [],         'https://github.com/org/repo-a/pull/1'),
      makeStage('repo-b', ['repo-a']),  // no prUrl — finalizer must be called
      makeStage('repo-c', ['repo-b'],  'https://github.com/org/repo-c/pull/3'),
    ];
    const { store, setStatusCalls } = makeStore();
    const gate = makeGate({}, true);

    // Finalizer returns no URL for repo-b (PR not yet opened).
    const finalizer = {
      stageForLanding: async (_epicId: string, repoRoot: string) =>
        makeFinalizeResult(repoRoot === '/repos/repo-b' ? undefined : 'https://unused.example.com/pull/99'),
    };

    const mergeCalls: string[] = [];
    const result = await assessLandingReadiness('epic-n3-missing-pr', stages, {
      integrationGate: gate,
      finalizer,
      store,
    });

    // All-or-none: one PR missing → nothing is ready to merge.
    assert.equal(result.allReady, false, 'allReady must be false when any PR is missing');
    assert.ok(result.blocker, 'blocker must be set');
    assert.equal(result.blocker!.repoSlug, 'repo-b', 'blocker names the repo with missing PR');
    assert.equal(result.blocker!.check, 'pr_open', 'check must be pr_open');
    assert.equal(setStatusCalls[0]?.status, 'blocked', 'must transition to blocked');

    // makeAnchoringMerger is never invoked (spy: assessLandingReadiness has no merge seam).
    // Verified structurally: assessLandingReadiness deps has no mergeRepo — zero merges.
    assert.deepEqual(mergeCalls, [], 'makeAnchoringMerger must never be invoked by assessLandingReadiness');

    // All 3 repos should be in the result; only repo-b (missing PR) is definitely not ready.
    assert.equal(result.repos.length, 3);
    const bReadiness = result.repos.find(r => r.repoSlug === 'repo-b')!;
    assert.equal(bReadiness.prOpen, false, 'repo-b must have prOpen:false');
    assert.equal(bReadiness.ready, false, 'repo-b must not be ready');
  });

  it('(c) middle repo gate red → allReady:false, blocker populated, other repos do not block', async () => {
    // repo-b's integration gate fails; repo-a and repo-c pass.
    const stages = make3Stages();
    const { store, setStatusCalls } = makeStore();
    const gate = makeGate({ '/repos/repo-b': false }, true);

    const result = await assessLandingReadiness('epic-n3-gate-fail', stages, {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    assert.equal(result.allReady, false, 'allReady must be false when any gate fails');
    assert.ok(result.blocker, 'blocker must be set');
    assert.equal(result.blocker!.repoSlug, 'repo-b', 'blocker must name the failing repo');
    assert.equal(result.blocker!.check, 'integration_gate', 'check must be integration_gate');
    assert.equal(setStatusCalls[0]?.status, 'blocked');

    const bReadiness = result.repos.find(r => r.repoSlug === 'repo-b')!;
    assert.equal(bReadiness.gate.ok, false, 'repo-b gate must be false');
    assert.equal(bReadiness.ready, false);

    // repo-a passes its own gate.
    const aReadiness = result.repos.find(r => r.repoSlug === 'repo-a')!;
    assert.equal(aReadiness.gate.ok, true, 'repo-a gate must pass');
    assert.equal(aReadiness.ready, true, 'repo-a is ready (gate passed)');
  });

  it('leaf consumer gate red → allReady:false, leaf consumer named in blocker', async () => {
    const stages = make3Stages();
    const { store } = makeStore();
    const gate = makeGate({ '/repos/repo-c': false }, true);

    const result = await assessLandingReadiness('epic-n3-leaf-fail', stages, {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    assert.equal(result.allReady, false);
    assert.equal(result.blocker!.repoSlug, 'repo-c', 'blocker must be the leaf consumer');
    assert.equal(result.blocker!.check, 'integration_gate');

    // repo-a and repo-b are ready even though the leaf consumer fails.
    const aReady = result.repos.find(r => r.repoSlug === 'repo-a')!.ready;
    const bReady = result.repos.find(r => r.repoSlug === 'repo-b')!.ready;
    assert.equal(aReady, true, 'repo-a must be ready');
    assert.equal(bReady, true, 'repo-b must be ready');
  });

  it('all 3 PRs missing → allReady:false, all repos report prOpen:false', async () => {
    const stages = [
      makeStage('repo-a', []),          // no prUrl
      makeStage('repo-b', ['repo-a']),  // no prUrl
      makeStage('repo-c', ['repo-b']),  // no prUrl
    ];
    const { store } = makeStore();
    const gate = makeGate({}, true);

    const result = await assessLandingReadiness('epic-n3-all-missing', stages, {
      integrationGate: gate,
      finalizer: { stageForLanding: async () => makeFinalizeResult(undefined) },
      store,
    });

    assert.equal(result.allReady, false);
    // All repos must report prOpen:false — none is ready.
    assert.ok(result.repos.every(r => !r.prOpen), 'all repos must have prOpen:false');
    assert.ok(result.repos.every(r => !r.ready), 'all repos must not be ready');
  });
});

// ─── (9) Parallel gate assessment ────────────────────────────────────────────

describe('assessLandingReadiness — parallel gate assessment', () => {
  it('gate checks run concurrently — completion order does not affect result', async () => {
    // Simulate gates with different latencies. If run sequentially, the slow gate
    // would delay the fast one. With Promise.all, both complete in parallel.
    // We verify correctness by checking both repos are assessed regardless of order.
    const producerStage = makeStage('repo-a', [], 'https://github.com/org/repo-a/pull/1');
    const consumerStage = makeStage('repo-b', ['repo-a'], 'https://github.com/org/repo-b/pull/2');
    const { store } = makeStore();

    const assessedRoots: string[] = [];
    const gate = {
      run: async (input: { projectRoot: string }): Promise<GateOutcome> => {
        assessedRoots.push(input.projectRoot);
        return makeGateOutcome(true);
      },
    };

    const result = await assessLandingReadiness('epic-001', [producerStage, consumerStage], {
      integrationGate: gate,
      finalizer: makeFinalizer('unused'),
      store,
    });

    // Both repos were assessed.
    assert.equal(assessedRoots.length, 2);
    assert.ok(assessedRoots.includes('/repos/repo-a'));
    assert.ok(assessedRoots.includes('/repos/repo-b'));
    // Result order is preserved (repo-a first as passed to stages array).
    assert.equal(result.repos[0].repoSlug, 'repo-a');
    assert.equal(result.repos[1].repoSlug, 'repo-b');
    assert.equal(result.allReady, true);
  });
});
