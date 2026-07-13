import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicySchema } from '../types.js';
import { maxConcurrentAdvisory } from '../orchestrator/configWarnings.js';

function policy(agents: Record<string, unknown>) {
  return PolicySchema.parse({ agents });
}

// ── on-alias: baked fields stripped (story-094-003) ──────────────────────────

describe('on-alias fields removed: qa_planning and integration_branch are silently stripped', () => {
  it('qa_planning is absent from the parsed result (field removed)', () => {
    const p = policy({ qa_planning: 'advisory' });
    assert.ok(!('qa_planning' in p.agents), 'qa_planning must be stripped');
  });

  it('integration_branch is absent from the parsed result (field removed)', () => {
    const p = policy({ integration_branch: 'rolling' });
    assert.ok(!('integration_branch' in p.agents), 'integration_branch must be stripped');
  });

  it('qa_planning with any value does not cause a parse error', () => {
    assert.doesNotThrow(() => policy({ qa_planning: 'bogus' }));
  });

  it('integration_branch with any value does not cause a parse error', () => {
    assert.doesNotThrow(() => policy({ integration_branch: 'yes' }));
  });
});

// ── max_concurrent cap removal ────────────────────────────────────────────────

describe('max_concurrent cap removal', () => {
  it('accepts values > 10 (no upper cap)', () => {
    const p = policy({ max_concurrent: 500 });
    assert.equal(p.agents.max_concurrent, 500);
  });

  it('accepts 1 (min boundary)', () => {
    const p = policy({ max_concurrent: 1 });
    assert.equal(p.agents.max_concurrent, 1);
  });

  it('rejects 0', () => {
    const result = PolicySchema.safeParse({ agents: { max_concurrent: 0 } });
    assert.equal(result.success, false);
  });

  it('rejects negatives', () => {
    const result = PolicySchema.safeParse({ agents: { max_concurrent: -5 } });
    assert.equal(result.success, false);
  });

  it('existing policies with max_concurrent <= 10 still validate (NFR-1)', () => {
    for (const val of [1, 5, 10]) {
      const p = policy({ max_concurrent: val });
      assert.equal(p.agents.max_concurrent, val);
    }
  });
});

// ── maxConcurrentAdvisory ─────────────────────────────────────────────────────

describe('maxConcurrentAdvisory', () => {
  it('returns undefined when max_concurrent is at threshold (boundary)', () => {
    // threshold = max(1, 4-2) = 2
    const p = policy({ max_concurrent: 2 });
    const w = maxConcurrentAdvisory(p, 4);
    assert.equal(w, undefined);
  });

  it('returns a warning string one above threshold', () => {
    // threshold = max(1, 4-2) = 2; max_concurrent=3 triggers warning
    const p = policy({ max_concurrent: 3 });
    const w = maxConcurrentAdvisory(p, 4);
    assert.equal(typeof w, 'string');
    assert.match(w!, /3/);
    assert.match(w!, /2/);
  });

  it('names max_concurrent value and threshold in warning', () => {
    const p = policy({ max_concurrent: 15 });
    const w = maxConcurrentAdvisory(p, 8);
    // threshold = max(1, 8-2) = 6
    assert.equal(typeof w, 'string');
    assert.match(w!, /15/);
    assert.match(w!, /6/);
  });

  it('clamps threshold to 1 when cpuCount <= 3 (floor case)', () => {
    // cpuCount=2 → threshold = max(1, 2-2) = max(1, 0) = 1
    const p = policy({ max_concurrent: 2 });
    const w = maxConcurrentAdvisory(p, 2);
    assert.equal(typeof w, 'string');
    assert.match(w!, /1/);
  });

  it('does not warn when max_concurrent equals 1 (min) with cpuCount=2', () => {
    const p = policy({ max_concurrent: 1 });
    const w = maxConcurrentAdvisory(p, 2);
    assert.equal(w, undefined);
  });

  it('never mutates the policy (ADR-5)', () => {
    const p = policy({ max_concurrent: 100 });
    maxConcurrentAdvisory(p, 4);
    assert.equal(p.agents.max_concurrent, 100);
  });
});
