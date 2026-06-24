import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCrossRepoEdge,
  buildRepoDag,
  isDepReady,
  validateCrossRepoEdges,
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
    'pending', 'running', 'finalizing', 'awaiting_merge', 'gated', 'partial_landing', 'failed', undefined,
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

  it('reports the specific stories that form the cycle', () => {
    const stories = [
      story('story-001-001', ['story-001-002'], 'repo-api'),
      story('story-001-002', ['story-001-001'], 'repo-frontend'),
    ];
    const errors = validateCrossRepoEdges(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    const storyIds = errors.map(e => e.storyId);
    const depIds = errors.map(e => e.depId);
    // Both stories should appear as either storyId or depId
    assert.ok(
      storyIds.includes('story-001-001') || depIds.includes('story-001-001'),
      'expected story-001-001 to appear in errors',
    );
    assert.ok(
      storyIds.includes('story-001-002') || depIds.includes('story-001-002'),
      'expected story-001-002 to appear in errors',
    );
  });

  it('rejects a three-repo cycle (A→B→C→A)', () => {
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
      assert.notEqual(e.storyId, 'story-001-003', 'hub story should not be reported');
    }
  });
});
