/**
 * Documentation existence checks for epic-082 (story-082-005).
 * Verifies that capabilities.md, README.md, and docs/runbooks/finalize.md
 * document all three new checks and the adversarial_review_model policy knob.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CAPABILITIES = path.join(REPO_ROOT, 'docs', 'capabilities.md');
const README = path.join(REPO_ROOT, 'README.md');
const FINALIZE_RUNBOOK = path.join(REPO_ROOT, 'docs', 'runbooks', 'finalize.md');

describe('epic-082-005: docs/capabilities.md — new check rows and policy knob', () => {
  const doc = fs.readFileSync(CAPABILITIES, 'utf8');

  it('contains a row for the dead-policy-field check', () => {
    assert.match(
      doc,
      /dead-policy-field/i,
      'capabilities.md must contain a row for the dead-policy-field check'
    );
    assert.match(
      doc,
      /dead-policy-field[\s\S]{0,500}schema|schemas[\s\S]{0,500}dead-policy-field/i,
      'dead-policy-field row must reference the schema'
    );
  });

  it('contains a row for the no-production-caller check', () => {
    assert.match(
      doc,
      /no-production-caller/,
      'capabilities.md must contain a row for the no-production-caller check'
    );
  });

  it('contains a row for adversarial review mode', () => {
    assert.match(
      doc,
      /adversarial.*review|adversarial.*pass/i,
      'capabilities.md must contain a row for adversarial review mode'
    );
  });

  it('contains adversarial_review_model in the coverage:knob fence', () => {
    assert.match(
      doc,
      /<!-- coverage:knob:start -->[\s\S]*`policy\.agents\.adversarial_review_model`[\s\S]*<!-- coverage:knob:end -->/,
      'coverage:knob fence must include policy.agents.adversarial_review_model'
    );
  });

  it('adversarial review row mentions the policy knob name', () => {
    assert.match(
      doc,
      /adversarial_review_model/,
      'capabilities.md must mention the adversarial_review_model knob name'
    );
  });

  it('does not list dead-policy-field or no-production-caller under "What loom does NOT do"', () => {
    const notDoSection = doc.match(/## What loom does NOT do[\s\S]*?(?=##|$)/);
    if (notDoSection) {
      assert.doesNotMatch(
        notDoSection[0],
        /dead-policy-field/i,
        '"What loom does NOT do" must not list the dead-policy-field check'
      );
      assert.doesNotMatch(
        notDoSection[0],
        /no-production-caller/i,
        '"What loom does NOT do" must not list the no-production-caller check'
      );
      assert.doesNotMatch(
        notDoSection[0],
        /adversarial.*review/i,
        '"What loom does NOT do" must not list adversarial review'
      );
    }
  });
});

describe('epic-082-005: README.md — check types and knob', () => {
  const doc = fs.readFileSync(README, 'utf8');

  it('mentions the dead-policy-field check', () => {
    assert.match(
      doc,
      /dead-policy-field/i,
      'README.md must mention the dead-policy-field check'
    );
  });

  it('mentions the no-production-caller check', () => {
    assert.match(
      doc,
      /no-production-caller/i,
      'README.md must mention the no-production-caller check'
    );
  });

  it('mentions adversarial review', () => {
    assert.match(
      doc,
      /adversarial.*review|adversarial.*pass/i,
      'README.md must mention adversarial review'
    );
  });

  it('mentions the adversarial_review_model knob', () => {
    assert.match(
      doc,
      /adversarial_review_model/,
      'README.md must mention the adversarial_review_model policy knob'
    );
  });
});

describe('epic-082-005: docs/runbooks/finalize.md — exit-non-zero conditions and adversarial review pass', () => {
  const doc = fs.readFileSync(FINALIZE_RUNBOOK, 'utf8');

  it('describes the no-production-caller exit-non-zero condition', () => {
    assert.match(
      doc,
      /no-production-caller/i,
      'finalize runbook must describe the no-production-caller check'
    );
    assert.match(
      doc,
      /no-production-caller[\s\S]{0,1000}block|block[\s\S]{0,1000}no-production-caller/i,
      'finalize runbook must describe blocking behavior for no-production-caller'
    );
  });

  it('describes the dead-policy-field exit-non-zero condition', () => {
    assert.match(
      doc,
      /dead-policy-field/i,
      'finalize runbook must describe the dead-policy-field check'
    );
    assert.match(
      doc,
      /dead-policy-field[\s\S]{0,1000}block|block[\s\S]{0,1000}dead-policy-field/i,
      'finalize runbook must describe blocking behavior for dead-policy-field'
    );
  });

  it('documents the adversarial review pass', () => {
    assert.match(
      doc,
      /adversarial.*review|adversarial.*pass/i,
      'finalize runbook must document the adversarial review pass'
    );
  });

  it('adversarial review section mentions adversarial_review_model', () => {
    assert.match(
      doc,
      /adversarial_review_model/,
      'finalize runbook must mention the adversarial_review_model knob'
    );
  });

  it('adversarial review section describes the audit action', () => {
    assert.match(
      doc,
      /adversarial_review/,
      'finalize runbook must document the adversarial_review audit action'
    );
  });

  it('overview table includes no-production-caller and dead-policy-field rows', () => {
    const overviewTable = doc.match(/## Overview[\s\S]*?\n---/);
    assert.ok(overviewTable, 'finalize runbook must have an Overview section with a table');
    assert.match(
      overviewTable[0],
      /no-production-caller/i,
      'overview table must include no-production-caller'
    );
    assert.match(
      overviewTable[0],
      /dead-policy-field/i,
      'overview table must include dead-policy-field'
    );
  });
});
