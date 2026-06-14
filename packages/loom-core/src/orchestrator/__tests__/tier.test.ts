import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCostTier, tierSteps, type TierInputs } from '../tier.js';
import type { HeuristicSignals } from '../../types.js';

const cleanHeuristics: HeuristicSignals = {
  diff_lines: 20,
  diff_files: 2,
  tests_green_first_try: true,
  risky_paths_touched: [],
};

// All-positive inputs that resolve to `light`; individual tests perturb one field.
const lightInputs: TierInputs = {
  triage: { risk: 'low', predicted_complexity: 'low', rationale: 'trivial' },
  selfAssessment: { confidence: 'high', complexity: 'low' },
  heuristics: cleanHeuristics,
};

describe('resolveCostTier', () => {
  it('returns light when every positive signal lines up', () => {
    assert.equal(resolveCostTier(lightInputs), 'light');
  });

  it('a touched risky path forces heavy even with otherwise-light signals', () => {
    assert.equal(
      resolveCostTier({
        ...lightInputs,
        heuristics: { ...cleanHeuristics, risky_paths_touched: ['src/auth/login.ts'] },
      }),
      'heavy'
    );
  });

  it('a first-try test failure forces heavy (heuristics win over high confidence)', () => {
    assert.equal(
      resolveCostTier({
        ...lightInputs,
        heuristics: { ...cleanHeuristics, tests_green_first_try: false },
      }),
      'heavy'
    );
  });

  it('a large diff forces heavy', () => {
    assert.equal(
      resolveCostTier({ ...lightInputs, heuristics: { ...cleanHeuristics, diff_lines: 500 } }),
      'heavy'
    );
    assert.equal(
      resolveCostTier({ ...lightInputs, heuristics: { ...cleanHeuristics, diff_files: 20 } }),
      'heavy'
    );
  });

  it('low worker confidence forces heavy', () => {
    assert.equal(
      resolveCostTier({ ...lightInputs, selfAssessment: { confidence: 'low', complexity: 'low' } }),
      'heavy'
    );
  });

  it('a missing self-assessment is treated as low confidence → heavy (fail safe)', () => {
    assert.equal(resolveCostTier({ ...lightInputs, selfAssessment: undefined }), 'heavy');
  });

  it('high triage risk forces heavy', () => {
    assert.equal(
      resolveCostTier({
        ...lightInputs,
        triage: { risk: 'high', predicted_complexity: 'high', rationale: 'risky' },
      }),
      'heavy'
    );
  });

  it('medium confidence with clean heuristics is standard, not light', () => {
    assert.equal(
      resolveCostTier({ ...lightInputs, selfAssessment: { confidence: 'medium', complexity: 'medium' } }),
      'standard'
    );
  });

  it('high confidence but unknown tests (no heuristics) is standard, not light', () => {
    assert.equal(
      resolveCostTier({
        triage: { risk: 'low', predicted_complexity: 'low', rationale: 'x' },
        selfAssessment: { confidence: 'high', complexity: 'low' },
        heuristics: undefined,
      }),
      'standard'
    );
  });

  it('high confidence but tests unknown (null) is standard, not light', () => {
    assert.equal(
      resolveCostTier({
        ...lightInputs,
        heuristics: { ...cleanHeuristics, tests_green_first_try: null },
      }),
      'standard'
    );
  });
});

describe('tierSteps', () => {
  it('light keeps one reviewer and skips verify + skill-gen', () => {
    assert.deepEqual(tierSteps('light'), { reviewers: 1, verifyPhase: false, skillGen: false });
  });
  it('standard uses two reviewers and runs verify + skill-gen', () => {
    assert.deepEqual(tierSteps('standard'), { reviewers: 2, verifyPhase: true, skillGen: true });
  });
  it('heavy uses the full three-reviewer fan-out', () => {
    assert.deepEqual(tierSteps('heavy'), { reviewers: 3, verifyPhase: true, skillGen: true });
  });
});
