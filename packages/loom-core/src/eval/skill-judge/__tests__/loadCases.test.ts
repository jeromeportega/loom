import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { loadSkillJudgeCases } from '../loadCases.js';
import { SkillJudgeEvalCaseSchema } from '../caseSchema.js';
import { BANDS, BAND_TOLERANCE, JUDGE_MIN_SCORE, scoreInBand } from '../bands.js';
import { SKILL_JUDGE_MIN_SCORE } from '../../../orchestrator/constants.js';

// ── BANDS are derived from JUDGE_MIN_SCORE (not hard-coded) ──────────────────

describe('bands — derived from JUDGE_MIN_SCORE (AC4)', () => {
  it('JUDGE_MIN_SCORE is the policy default (6)', () => {
    assert.equal(JUDGE_MIN_SCORE, 6);
  });

  it('BANDS.bad upper bound is JUDGE_MIN_SCORE - 2', () => {
    assert.equal(BANDS.bad[1], JUDGE_MIN_SCORE - 2);
  });

  it('BANDS.borderline lower bound is JUDGE_MIN_SCORE - 1', () => {
    assert.equal(BANDS.borderline[0], JUDGE_MIN_SCORE - 1);
  });

  it('BANDS.borderline upper bound is JUDGE_MIN_SCORE', () => {
    assert.equal(BANDS.borderline[1], JUDGE_MIN_SCORE);
  });

  it('BANDS.borderline brackets JUDGE_MIN_SCORE (lo ≤ JUDGE_MIN_SCORE ≤ hi)', () => {
    assert.ok(BANDS.borderline[0] <= JUDGE_MIN_SCORE && JUDGE_MIN_SCORE <= BANDS.borderline[1]);
  });

  it('BANDS.good lower bound is JUDGE_MIN_SCORE + 1', () => {
    assert.equal(BANDS.good[0], JUDGE_MIN_SCORE + 1);
  });

  it('BANDS.bad starts at 0', () => {
    assert.equal(BANDS.bad[0], 0);
  });

  it('BANDS.good ends at 10', () => {
    assert.equal(BANDS.good[1], 10);
  });

  it('BAND_TOLERANCE is 1 (τ=1, ADR-003)', () => {
    assert.equal(BAND_TOLERANCE, 1);
  });

  it('JUDGE_MIN_SCORE matches the baked SKILL_JUDGE_MIN_SCORE constant', () => {
    // skill_judge_min_score was a policy knob; it is now baked to a constant
    // (knob-hardening). The eval's JUDGE_MIN_SCORE must stay in sync with that
    // baked value rather than a (now-removed) policy.schema.yaml default.
    assert.equal(
      JUDGE_MIN_SCORE,
      SKILL_JUDGE_MIN_SCORE,
      `JUDGE_MIN_SCORE (${JUDGE_MIN_SCORE}) must match the baked SKILL_JUDGE_MIN_SCORE (${SKILL_JUDGE_MIN_SCORE})`,
    );
  });
});

// ── scoreInBand — band boundary math with τ=1 tolerance ──────────────────────

describe('scoreInBand — good band [7,10] boundary math (τ=1)', () => {
  it('s=7 (lo) in band', () => { assert.equal(scoreInBand(7, 'good'), true); });
  it('s=6 (lo−τ) in band', () => { assert.equal(scoreInBand(6, 'good'), true); });
  it('s=5 (lo−τ−1) out of band', () => { assert.equal(scoreInBand(5, 'good'), false); });
  it('s=10 (hi) in band', () => { assert.equal(scoreInBand(10, 'good'), true); });
  // Upper bound is capped at 10 — scores above 10 are always out of band (systematic judge error)
  it('s=11 (above hi, upper cap at 10) out of band', () => { assert.equal(scoreInBand(11, 'good'), false); });
  it('s=12 (well above hi) out of band', () => { assert.equal(scoreInBand(12, 'good'), false); });
});

describe('scoreInBand — bad band [0,4] boundary math (τ=1)', () => {
  it('s=0 (lo) in band', () => { assert.equal(scoreInBand(0, 'bad'), true); });
  it('s=4 (hi) in band', () => { assert.equal(scoreInBand(4, 'bad'), true); });
  it('s=5 (hi+τ) in band', () => { assert.equal(scoreInBand(5, 'bad'), true); });
  it('s=6 (hi+τ+1) out of band', () => { assert.equal(scoreInBand(6, 'bad'), false); });
});

