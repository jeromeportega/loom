import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as constants from '../orchestrator/constants.js';
import * as coreIndex from '../index.js';

const CONSTANT_NAMES = Object.keys(constants) as Array<keyof typeof constants>;

describe('ConstantsPublicIndex — baked constants re-exported from @loom-ai/core', () => {
  it('all constants from constants.ts are present in the public index', () => {
    const missing: string[] = [];
    for (const name of CONSTANT_NAMES) {
      if (!(name in coreIndex)) {
        missing.push(name);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `These constants are missing from the public index: ${missing.join(', ')}`
    );
  });

  it('exports at least 33 baked constants', () => {
    assert.ok(
      CONSTANT_NAMES.length >= 33,
      `Expected at least 33 constants, got ${CONSTANT_NAMES.length}`
    );
  });

  it('REVIEW_STRATEGY is the string "block-and-revise"', () => {
    assert.equal(typeof coreIndex.REVIEW_STRATEGY, 'string');
    assert.equal(coreIndex.REVIEW_STRATEGY, 'block-and-revise');
  });

  it('INTEGRATION_GATE is the string "block"', () => {
    assert.equal(typeof coreIndex.INTEGRATION_GATE, 'string');
    assert.equal(coreIndex.INTEGRATION_GATE, 'block');
  });

  it('CROSS_REPO_ENABLED is boolean true', () => {
    assert.equal(typeof coreIndex.CROSS_REPO_ENABLED, 'boolean');
    assert.equal(coreIndex.CROSS_REPO_ENABLED, true);
  });

  it('REVIEW_MAX_PASSES is the number 3', () => {
    assert.equal(typeof coreIndex.REVIEW_MAX_PASSES, 'number');
    assert.equal(coreIndex.REVIEW_MAX_PASSES, 3);
  });

  it('STALL_RECOVERY_BUDGET is a number', () => {
    assert.equal(typeof coreIndex.STALL_RECOVERY_BUDGET, 'number');
  });

  it('SKILL_GENERATION is the string "on"', () => {
    assert.equal(typeof coreIndex.SKILL_GENERATION, 'string');
    assert.equal(coreIndex.SKILL_GENERATION, 'on');
  });
});
