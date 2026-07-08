import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePlanningGate } from '../commands/epic.js';

// The planning-quality gate. It hard-fails ONLY a genuine Architect enrichment
// FAILURE (no tech_notes parsed after retries — the epic-086 contention case), not
// a valid-but-empty result. See epic.ts + ArchitectAgent tech_notes retry/failed.

describe('evaluatePlanningGate', () => {
  it('fails a multi-story plan when enrichment genuinely failed', () => {
    const gate = evaluatePlanningGate({
      isStandalone: false, storyCount: 7, storiesEnriched: 0, enrichmentFailed: true,
    });
    assert.equal(gate.outcome, 'fail');
    assert.match(gate.verdict, /enrichment failed \(0 of 7/);
  });

  it('does NOT fail on a valid-but-empty result (0 enriched, enrichment did not fail) — warns instead', () => {
    // The key distinction: a model that parsed cleanly but returned no notes is a
    // soft warning, not a hard block. (This is exactly what the planning-test mocks
    // produce, so the gate must not exit on them.)
    const gate = evaluatePlanningGate({
      isStandalone: false, storyCount: 2, storiesEnriched: 0, enrichmentFailed: false,
    });
    assert.equal(gate.outcome, 'warn');
  });

  it('passes a multi-story plan with full coverage', () => {
    const gate = evaluatePlanningGate({
      isStandalone: false, storyCount: 6, storiesEnriched: 6, enrichmentFailed: false,
    });
    assert.equal(gate.outcome, 'ok');
    assert.equal(gate.verdict, '');
  });

  it('warns on partial coverage but does not fail', () => {
    const gate = evaluatePlanningGate({
      isStandalone: false, storyCount: 7, storiesEnriched: 5, enrichmentFailed: false,
    });
    assert.equal(gate.outcome, 'warn');
    assert.match(gate.verdict, /2 of 7 stories are missing tech_notes/);
  });

  it('exempts a standalone story even if enrichment "failed" (its notes come from a separate path)', () => {
    const gate = evaluatePlanningGate({
      isStandalone: true, storyCount: 1, storiesEnriched: 0, enrichmentFailed: true,
    });
    assert.equal(gate.outcome, 'ok');
  });

  it('passes a zero-story plan (handled by other validation, not this gate)', () => {
    const gate = evaluatePlanningGate({
      isStandalone: false, storyCount: 0, storiesEnriched: 0, enrichmentFailed: false,
    });
    assert.equal(gate.outcome, 'ok');
  });
});
