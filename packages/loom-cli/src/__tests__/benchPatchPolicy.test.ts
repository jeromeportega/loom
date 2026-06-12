/**
 * The SWE-bench harness patches each task's freshly-init'd policy.yaml
 * to apply per-run overrides (skill_generation, review_strategy, etc.).
 * Before this test existed, every numeric override was emitted with
 * quotes — `min_brief_quality_score: "1"` — which the Zod schema
 * rejected as "Expected number, received string." Every bench task
 * then failed identically at policy load before any work could begin.
 *
 * This test pins the contract: numbers emitted unquoted, strings
 * emitted quoted (to neutralize YAML 1.1 'on'/'off' boolean surprises
 * around skill_generation values).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchPolicy } from '../dev-scripts/bench.js';

let repoDir: string;

const SEED_POLICY = `# Loom Policy

git:
  allowed_remotes: []
  protected_branches:
    - main

agents:
  min_brief_quality_score: 6
  max_concurrent: 5
  review_strategy: "comment"
  skill_generation: "on"
`;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bench-patch-'));
  fs.mkdirSync(path.join(repoDir, '.loom'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.loom', 'policy.yaml'), SEED_POLICY);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

function readPolicy(): string {
  return fs.readFileSync(path.join(repoDir, '.loom', 'policy.yaml'), 'utf8');
}

describe('patchPolicy', () => {
  it('emits numeric overrides unquoted so Zod number schemas accept them', () => {
    patchPolicy(repoDir, { min_brief_quality_score: 1 });
    const out = readPolicy();
    assert.match(
      out,
      /\n {2}min_brief_quality_score: 1(?!")/m,
      'numeric override must be emitted without quotes',
    );
    assert.ok(
      !/min_brief_quality_score:\s*"1"/.test(out),
      'numeric override must NOT be wrapped in quotes',
    );
  });

  it('emits string overrides quoted (defends against YAML 1.1 on/off booleans)', () => {
    patchPolicy(repoDir, { skill_generation: 'off' });
    const out = readPolicy();
    assert.match(out, /skill_generation:\s*"off"/);
  });

  it('handles mixed numeric and string overrides in one call', () => {
    patchPolicy(repoDir, {
      min_brief_quality_score: 1,
      review_strategy: 'block-and-revise',
      skill_generation: 'on',
    });
    const out = readPolicy();
    assert.match(out, /min_brief_quality_score: 1(?!")/);
    assert.match(out, /review_strategy:\s*"block-and-revise"/);
    assert.match(out, /skill_generation:\s*"on"/);
  });

  it('appends a missing key under the agents: block', () => {
    patchPolicy(repoDir, { skill_judge_min_score: 7 });
    const out = readPolicy();
    assert.match(out, /\nagents:\n {2}skill_judge_min_score: 7\n/);
  });

  it('errors out when policy.yaml is missing entirely', () => {
    fs.rmSync(path.join(repoDir, '.loom', 'policy.yaml'));
    assert.throws(
      () => patchPolicy(repoDir, { min_brief_quality_score: 1 }),
      /policy\.yaml not found/,
    );
  });

  it('errors out when there is no agents: block to append to', () => {
    fs.writeFileSync(path.join(repoDir, '.loom', 'policy.yaml'), 'git:\n  allowed_remotes: []\n');
    assert.throws(
      () => patchPolicy(repoDir, { new_key: 1 }),
      /cannot locate 'agents:' section/,
    );
  });
});
