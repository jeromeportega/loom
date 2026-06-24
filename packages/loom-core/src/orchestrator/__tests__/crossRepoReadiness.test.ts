import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCrossRepoEdge,
  buildRepoDag,
  isDepReady,
  validateCrossRepoEdges,
  findReposInCycles,
} from '../crossRepoReadiness.js';
import type { Story } from '../../types.js';
import type { WorkspaceManifest, ManifestEntry } from '../../home/workspaceManifest.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function entry(slug: string, opts: { primary?: boolean } = {}): ManifestEntry {
  return { slug, path: `/repos/${slug}`, remote_url: null, ...opts };
}

function manifest(repos: ManifestEntry[]): WorkspaceManifest {
  return { version: 1, repos };
}

function story(id: string, deps: string[] = [], repo?: string): Story {
  return {
    id,
    title: `Story ${id} title long enough`,
    description: 'description',
    acceptance_criteria: ['AC1'],
    estimated_complexity: 'medium',
    dependencies: deps,
    ...(repo !== undefined ? { repo } : {}),
  };
}

// Two-repo manifest used across multiple tests.
const TWO_REPO_MANIFEST = manifest([entry('repo-api'), entry('repo-frontend')]);
const TWO_REPO_PRIMARY = 'repo-api';

// Single-repo manifest for regression tests.
const SINGLE_REPO_MANIFEST = manifest([entry('repo-mono')]);
const SINGLE_REPO_PRIMARY = 'repo-mono';

// ── 1. isCrossRepoEdge ────────────────────────────────────────────────────────

describe('isCrossRepoEdge — different repos', () => {
  it('returns true when story and dep resolve to different slugs', () => {
    const s = story('story-001-001', [], 'repo-frontend');
    const dep = story('story-001-002', [], 'repo-api');
    assert.equal(isCrossRepoEdge(s, dep, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), true);
  });

  it('returns true regardless of which repo is producer vs consumer', () => {
    const s = story('story-001-001', [], 'repo-api');
    const dep = story('story-001-002', [], 'repo-frontend');
    assert.equal(isCrossRepoEdge(s, dep, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), true);
  });

  it('resolves primarySlug when story.repo is absent', () => {
    // story has no repo → resolves to primary (repo-api)
    const s = story('story-001-001');
    const dep = story('story-001-002', [], 'repo-frontend');
    assert.equal(isCrossRepoEdge(s, dep, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), true);
  });
});

describe('isCrossRepoEdge — same repo', () => {
  it('returns false when both stories resolve to the same slug', () => {
    const s = story('story-001-001', [], 'repo-api');
    const dep = story('story-001-002', [], 'repo-api');
    assert.equal(isCrossRepoEdge(s, dep, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), false);
  });

  it('returns false when both stories omit repo (both default to primary)', () => {
    const s = story('story-001-001');
    const dep = story('story-001-002');
    assert.equal(isCrossRepoEdge(s, dep, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), false);
  });

  it('returns false in a single-repo epic (no story has repo set)', () => {
    const s = story('story-001-001');
    const dep = story('story-001-002');
    assert.equal(isCrossRepoEdge(s, dep, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY), false);
  });
});

// ── 2. buildRepoDag ───────────────────────────────────────────────────────────

describe('buildRepoDag', () => {
  it('single-repo epic: all stories map to one slug with no inter-repo deps', () => {
    const stories = [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ];
    const dag = buildRepoDag(stories, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY);
    assert.equal(dag.size, 1);
    assert.deepEqual(dag.get('repo-mono'), []);
  });

  it('two-repo epic: consumer depends on producer at the repo level', () => {
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', ['story-001-001'], 'repo-frontend'),
    ];
    const dag = buildRepoDag(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    assert.equal(dag.size, 2);
    assert.deepEqual(dag.get('repo-frontend'), ['repo-api']);
    assert.deepEqual(dag.get('repo-api'), []);
  });

  it('same-repo dependencies do not appear as cross-repo edges in the DAG', () => {
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', ['story-001-001'], 'repo-api'),  // same repo
      story('story-001-003', ['story-001-002'], 'repo-frontend'),  // cross-repo
    ];
    const dag = buildRepoDag(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    // repo-frontend depends on repo-api (via story-001-002→story-001-003)
    assert.deepEqual(dag.get('repo-frontend'), ['repo-api']);
    // repo-api has no cross-repo dependencies
    assert.deepEqual(dag.get('repo-api'), []);
  });

  it('deduplicates when multiple stories create the same repo-level edge', () => {
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', [], 'repo-api'),
      story('story-001-003', ['story-001-001', 'story-001-002'], 'repo-frontend'),
    ];
    const dag = buildRepoDag(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    // Should appear only once even though two story deps both go to repo-api
    assert.deepEqual(dag.get('repo-frontend'), ['repo-api']);
  });

  it('deduplicates repo-level edge when two stories in the same repo both depend on the same producer', () => {
    // Two different stories in repo-x each independently depend on repo-a.
    // The repo-level edge repo-x→repo-a should appear exactly once (Set dedup).
    const m = manifest([entry('repo-a'), entry('repo-x')]);
    const stories = [
      story('s-a-001', [], 'repo-a'),
      story('s-x-001', ['s-a-001'], 'repo-x'),
      story('s-x-002', ['s-a-001'], 'repo-x'),
    ];
    const dag = buildRepoDag(stories, m, 'repo-a');
    assert.equal(dag.get('repo-x')?.length, 1, 'repo-level edge appears exactly once despite two story deps');
    assert.deepEqual(dag.get('repo-x'), ['repo-a']);
  });
});