describe('scoreInBand — borderline band [5,6] boundary math (τ=1)', () => {
  it('s=4 (lo−τ) in band', () => { assert.equal(scoreInBand(4, 'borderline'), true); });
  it('s=3 (lo−τ−1) out of band', () => { assert.equal(scoreInBand(3, 'borderline'), false); });
  it('s=7 (hi+τ) in band', () => { assert.equal(scoreInBand(7, 'borderline'), true); });
  it('s=8 (hi+τ+1) out of band', () => { assert.equal(scoreInBand(8, 'borderline'), false); });
});

describe('scoreInBand — sentinel and out-of-range values', () => {
  it('999 fail-open sentinel is out of every band', () => {
    assert.equal(scoreInBand(999, 'bad'), false);
    assert.equal(scoreInBand(999, 'borderline'), false);
    assert.equal(scoreInBand(999, 'good'), false);
  });

  it('negative score is always out of band', () => {
    assert.equal(scoreInBand(-1, 'bad'), false);
    assert.equal(scoreInBand(-1, 'borderline'), false);
    assert.equal(scoreInBand(-1, 'good'), false);
  });
});

// ── Schema validation — accepts a well-formed case ────────────────────────────

describe('SkillJudgeEvalCaseSchema — accepts a well-formed accept case', () => {
  const GOOD_ACCEPT = {
    id:                'sj-test-good-01',
    source:            'anchor',
    category:          'accept',
    skill_md:          '# My Skill\n\nDo the thing.',
    existing_skills:   [],
    expected_decision: 'accept',
    expected_band:     'good',
    rationale:         'Crisp and reusable.',
  };

  it('parses a valid accept case without throwing', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse(GOOD_ACCEPT);
    assert.ok(result.success, `Expected success, got: ${!result.success ? JSON.stringify(result.error) : ''}`);
  });

  it('existing_skills defaults to [] when omitted', () => {
    const { existing_skills: _, ...withoutSkills } = GOOD_ACCEPT;
    const result = SkillJudgeEvalCaseSchema.safeParse(withoutSkills);
    assert.ok(result.success, 'should succeed when existing_skills is omitted');
    if (!result.success) return;
    assert.deepEqual(result.data.existing_skills, []);
  });
});

describe('SkillJudgeEvalCaseSchema — accepts a well-formed reject case', () => {
  it('parses a valid reject case with failure_mode', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({
      id:                'sj-test-bad-01',
      source:            'anchor',
      category:          'reject',
      skill_md:          '# Vague\n\nDo stuff.',
      expected_decision: 'reject',
      expected_band:     'bad',
      failure_mode:      'vague',
      rationale:         'No concrete output contract.',
    });
    assert.ok(result.success, `Expected success, got: ${!result.success ? JSON.stringify(result.error) : ''}`);
  });
});

describe('SkillJudgeEvalCaseSchema — validates existing_skills shape', () => {
  it('accepts existing_skills with {name, description} entries', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({
      id:                'sj-test-dup-01',
      source:            'anchor',
      category:          'reject',
      skill_md:          '# Dup\n\nSame as existing.',
      existing_skills:   [{ name: 'edge-case-review', description: 'Examine a change for edge cases.' }],
      expected_decision: 'reject',
      expected_band:     'bad',
      failure_mode:      'duplicative',
      rationale:         'Duplicates existing skill.',
    });
    assert.ok(result.success, `Expected success: ${!result.success ? JSON.stringify(result.error) : ''}`);
  });

  it('rejects existing_skills entries missing description', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({
      id:                'sj-test-bad-shape',
      source:            'anchor',
      category:          'reject',
      skill_md:          '# Dup\n\nSame as existing.',
      existing_skills:   [{ name: 'edge-case-review' }],
      expected_decision: 'reject',
      expected_band:     'bad',
      failure_mode:      'duplicative',
      rationale:         'Duplicates existing skill.',
    });
    assert.ok(!result.success, 'should reject existing_skills entry missing description');
  });

  it('rejects duplicative failure_mode with empty existing_skills', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({
      id:                'sj-test-dup-no-context',
      source:            'anchor',
      category:          'reject',
      skill_md:          '# Dup\n\nSame as existing.',
      existing_skills:   [],
      expected_decision: 'reject',
      expected_band:     'bad',
      failure_mode:      'duplicative',
      rationale:         'Duplicates existing skill.',
    });
    assert.ok(!result.success, 'duplicative case with no existing_skills must fail validation');
  });

  it('accepts duplicative failure_mode when existing_skills is non-empty', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({
      id:                'sj-test-dup-with-context',
      source:            'anchor',
      category:          'reject',
      skill_md:          '# Dup\n\nSame as existing.',
      existing_skills:   [{ name: 'edge-case-review', description: 'Examine a change for edge cases.' }],
      expected_decision: 'reject',
      expected_band:     'bad',
      failure_mode:      'duplicative',
      rationale:         'Duplicates existing skill.',
    });
    assert.ok(result.success, `duplicative case with existing_skills should pass: ${!result.success ? JSON.stringify(result.error) : ''}`);
  });
});

