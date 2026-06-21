import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { refineEvalCases } from '../refineEvalCases.js';
import type { IntakeEvalCase, RefinedCaseResult } from '../intakeEvalTypes.js';
import type { BriefRefiner } from '../../brief/BriefRefiner.js';
import type { BriefRefinement } from '../../brief/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCase(
  id: string,
  type: 'feature' | 'bug' | 'chore' = 'feature',
  size: 'story' | 'epic' = 'story',
): IntakeEvalCase {
  return {
    id,
    source: 'anchor',
    brief: `Raw brief for case ${id}.`,
    label: { type, size },
    rationale: `Rationale for case ${id}.`,
  };
}

function makeRefinement(refined_brief?: string, quality_score = 8): BriefRefinement {
  return {
    ready: true,
    original: 'original text',
    refined_brief,
    critique: {
      strong_points: [],
      ambiguities: [],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: [],
    quality_score,
    blocking_gaps: [],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };
}

/**
 * Minimal mock for BriefRefiner that records calls and returns scripted responses.
 * Uses the structural duck-typing that TypeScript's type system allows.
 */
class MockRefiner {
  readonly calls: string[] = [];
  private queue: Array<BriefRefinement | Error>;

  constructor(responses: Array<BriefRefinement | Error>) {
    this.queue = [...responses];
  }

  async refine(rough: string): Promise<BriefRefinement> {
    this.calls.push(rough);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('MockRefiner: queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
}

// Cast helper — MockRefiner satisfies the structural contract of BriefRefiner.
function asBriefRefiner(mock: MockRefiner): BriefRefiner {
  return mock as unknown as BriefRefiner;
}

// ── refineEvalCases — happy path ──────────────────────────────────────────────

describe('refineEvalCases — happy path: each case maps to ok:true result', () => {
  it('single case: brief replaced with refined_brief, label carried over (ADR-003)', async () => {
    const c = makeCase('a', 'bug', 'epic');
    const mock = new MockRefiner([makeRefinement('# Refined A\nBetter text.', 9)]);

    const results = await refineEvalCases([c], asBriefRefiner(mock));

    assert.equal(results.length, 1);
    const r = results[0];
    assert.ok(r.ok, 'result should be ok:true');
    if (!r.ok) return;

    assert.equal(r.case.brief, '# Refined A\nBetter text.', 'brief must be replaced');
    assert.equal(r.case.label.type, 'bug', 'label.type must be unchanged (ADR-003)');
    assert.equal(r.case.label.size, 'epic', 'label.size must be unchanged (ADR-003)');
    assert.equal(r.qualityScore, 9, 'qualityScore from refinement');
  });

  it('non-brief fields are carried over byte-for-byte (ADR-003)', async () => {
    const c = makeCase('carried', 'chore', 'story');
    c.brief_source = 'some-source-path';
    const mock = new MockRefiner([makeRefinement('# New brief', 7)]);

    const results = await refineEvalCases([c], asBriefRefiner(mock));

    assert.ok(results[0].ok);
    if (!results[0].ok) return;
    const refined = results[0].case;
    assert.equal(refined.id, 'carried');
    assert.equal(refined.source, 'anchor');
    assert.equal(refined.rationale, c.rationale);
    assert.equal(refined.brief_source, 'some-source-path');
    assert.equal(refined.label.type, 'chore');
    assert.equal(refined.label.size, 'story');
  });

  it('multiple cases: output length and order match input exactly (same N)', async () => {
    const cases = [
      makeCase('x', 'feature', 'story'),
      makeCase('y', 'bug', 'epic'),
      makeCase('z', 'chore', 'story'),
    ];
    const mock = new MockRefiner([
      makeRefinement('# Refined X', 6),
      makeRefinement('# Refined Y', 7),
      makeRefinement('# Refined Z', 8),
    ]);

    const results = await refineEvalCases(cases, asBriefRefiner(mock));

    assert.equal(results.length, 3, 'output length must match input length');
    assert.ok(results[0].ok && results[0].case.id === 'x', 'order preserved: first');
    assert.ok(results[1].ok && results[1].case.id === 'y', 'order preserved: second');
    assert.ok(results[2].ok && results[2].case.id === 'z', 'order preserved: third');
  });
});

// ── refineEvalCases — refiner returns no refined_brief ────────────────────────

describe('refineEvalCases — refiner returns no refined_brief', () => {
  it('yields ok:false with reason no_refined_brief (ADR-005)', async () => {
    const c = makeCase('underspecified');
    const mock = new MockRefiner([makeRefinement(undefined, 2)]);

    const results = await refineEvalCases([c], asBriefRefiner(mock));

    assert.equal(results.length, 1);
    const r = results[0];
    assert.ok(!r.ok, 'result must be ok:false');
    if (r.ok) return;
    assert.equal(r.caseId, 'underspecified');
    assert.equal(r.reason, 'no_refined_brief');
    assert.ok(r.detail.length > 0, 'detail must be non-empty');
  });

  it('refiner miss is interleaved correctly among ok results', async () => {
    const cases = [makeCase('a'), makeCase('b'), makeCase('c')];
    const mock = new MockRefiner([
      makeRefinement('# Refined A', 8),
      makeRefinement(undefined, 2),   // b has no refined_brief
      makeRefinement('# Refined C', 7),
    ]);

    const results = await refineEvalCases(cases, asBriefRefiner(mock));

    assert.equal(results.length, 3, 'same N as input');
    assert.ok(results[0].ok, 'a: ok');
    assert.ok(!results[1].ok, 'b: ok:false');
    assert.ok(results[2].ok, 'c: ok');
    if (!results[1].ok) {
      assert.equal(results[1].caseId, 'b');
      assert.equal(results[1].reason, 'no_refined_brief');
    }
  });
});

// ── refineEvalCases — refiner throws ─────────────────────────────────────────

describe('refineEvalCases — refiner throws', () => {
  it('yields ok:false with reason refiner_error, no unhandled rejection', async () => {
    const c = makeCase('boom');
    const mock = new MockRefiner([new Error('LLM transport failed')]);

    const results = await refineEvalCases([c], asBriefRefiner(mock));

    assert.equal(results.length, 1);
    const r = results[0];
    assert.ok(!r.ok, 'result must be ok:false on throw');
    if (r.ok) return;
    assert.equal(r.caseId, 'boom');
    assert.equal(r.reason, 'refiner_error');
    assert.ok(r.detail.includes('LLM transport failed'), 'detail carries the error message');
  });

  it('one throw does not prevent remaining cases from being processed', async () => {
    const cases = [makeCase('a'), makeCase('b')];
    const mock = new MockRefiner([
      new Error('first call fails'),
      makeRefinement('# Refined B', 9),
    ]);

    const results = await refineEvalCases(cases, asBriefRefiner(mock));

    assert.equal(results.length, 2, 'same N as input');
    assert.ok(!results[0].ok, 'a: ok:false on throw');
    assert.ok(results[1].ok, 'b: processed after a threw');
  });
});

// ── refineEvalCases — production BriefRefiner is reused (AC2) ────────────────

describe('refineEvalCases — production BriefRefiner reuse (AC2)', () => {
  it('calls refiner.refine exactly once per case', async () => {
    const cases = [makeCase('p'), makeCase('q'), makeCase('r')];
    const mock = new MockRefiner([
      makeRefinement('# P', 8),
      makeRefinement('# Q', 7),
      makeRefinement('# R', 6),
    ]);

    await refineEvalCases(cases, asBriefRefiner(mock));

    assert.equal(mock.calls.length, 3, 'exactly one refine() call per case (AC2)');
  });

  it('passes the raw brief from the case to refiner.refine', async () => {
    const c = makeCase('brief-check');
    const mock = new MockRefiner([makeRefinement('# Refined', 8)]);

    await refineEvalCases([c], asBriefRefiner(mock));

    assert.equal(mock.calls[0], c.brief, 'refiner receives the raw case brief');
  });

  it('empty cases array returns empty array without calling refiner', async () => {
    const mock = new MockRefiner([]);

    const results = await refineEvalCases([], asBriefRefiner(mock));

    assert.equal(results.length, 0);
    assert.equal(mock.calls.length, 0, 'refiner must not be called for empty input');
  });
});
