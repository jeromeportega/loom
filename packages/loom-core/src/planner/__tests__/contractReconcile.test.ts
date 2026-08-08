import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileProvidesRequires,
  isClosureFailure,
  describeClosureViolation,
  summarizeClosureFailures,
} from '../contractReconcile.js';
import type { Story } from '../../types.js';

/** Minimal valid Story; only the fields the reconciler reads matter. */
function story(p: Partial<Story> & Pick<Story, 'id'>): Story {
  return {
    id: p.id,
    title: p.title ?? `Story ${p.id} title`,
    description: p.description ?? 'description',
    acceptance_criteria: p.acceptance_criteria ?? ['does the thing'],
    estimated_complexity: p.estimated_complexity ?? 'small',
    dependencies: p.dependencies ?? [],
    ...(p.provides ? { provides: p.provides } : {}),
    ...(p.requires ? { requires: p.requires } : {}),
    ...(p.repo ? { repo: p.repo } : {}),
  };
}

const A = 'story-001';
const B = 'story-002';
const C = 'story-003';

describe('reconcileProvidesRequires', () => {
  it('passes a clean plan: requires resolves to a providing, ordered source', () => {
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { token: 'string' } }),
      story({ id: B, requires: { token: A }, dependencies: [A] }),
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  it('is a no-op (byte-identical baseline) when no story declares requires', () => {
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { token: 'x' } }),
      story({ id: B, dependencies: [A] }),
    ]);
    assert.deepEqual(r, { ok: true, violations: [] });
  });

  it('FAILS missing-source: requires a story not in the run', () => {
    const r = reconcileProvidesRequires([
      story({ id: B, requires: { token: 'story-999' }, dependencies: [] }),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, 'missing-source');
    assert.equal(r.violations[0].sourceStoryId, 'story-999');
    assert.equal(r.violations[0].key, 'token');
  });

  it('FAILS missing-provide: source exists but does not declare the key', () => {
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { other: 'x' } }),
      story({ id: B, requires: { token: A }, dependencies: [A] }),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].kind, 'missing-provide');
  });

  it('FAILS missing-provide when the source declares NO provides at all', () => {
    const r = reconcileProvidesRequires([
      story({ id: A }),
      story({ id: B, requires: { token: A }, dependencies: [A] }),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].kind, 'missing-provide');
  });

  it('FAILS self-require: a story requiring its own output can never resolve', () => {
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { token: 'x' }, requires: { token: A } }),
    ]);
    assert.equal(r.ok, false);
    const kinds = r.violations.map((v) => v.kind);
    assert.ok(kinds.includes('self-require'));
    // A self-edge is excluded from the cycle graph, so it is NOT double-reported.
    assert.ok(!kinds.includes('deadlock-cycle'));
  });

  it('FAILS deadlock-cycle: mutual requires with no dependency edges deadlocks', () => {
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { a: 'x' }, requires: { b: B } }),
      story({ id: B, provides: { b: 'x' }, requires: { a: A } }),
    ]);
    assert.equal(r.ok, false);
    const cycle = r.violations.find((v) => v.kind === 'deadlock-cycle');
    assert.ok(cycle, 'a deadlock-cycle violation is reported');
    assert.ok((cycle!.cyclePath ?? []).length >= 3, 'cycle path is the loop (first id repeated)');
    // Cycle members do not ALSO produce redundant `unordered` warnings.
    assert.ok(!r.violations.some((v) => v.kind === 'unordered'));
  });

  it('FAILS deadlock-cycle: reverse-ordered cross-channel loop (dep one way, requires the other)', () => {
    // The exact adversarial case: story-001 depends on story-002, while story-002
    // requires an output from story-001. Neither the requires-only nor the
    // dependency-only cycle check sees it, but it is a guaranteed runtime deadlock
    // (both stories end 'blocked'). It must FAIL, not warn.
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { token: 'x' }, dependencies: [B] }),
      story({ id: B, requires: { token: A }, dependencies: [] }),
    ]);
    assert.equal(r.ok, false, 'a reverse-ordered cross-channel cycle must fail the plan');
    assert.ok(r.violations.some((v) => v.kind === 'deadlock-cycle'));
    // The reverse-order pair is reported as a cycle, not a non-fatal `unordered`.
    assert.ok(!r.violations.some((v) => v.kind === 'unordered'));
  });

  it('FAILS deadlock-cycle: 3-node mixed loop (A dep B, B requires C, C dep A)', () => {
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { ka: 'x' }, dependencies: [B] }),
      story({ id: B, provides: { kb: 'x' }, requires: { kc: C } }),
      story({ id: C, provides: { kc: 'x' }, dependencies: [A] }),
    ]);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'deadlock-cycle'));
  });

  it('FAILS a plan with two independent deadlock cycles (sound: rejects, ≥1 labeled)', () => {
    // dfsColorMark reports the first back-edge only, so exactly one cycle is
    // labeled deadlock-cycle per pass; the plan is still correctly rejected and
    // the second cycle surfaces on the next iterate. Assert the soundness
    // guarantee (ok:false + at least one deadlock-cycle), not exhaustive labeling.
    const r = reconcileProvidesRequires([
      story({ id: 'story-001', provides: { a: 'x' }, dependencies: ['story-002'] }),
      story({ id: 'story-002', requires: { a: 'story-001' } }),
      story({ id: 'story-003', provides: { c: 'x' }, dependencies: ['story-004'] }),
      story({ id: 'story-004', requires: { c: 'story-003' } }),
    ]);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'deadlock-cycle'));
  });

  it('suppression is scoped: a genuine unordered pair still warns alongside a separate cycle', () => {
    // Cycle {X,Y}; a distinct, cycle-free unordered pair P←Q. The unordered
    // warning for Q must NOT be suppressed (its endpoints are not cycle members).
    const r = reconcileProvidesRequires([
      story({ id: 'story-010', provides: { x: 'v' }, dependencies: ['story-011'] }),
      story({ id: 'story-011', requires: { x: 'story-010' } }), // cycle with 010
      story({ id: 'story-020', provides: { p: 'v' } }),
      story({ id: 'story-021', requires: { p: 'story-020' }, dependencies: [] }), // unordered, no cycle
    ]);
    assert.equal(r.ok, false); // the cycle fails the plan
    assert.ok(r.violations.some((v) => v.kind === 'deadlock-cycle'));
    const unordered = r.violations.filter((v) => v.kind === 'unordered');
    assert.ok(
      unordered.some((v) => v.storyId === 'story-021' && v.sourceStoryId === 'story-020'),
      'the cycle-free unordered pair still warns',
    );
  });

  it('WARNS (does not fail) on unordered: source provides the key but is not a dependency', () => {
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { token: 'x' } }),
      story({ id: B, requires: { token: A }, dependencies: [] }), // no edge to A
    ]);
    assert.equal(r.ok, true, 'unordered is advisory, not a failure');
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, 'unordered');
    assert.equal(isClosureFailure(r.violations[0]), false);
  });

  it('accepts a transitive ordering path (no unordered warning)', () => {
    // C requires from A; C depends on B; B depends on A → C transitively orders after A.
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { token: 'x' } }),
      story({ id: B, dependencies: [A] }),
      story({ id: C, requires: { token: A }, dependencies: [B] }),
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  it('resolves across epics (universe = union of all stories in the run)', () => {
    // A is an epic-1 story; the epic-2 story requires from it. Global id resolves.
    const r = reconcileProvidesRequires([
      story({ id: 'story-001', provides: { token: 'x' } }),
      story({ id: 'story-014', requires: { token: 'story-001' }, dependencies: ['story-001'] }),
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  it('reports every failure across a mixed plan and stays ok:false', () => {
    const r = reconcileProvidesRequires([
      story({ id: A, provides: { good: 'x' } }),
      story({ id: B, requires: { good: A, bad: 'story-999' }, dependencies: [A] }),
      story({ id: C, requires: { self: C }, provides: { self: 'x' } }),
    ]);
    assert.equal(r.ok, false);
    const kinds = new Set(r.violations.map((v) => v.kind));
    assert.ok(kinds.has('missing-source'));
    assert.ok(kinds.has('self-require'));
    // `good` resolves and B depends on A → no missing-provide / unordered for it.
    assert.ok(!kinds.has('missing-provide'));
  });
});

describe('closure violation helpers', () => {
  it('isClosureFailure: only unordered is advisory', () => {
    const mk = (kind: string) => ({ kind, storyId: A } as never);
    assert.equal(isClosureFailure(mk('missing-source')), true);
    assert.equal(isClosureFailure(mk('missing-provide')), true);
    assert.equal(isClosureFailure(mk('self-require')), true);
    assert.equal(isClosureFailure(mk('deadlock-cycle')), true);
    assert.equal(isClosureFailure(mk('unordered')), false);
  });

  it('describeClosureViolation returns a non-empty line for every kind', () => {
    for (const kind of ['missing-source', 'missing-provide', 'self-require', 'unordered'] as const) {
      const s = describeClosureViolation({ kind, storyId: B, key: 'k', sourceStoryId: A });
      assert.ok(s.length > 0);
      assert.ok(s.includes(B));
    }
    const c = describeClosureViolation({ kind: 'deadlock-cycle', storyId: A, cyclePath: [A, B, A] });
    assert.ok(c.includes(A) && c.includes(B));
  });

  it('summarizeClosureFailures counts failures, excludes warnings, and truncates', () => {
    const result = reconcileProvidesRequires([
      story({ id: 'story-010', requires: { k: 'story-901' } }),
      story({ id: 'story-011', requires: { k: 'story-902' } }),
      story({ id: 'story-012', requires: { k: 'story-903' } }),
      story({ id: 'story-013', requires: { k: 'story-904' } }),
    ]);
    const s = summarizeClosureFailures(result);
    assert.match(s, /^reconciliation: 4 unsatisfiable story dependencies/);
    assert.match(s, /\+1 more$/); // 4 failures, first 3 detailed, +1 more
  });

  it('summarizeClosureFailures uses singular for exactly one failure', () => {
    const result = reconcileProvidesRequires([
      story({ id: 'story-010', requires: { k: 'story-901' } }),
    ]);
    assert.match(summarizeClosureFailures(result), /1 unsatisfiable story dependency —/);
  });
});