// ── Schema validation — rejects malformed cases ───────────────────────────────

describe('SkillJudgeEvalCaseSchema — rejects malformed cases', () => {
  function good(): Record<string, unknown> {
    return {
      id:                'sj-test-001',
      source:            'anchor',
      category:          'accept',
      skill_md:          '# My Skill\n\nDo the thing.',
      expected_decision: 'accept',
      expected_band:     'good',
      rationale:         'Crisp and reusable.',
    };
  }

  it('rejects empty skill_md', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({ ...good(), skill_md: '' });
    assert.ok(!result.success, 'should fail for empty skill_md');
  });

  it('rejects missing expected_decision', () => {
    const bad = good();
    delete bad.expected_decision;
    const result = SkillJudgeEvalCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'should fail when expected_decision is missing');
  });

  it('rejects bad enum for category', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({ ...good(), category: 'unclear' });
    assert.ok(!result.success, 'should fail for unknown category value');
  });

  it('rejects bad enum for expected_decision', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({ ...good(), expected_decision: 'maybe' });
    assert.ok(!result.success, 'should fail for unknown expected_decision value');
  });

  it('rejects bad enum for expected_band', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({ ...good(), expected_band: 'excellent' });
    assert.ok(!result.success, 'should fail for unknown expected_band value');
  });

  it('rejects bad enum for failure_mode', () => {
    const result = SkillJudgeEvalCaseSchema.safeParse({ ...good(), failure_mode: 'useless' });
    assert.ok(!result.success, 'should fail for unknown failure_mode value');
  });
});

// ── Default fixture loads and validates (AC1 / AC5) ───────────────────────────

describe('loadSkillJudgeCases — default fixture', () => {
  it('loads skill-judge.yaml with no argument and returns validated cases', () => {
    const cases = loadSkillJudgeCases();
    assert.ok(Array.isArray(cases), 'should return an array');
    assert.ok(cases.length >= 1, 'should return at least one case');
  });

  it('every returned case satisfies SkillJudgeEvalCaseSchema', () => {
    const cases = loadSkillJudgeCases();
    for (const c of cases) {
      const result = SkillJudgeEvalCaseSchema.safeParse(c);
      assert.ok(
        result.success,
        `case ${c.id} failed schema validation: ${!result.success ? JSON.stringify(result.error.issues) : ''}`,
      );
    }
  });

  it('is idempotent — repeated calls return the same count and first id', () => {
    const first  = loadSkillJudgeCases();
    const second = loadSkillJudgeCases();
    assert.equal(first.length, second.length, 'same case count on repeated calls');
    assert.equal(first[0].id, second[0].id, 'first case id matches on repeated calls');
  });
});

// ── Explicit-path tests (AC5) ─────────────────────────────────────────────────

