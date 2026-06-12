import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Investigation } from '../../src/findings/investigation.js';
import { routeByGrade } from '../../src/failure/router.js';

/** Build a schema-valid Investigation for a grade (the schema enforces the refine). */
function inv(grade: 'strong' | 'weak' | 'contradictory', extra: Record<string, unknown> = {}) {
  return Investigation.parse({
    grade,
    hypothesis: `hypothesis for ${grade}`,
    evidence_refs: ['stderr: boom'],
    ...extra,
  });
}

describe('routeByGrade — deterministic failure router', () => {
  it('strong -> retry-with-hint, carrying the investigator hint through', () => {
    const decision = routeByGrade(inv('strong', { hint: 'update auth.ts:42 to fetchUser' }));
    assert.deepEqual(decision, {
      kind: 'retry-with-hint',
      hint: 'update auth.ts:42 to fetchUser',
    });
  });

  it('weak -> surface-to-operator, reason from the hypothesis', () => {
    const decision = routeByGrade(inv('weak'));
    assert.deepEqual(decision, {
      kind: 'surface-to-operator',
      reason: 'hypothesis for weak',
    });
  });

  it('contradictory -> stop-epic, reason from the hypothesis', () => {
    const decision = routeByGrade(inv('contradictory'));
    assert.deepEqual(decision, {
      kind: 'stop-epic',
      reason: 'hypothesis for contradictory',
    });
  });

  it('every grade maps to a distinct dispatch kind', () => {
    const kinds = new Set([
      routeByGrade(inv('strong', { hint: 'h' })).kind,
      routeByGrade(inv('weak')).kind,
      routeByGrade(inv('contradictory')).kind,
    ]);
    assert.equal(kinds.size, 3, 'the three grades must not collapse onto the same dispatch');
  });

  it('is pure: same investigation -> identical decision, no state carried between calls', () => {
    const investigation = inv('strong', { hint: 'do the thing' });
    const a = routeByGrade(investigation);
    const b = routeByGrade(investigation);
    assert.deepEqual(a, b);
  });

  it('adds NO retry ceiling — a strong grade routes to retry-with-hint every time', () => {
    // The router is stateless: it never decides "enough retries." Bounding the
    // strong -> retry loop is the caller's existing per-story retry ceiling, so
    // the router must keep saying retry-with-hint no matter how many times it
    // is asked for the same strong evidence.
    const investigation = inv('strong', { hint: 'keep going' });
    for (let i = 0; i < 25; i++) {
      assert.equal(routeByGrade(investigation).kind, 'retry-with-hint');
    }
  });

  it('relies on the schema guaranteeing a hint for a strong grade', () => {
    // routeByGrade narrows the optional hint to string on the strong arm; that
    // is only safe because the Investigation schema rejects a hint-less strong.
    assert.throws(() =>
      Investigation.parse({ grade: 'strong', hypothesis: 'x', evidence_refs: [] }),
    );
  });
});