// ── 3. isDepReady — same-repo behavior unchanged ──────────────────────────────

describe('isDepReady — same-repo (regression: today\'s behavior)', () => {
  const s = story('story-001-002', ['story-001-001'], 'repo-api');
  const dep = story('story-001-001', [], 'repo-api');

  it('returns true when dep.status is "done"', () => {
    assert.equal(isDepReady(s, dep, 'done', undefined, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), true);
  });

  it('returns true when dep.status is "pr_open" (matches Supervisor SUCCESS set)', () => {
    assert.equal(isDepReady(s, dep, 'pr_open', undefined, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), true);
  });

  it('returns false when dep.status is "pending"', () => {
    assert.equal(isDepReady(s, dep, 'pending', undefined, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), false);
  });

  it('returns false when dep.status is "running"', () => {
    assert.equal(isDepReady(s, dep, 'running', undefined, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY), false);
  });

  it('does NOT gate on repo stage — same-repo dep ignores depRepoStageStatus', () => {
    // Even if we pass a non-'landed' repo stage, same-repo dep is still ready if story is done.
    assert.equal(
      isDepReady(s, dep, 'done', 'pending', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      true,
    );
    // Even if we pass 'landed' repo stage, same-repo dep is NOT ready if story is pending.
    assert.equal(
      isDepReady(s, dep, 'pending', 'landed', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      false,
    );
  });
});

// ── 4. isDepReady — cross-repo: gates on repo stage, NOT dep story status ─────

describe('isDepReady — cross-repo (gates on repo stage reaching "landed")', () => {
  const consumer = story('story-001-002', ['story-001-001'], 'repo-frontend');
  const producer = story('story-001-001', [], 'repo-api');

  it('returns false when repo stage is "pending"', () => {
    assert.equal(
      isDepReady(consumer, producer, 'done', 'pending', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      false,
    );
  });

  it('returns false when repo stage is "running"', () => {
    assert.equal(
      isDepReady(consumer, producer, 'done', 'running', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      false,
    );
  });

  it('returns false when repo stage is "finalizing"', () => {
    assert.equal(
      isDepReady(consumer, producer, 'done', 'finalizing', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      false,
    );
  });

  it('returns false when repo stage is "awaiting_merge"', () => {
    assert.equal(
      isDepReady(consumer, producer, 'done', 'awaiting_merge', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      false,
    );
  });

  it('returns true when repo stage is "landed"', () => {
    assert.equal(
      isDepReady(consumer, producer, 'done', 'landed', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      true,
    );
  });

  it('cross-repo dep is NOT satisfied when dep story is "done" but stage is not landed', () => {
    // Key negative test: producer story done, but repo stage not yet landed → not ready
    assert.equal(
      isDepReady(consumer, producer, 'done', 'awaiting_merge', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      false,
    );
  });

  it('cross-repo dep is NOT ready when depRepoStageStatus is undefined', () => {
    assert.equal(
      isDepReady(consumer, producer, 'done', undefined, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      false,
    );
  });
});

// ── 5. Consumer NOT dispatchable until producer stage lands ───────────────────

describe('consumer dispatchability vs producer stage', () => {
  const consumer = story('story-001-002', ['story-001-001'], 'repo-frontend');
  const producer = story('story-001-001', [], 'repo-api');

  const NOT_LANDED: Array<string | undefined> = [
    'pending', 'running', 'finalizing', 'awaiting_merge', 'merged_gating', 'gated', 'partial_landing', 'failed', undefined,
  ];

  for (const stage of NOT_LANDED) {
    it(`consumer is NOT dispatchable when producer stage is "${stage}"`, () => {
      assert.equal(
        isDepReady(consumer, producer, 'done', stage as any, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
        false,
        `expected false for producer stage "${stage}"`,
      );
    });
  }

  it('consumer BECOMES dispatchable once producer stage reaches "landed"', () => {
    assert.equal(
      isDepReady(consumer, producer, 'done', 'landed', TWO_REPO_MANIFEST, TWO_REPO_PRIMARY),
      true,
    );
  });
});

// ── 6. Single-repo regression — no "landed" gating ever consulted ─────────────

describe('single-repo epic — no cross-repo gating (regression)', () => {
  it('all deps are same-repo and schedule in today\'s order with no landed gating', () => {
    const s1 = story('story-001-001');
    const s2 = story('story-001-002', ['story-001-001']);
    const s3 = story('story-001-003', ['story-001-002']);

    // s2 ready after s1 done (no repo stage consulted)
    assert.equal(isDepReady(s2, s1, 'done', undefined, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY), true);
    assert.equal(isDepReady(s2, s1, 'pending', undefined, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY), false);

    // s3 ready after s2 done (no repo stage consulted)
    assert.equal(isDepReady(s3, s2, 'done', undefined, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY), true);
    assert.equal(isDepReady(s3, s2, 'running', undefined, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY), false);

    // The DAG has no cross-repo edges
    const dag = buildRepoDag([s1, s2, s3], SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY);
    assert.deepEqual(dag.get('repo-mono'), []);
  });

  it('validateCrossRepoEdges finds no errors in a single-repo epic', () => {
    const stories = [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ];
    const errors = validateCrossRepoEdges(stories, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY);
    assert.deepEqual(errors, []);
  });
});

// ── 7. validateCrossRepoEdges — planner validation ───────────────────────────

describe('validateCrossRepoEdges — accepts valid producer→consumer edges', () => {
  it('accepts a two-repo epic where consumer depends on producer', () => {
    const stories = [
      story('story-001-001', [], 'repo-api'),            // producer
      story('story-001-002', ['story-001-001'], 'repo-frontend'),  // consumer
    ];
    const errors = validateCrossRepoEdges(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    assert.deepEqual(errors, []);
  });

  it('accepts a multi-hop producer→consumer chain', () => {
    const threeRepoManifest = manifest([
      entry('repo-db'), entry('repo-api'), entry('repo-frontend'),
    ]);
    const stories = [
      story('story-001-001', [], 'repo-db'),
      story('story-001-002', ['story-001-001'], 'repo-api'),
      story('story-001-003', ['story-001-002'], 'repo-frontend'),
    ];
    const errors = validateCrossRepoEdges(stories, threeRepoManifest, 'repo-db');
    assert.deepEqual(errors, []);
  });
});

describe('validateCrossRepoEdges — rejects consumer→producer (cycle) edges', () => {
  it('rejects a two-repo mutual dependency (A depends on B, B depends on A)', () => {
    const stories = [
      story('story-001-001', ['story-001-002'], 'repo-api'),        // api depends on frontend
      story('story-001-002', ['story-001-001'], 'repo-frontend'),   // frontend depends on api
    ];
    const errors = validateCrossRepoEdges(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    assert.ok(errors.length > 0, 'expected at least one error for mutual dependency');
    // All errors involve both repos
    for (const e of errors) {
      assert.ok(
        e.reason.includes('cycle'),
        `expected "cycle" in error reason, got: "${e.reason}"`,
      );
    }
  });

  it('reports the specific repos that form the cycle', () => {
    const stories = [
      story('story-001-001', ['story-001-002'], 'repo-api'),
      story('story-001-002', ['story-001-001'], 'repo-frontend'),
    ];
    const errors = validateCrossRepoEdges(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    // Pin exact direction: repo-api declares a dep on repo-frontend → repo-api is consumer
    assert.ok(
      errors.some(e => e.consumerSlug === 'repo-api' && e.producerSlug === 'repo-frontend'),
      'expected error with consumerSlug=repo-api, producerSlug=repo-frontend',
    );
    // Pin exact direction: repo-frontend declares a dep on repo-api → repo-frontend is consumer
    assert.ok(
      errors.some(e => e.consumerSlug === 'repo-frontend' && e.producerSlug === 'repo-api'),
      'expected error with consumerSlug=repo-frontend, producerSlug=repo-api',
    );
  });

  it('rejects a three-repo cycle (A→C→B→A) and reports all three error pairs', () => {
    // Integration path: validateCrossRepoEdges → buildRepoDag → findReposInCycles.
    // Verifies the pipeline marks all three SCC members and emits one error per
    // directed edge that participates in the cycle.
    const threeRepoManifest = manifest([
      entry('repo-a'), entry('repo-b'), entry('repo-c'),
    ]);
    const stories = [
      story('story-001-001', ['story-001-003'], 'repo-a'),  // a depends on c
      story('story-001-002', ['story-001-001'], 'repo-b'),  // b depends on a
      story('story-001-003', ['story-001-002'], 'repo-c'),  // c depends on b — cycle!
    ];
    const errors = validateCrossRepoEdges(stories, threeRepoManifest, 'repo-a');
    assert.ok(errors.length > 0, 'expected errors for three-repo cycle');
    // All three directed edges in the cycle must appear as errors.
    assert.ok(
      errors.some(e => e.consumerSlug === 'repo-a' && e.producerSlug === 'repo-c'),
      'expected edge repo-a→repo-c to be reported',
    );
    assert.ok(
      errors.some(e => e.consumerSlug === 'repo-b' && e.producerSlug === 'repo-a'),
      'expected edge repo-b→repo-a to be reported',
    );
    assert.ok(
      errors.some(e => e.consumerSlug === 'repo-c' && e.producerSlug === 'repo-b'),
      'expected edge repo-c→repo-b to be reported',
    );
  });

  it('accepts one valid and one cycled chain independently', () => {
    // repo-api → repo-db (valid chain); repo-frontend ↔ repo-api (cycled)
    // This tests that only the cycled repos are reported, not the clean chain.
    const m = manifest([
      entry('repo-db'), entry('repo-api'), entry('repo-frontend'),
    ]);
    const stories = [
      story('story-001-001', [], 'repo-db'),
      story('story-001-002', ['story-001-001'], 'repo-api'),            // api depends on db — valid
      story('story-001-003', ['story-001-002'], 'repo-frontend'),       // frontend depends on api
      story('story-001-004', ['story-001-003'], 'repo-api'),            // api ALSO depends on frontend — cycle!
    ];
    const errors = validateCrossRepoEdges(stories, m, 'repo-db');
    assert.ok(errors.length > 0, 'expected errors for api↔frontend cycle');
    // repo-db should NOT appear in errors (it has no cycle)
    const involvedRepos = errors.map(e => e.reason).join(' ');
    assert.ok(!involvedRepos.includes('"repo-db"'), 'repo-db should not appear in cycle errors');
  });

  it('does not report ancestor repos that merely have a path into a cycle (hub→api↔frontend)', () => {
    // hub depends on api; api↔frontend form a cycle; hub is NOT in the cycle.
    // This is the ancestor-contamination case: a naive DFS propagation would
    // incorrectly mark hub as a cycle member.
    const m = manifest([
      entry('repo-hub'), entry('repo-api'), entry('repo-frontend'),
    ]);
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', [], 'repo-frontend'),
      // hub depends on api (valid, one-way dependency)
      story('story-001-003', ['story-001-001'], 'repo-hub'),
      // api ALSO depends on frontend, creating the api↔frontend cycle
      story('story-001-004', ['story-001-002'], 'repo-api'),
      // frontend depends on api, completing the cycle
      story('story-001-005', ['story-001-001'], 'repo-frontend'),
    ];
    const errors = validateCrossRepoEdges(stories, m, 'repo-hub');
    assert.ok(errors.length > 0, 'expected errors for api↔frontend cycle');
    // repo-hub should NOT appear in errors — it is an ancestor of the cycle, not a member
    for (const e of errors) {
      assert.ok(
        !e.reason.includes('"repo-hub"'),
        `repo-hub should not appear in cycle error: "${e.reason}"`,
      );
      assert.notEqual(e.consumerSlug, 'repo-hub', 'repo-hub should not be a consumerSlug');
      assert.notEqual(e.producerSlug, 'repo-hub', 'repo-hub should not be a producerSlug');
    }
  });
});

// ── 8. N-repo generalization — AC1/AC3/AC4 ───────────────────────────────────

describe('buildRepoDag — N-repo generalization (AC1/AC3/AC4)', () => {
  // AC4: ≥3-repo branching graph — one producer Y depended on by two consumers X and Z.
  // Asserts the full key set and each edge list exactly.
  it('fan-out: one producer Y depended on by two consumers X and Z', () => {
    const m = manifest([entry('repo-y'), entry('repo-x'), entry('repo-z')]);
    const stories = [
      story('s-y-001', [], 'repo-y'),               // producer (root)
      story('s-x-001', ['s-y-001'], 'repo-x'),      // consumer 1 → Y
      story('s-z-001', ['s-y-001'], 'repo-z'),      // consumer 2 → Y
    ];
    const dag = buildRepoDag(stories, m, 'repo-y');

    // AC1: exactly the declared repository nodes
    assert.deepEqual(
      [...dag.keys()].sort(),
      ['repo-x', 'repo-y', 'repo-z'],
      'keys must be exactly the three participating repos',
    );

    // AC4: exact edge lists
    assert.deepEqual(dag.get('repo-x'), ['repo-y'], 'repo-x depends on repo-y');
    assert.deepEqual(dag.get('repo-z'), ['repo-y'], 'repo-z depends on repo-y');
    assert.deepEqual(dag.get('repo-y'), [], 'repo-y is a root with no producers');
  });

  // Fan-in shape: one consumer X with two producers A and B.
  it('fan-in: one consumer X with two producers A and B', () => {
    const m = manifest([entry('repo-a'), entry('repo-b'), entry('repo-x')]);
    const stories = [
      story('s-a-001', [], 'repo-a'),                          // producer A
      story('s-b-001', [], 'repo-b'),                          // producer B
      story('s-x-001', ['s-a-001', 's-b-001'], 'repo-x'),     // consumer depends on both
    ];
    const dag = buildRepoDag(stories, m, 'repo-a');

    assert.deepEqual(
      [...dag.keys()].sort(),
      ['repo-a', 'repo-b', 'repo-x'],
      'keys must be exactly the three participating repos',
    );
    assert.deepEqual(dag.get('repo-a'), [], 'repo-a is a root');
    assert.deepEqual(dag.get('repo-b'), [], 'repo-b is a root');
    // repo-x→[repo-a, repo-b] — compare as sets since insertion order is story-dep order
    assert.deepEqual(
      [...(dag.get('repo-x') ?? [])].sort(),
      ['repo-a', 'repo-b'],
      'repo-x depends on both repo-a and repo-b',
    );
  });

  // AC3: N=2 collapses to a single-edge special case of the same Map.
  it('N=2: single producer→consumer edge (AC3 special case)', () => {
    const stories = [
      story('s-api-001', [], 'repo-api'),
      story('s-fe-001', ['s-api-001'], 'repo-frontend'),
    ];
    const dag = buildRepoDag(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);

    assert.equal(dag.size, 2, 'exactly two entries');
    assert.deepEqual(dag.get('repo-frontend'), ['repo-api'], 'single consumer→producer edge');
    assert.deepEqual(dag.get('repo-api'), [], 'producer is a root');
  });

  // AC3: N=1 produces no inter-repo edges.
  it('N=1: single-repo epic produces no inter-repo edges (AC3)', () => {
    const stories = [
      story('s-001', [], undefined),
      story('s-002', ['s-001'], undefined),
    ];
    const dag = buildRepoDag(stories, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY);

    assert.equal(dag.size, 1, 'exactly one entry (the single repo)');
    assert.deepEqual(dag.get('repo-mono'), [], 'no edges for a single-repo epic');
  });

  // Same-repo edges explicitly dropped; assert full key set.
  it('same-repo story deps produce no repo-level edge (ADR-008)', () => {
    const m = manifest([entry('repo-a'), entry('repo-b')]);
    const stories = [
      story('s-a-001', [], 'repo-a'),
      story('s-a-002', ['s-a-001'], 'repo-a'),       // intra-repo dep — must be dropped
      story('s-b-001', ['s-a-002'], 'repo-b'),       // cross-repo dep → repo-a
    ];
    const dag = buildRepoDag(stories, m, 'repo-a');

    assert.deepEqual([...dag.keys()].sort(), ['repo-a', 'repo-b'], 'both repos are nodes');
    assert.deepEqual(dag.get('repo-a'), [], 'no self-edge for repo-a');
    assert.deepEqual(dag.get('repo-b'), ['repo-a'], 'repo-b→repo-a cross-repo edge');
  });

  // Inference boundary (ADR-008): a missing story dep yields NO repo-level edge.
  it('inference boundary: missing story dep ID yields no repo edge (ADR-008)', () => {
    const m = manifest([entry('repo-a'), entry('repo-b')]);
    const stories = [
      story('s-a-001', [], 'repo-a'),
      // s-b-001 lists a dep that doesn't exist in stories — no edge should appear
      story('s-b-001', ['nonexistent-dep-id'], 'repo-b'),
    ];
    const dag = buildRepoDag(stories, m, 'repo-a');

    assert.deepEqual([...dag.keys()].sort(), ['repo-a', 'repo-b'], 'both repos are nodes');
    assert.deepEqual(dag.get('repo-a'), [], 'repo-a has no producers');
    assert.deepEqual(dag.get('repo-b'), [], 'missing dep produces no edge — ADR-008 known trade-off');
  });

  // Multi-hop chain: A→B→C
  it('multi-hop chain A→B→C: three repos in a line', () => {
    const m = manifest([entry('repo-a'), entry('repo-b'), entry('repo-c')]);
    const stories = [
      story('s-a-001', [], 'repo-a'),
      story('s-b-001', ['s-a-001'], 'repo-b'),
      story('s-c-001', ['s-b-001'], 'repo-c'),
    ];
    const dag = buildRepoDag(stories, m, 'repo-a');

    assert.deepEqual([...dag.keys()].sort(), ['repo-a', 'repo-b', 'repo-c']);
    assert.deepEqual(dag.get('repo-a'), []);
    assert.deepEqual(dag.get('repo-b'), ['repo-a']);
    assert.deepEqual(dag.get('repo-c'), ['repo-b']);
  });
});

// ── 9. findReposInCycles — exported API ──────────────────────────────────────

describe('findReposInCycles — exported function', () => {
  it('returns empty set for an acyclic DAG', () => {
    const dag = new Map([
      ['repo-a', []],
      ['repo-b', ['repo-a']],
      ['repo-c', ['repo-b']],
    ]);
    assert.deepEqual(findReposInCycles(dag), new Set());
  });

  it('returns cycle members for a two-node mutual cycle', () => {
    const dag = new Map([
      ['repo-a', ['repo-b']],
      ['repo-b', ['repo-a']],
    ]);
    const inCycle = findReposInCycles(dag);
    assert.ok(inCycle.has('repo-a'), 'repo-a is in the cycle');
    assert.ok(inCycle.has('repo-b'), 'repo-b is in the cycle');
  });

  it('does not mark ancestors that merely have a path into a cycle', () => {
    // repo-root → repo-a ↔ repo-b (cycle); repo-root is NOT in the cycle
    const dag = new Map([
      ['repo-root', ['repo-a']],
      ['repo-a', ['repo-b']],
      ['repo-b', ['repo-a']],
    ]);
    const inCycle = findReposInCycles(dag);
    assert.ok(!inCycle.has('repo-root'), 'repo-root is an ancestor, not a cycle member');
    assert.ok(inCycle.has('repo-a'), 'repo-a is in the cycle');
    assert.ok(inCycle.has('repo-b'), 'repo-b is in the cycle');
  });

  it('marks a self-loop as a cycle member', () => {
    const dag = new Map([['repo-a', ['repo-a']]]);
    const inCycle = findReposInCycles(dag);
    assert.ok(inCycle.has('repo-a'), 'a self-loop makes the node a cycle member');
  });

  it('marks ALL three nodes in a 3-node cycle A→C→B→A (DFS marks the full SCC)', () => {
    // Verifies the path-stack DFS marks every node in the SCC, not just one representative.
    // Cycle: a depends on c, c depends on b, b depends on a → a→c→b→a
    const dag = new Map([
      ['repo-a', ['repo-c']],
      ['repo-c', ['repo-b']],
      ['repo-b', ['repo-a']],
    ]);
    const inCycle = findReposInCycles(dag);
    assert.ok(inCycle.has('repo-a'), 'repo-a is in the cycle');
    assert.ok(inCycle.has('repo-b'), 'repo-b is in the cycle');
    assert.ok(inCycle.has('repo-c'), 'repo-c is in the cycle');
    assert.equal(inCycle.size, 3, 'exactly three nodes should be marked');
  });
});