describe('loadSkillJudgeCases — explicit fixture path', () => {
  function makeTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sj-test-'));
  }
  function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  it('loads a custom fixture when an explicit path is provided', () => {
    const tmp = makeTmp();
    try {
      const fixture = {
        cases: [
          {
            id:                'sj-custom-01',
            source:            'anchor',
            category:          'accept',
            skill_md:          '# Custom Skill\n\nDo the thing reusably.',
            expected_decision: 'accept',
            expected_band:     'good',
            rationale:         'Crisp and reusable.',
          },
        ],
      };
      const fixturePath = path.join(tmp, 'custom-sj.yaml');
      fs.writeFileSync(fixturePath, yaml.dump(fixture), 'utf8');

      const cases = loadSkillJudgeCases(fixturePath);
      assert.equal(cases.length, 1, 'should return 1 case from custom fixture');
      assert.equal(cases[0].id, 'sj-custom-01');
      assert.equal(cases[0].expected_band, 'good');
    } finally {
      cleanup(tmp);
    }
  });

  it('throws when explicit path does not exist', () => {
    assert.throws(
      () => loadSkillJudgeCases('/tmp/loom-nonexistent-sj-fixture-xyz.yaml'),
      /not found/i,
    );
  });

  it('throws (zod) when fixture has empty cases array', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'empty-cases.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({ cases: [] }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when a case has empty skill_md', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'empty-skill-md.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({
        cases: [{
          id: 'sj-bad-01', source: 'anchor', category: 'accept',
          skill_md: '', expected_decision: 'accept',
          expected_band: 'good', rationale: 'Test.',
        }],
      }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when a case has missing expected_decision', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'missing-decision.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({
        cases: [{
          id: 'sj-bad-02', source: 'anchor', category: 'accept',
          skill_md: '# Skill\nDo thing.', expected_band: 'good', rationale: 'Test.',
          // missing: expected_decision
        }],
      }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when category is an invalid enum value', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'bad-category.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({
        cases: [{
          id: 'sj-bad-03', source: 'anchor', category: 'unclear',
          skill_md: '# Skill\nDo thing.', expected_decision: 'accept',
          expected_band: 'good', rationale: 'Test.',
        }],
      }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when expected_decision is an invalid enum value', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'bad-decision.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({
        cases: [{
          id: 'sj-bad-04', source: 'anchor', category: 'accept',
          skill_md: '# Skill\nDo thing.', expected_decision: 'maybe',
          expected_band: 'good', rationale: 'Test.',
        }],
      }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when expected_band is an invalid enum value', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'bad-band.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({
        cases: [{
          id: 'sj-bad-05', source: 'anchor', category: 'accept',
          skill_md: '# Skill\nDo thing.', expected_decision: 'accept',
          expected_band: 'excellent', rationale: 'Test.',
        }],
      }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when failure_mode is an invalid enum value', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'bad-failure-mode.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({
        cases: [{
          id: 'sj-bad-06', source: 'anchor', category: 'reject',
          skill_md: '# Skill\nDo thing.', expected_decision: 'reject',
          expected_band: 'bad', failure_mode: 'useless', rationale: 'Test.',
        }],
      }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Fixture-content (data-as-test) assertions (AC2 / AC3) ────────────────────

describe('loadSkillJudgeCases — fixture category coverage (AC1)', () => {
  it('contains at least one accept case', () => {
    const cases = loadSkillJudgeCases();
    assert.ok(cases.some((c) => c.category === 'accept'), 'fixture must have at least one accept case');
  });

  it('contains at least one reject case', () => {
    const cases = loadSkillJudgeCases();
    assert.ok(cases.some((c) => c.category === 'reject'), 'fixture must have at least one reject case');
  });

  it('contains at least one borderline case', () => {
    const cases = loadSkillJudgeCases();
    assert.ok(cases.some((c) => c.category === 'borderline'), 'fixture must have at least one borderline case');
  });
});

describe('loadSkillJudgeCases — every case carries expected_decision and expected_band (AC2)', () => {
  it('every case has expected_decision', () => {
    const cases = loadSkillJudgeCases();
    for (const c of cases) {
      assert.ok(
        c.expected_decision === 'accept' || c.expected_decision === 'reject',
        `case ${c.id}: expected_decision must be 'accept' or 'reject'`,
      );
    }
  });

  it('every case has expected_band', () => {
    const validBands = new Set(['bad', 'borderline', 'good']);
    const cases = loadSkillJudgeCases();
    for (const c of cases) {
      assert.ok(validBands.has(c.expected_band), `case ${c.id}: expected_band must be bad/borderline/good`);
    }
  });
});

describe('loadSkillJudgeCases — reject cases have failure_mode (AC3)', () => {
  it('every reject case has a failure_mode', () => {
    const cases = loadSkillJudgeCases();
    for (const c of cases.filter((c) => c.category === 'reject')) {
      assert.ok(
        c.failure_mode !== undefined,
        `reject case ${c.id} is missing failure_mode`,
      );
    }
  });

  it('all four failure modes are covered across reject cases', () => {
    const cases = loadSkillJudgeCases();
    const modes = new Set(
      cases.filter((c) => c.category === 'reject').map((c) => c.failure_mode),
    );
    assert.ok(modes.has('vague'),        'fixture must contain at least one vague reject case');
    assert.ok(modes.has('not-reusable'), 'fixture must contain at least one not-reusable reject case');
    assert.ok(modes.has('duplicative'),  'fixture must contain at least one duplicative reject case');
    assert.ok(modes.has('unsafe'),       'fixture must contain at least one unsafe reject case');
  });
});

describe('loadSkillJudgeCases — minimum set size (AC5)', () => {
  it('fixture has at least 5 cases (minScoredCases threshold)', () => {
    const cases = loadSkillJudgeCases();
    assert.ok(cases.length >= 5, `fixture has ${cases.length} cases but needs ≥5`);
  });
});
