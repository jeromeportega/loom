import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SkillGeneratorCaseSchema,
  SkillGeneratorCaseSetSchema,
} from '../caseSchema.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeWork(overrides: Record<string, unknown> = {}) {
  return {
    story: {
      id:                  'story-001',
      title:               'Add feature X',
      description:         'Implement feature X',
      acceptance_criteria: ['AC1', 'AC2'],
    },
    summary:         'Worker completed the task successfully.',
    diff_context:    '+function featureX() {}\n-// old code',
    ...overrides,
  };
}

function makeRubric(overrides: Record<string, unknown> = {}) {
  return {
    expected_decision: 'generate' as const,
    ...overrides,
  };
}

function makeCase(overrides: Record<string, unknown> = {}) {
  return {
    id:        'case-001',
    source:    'worthy' as const,
    work:      makeWork(),
    rubric:    makeRubric(),
    rationale: 'This is a meaningful pattern worth capturing.',
    ...overrides,
  };
}

// ── Happy path: round-trip ────────────────────────────────────────────────────

describe('SkillGeneratorCaseSchema — round-trip with both work and rubric', () => {
  it('parses a fully-specified case carrying work AND rubric', () => {
    const input = makeCase({
      work: makeWork({
        existing_skills: [{ name: 'my-skill', description: 'A skill' }],
      }),
      rubric: makeRubric({
        expected_themes: ['pattern-A', 'pattern-B'],
        spurious_traps:  ['trap-X'],
      }),
    });
    const result = SkillGeneratorCaseSchema.parse(input);
    assert.equal(result.id, 'case-001');
    assert.equal(result.source, 'worthy');
    assert.equal(result.work.summary, 'Worker completed the task successfully.');
    assert.equal(result.work.diff_context, '+function featureX() {}\n-// old code');
    assert.equal(result.work.existing_skills.length, 1);
    assert.equal(result.rubric.expected_decision, 'generate');
    assert.deepEqual(result.rubric.expected_themes, ['pattern-A', 'pattern-B']);
    assert.deepEqual(result.rubric.spurious_traps, ['trap-X']);
  });

  it('preserves all source enum values', () => {
    for (const source of ['worthy', 'trivial', 'borderline'] as const) {
      const result = SkillGeneratorCaseSchema.parse(makeCase({ source }));
      assert.equal(result.source, source);
    }
  });

  it('preserves all expected_decision enum values', () => {
    for (const expected_decision of ['generate', 'none', 'either'] as const) {
      const result = SkillGeneratorCaseSchema.parse(
        makeCase({ rubric: makeRubric({ expected_decision }) }),
      );
      assert.equal(result.rubric.expected_decision, expected_decision);
    }
  });
});

// ── Defaults ──────────────────────────────────────────────────────────────────

describe('SkillGeneratorCaseSchema — optional fields default to []', () => {
  it('existing_skills defaults to [] when omitted', () => {
    const input = makeCase();
    // Ensure existing_skills not in input
    const work = { ...makeWork() };
    delete (work as Record<string, unknown>)['existing_skills'];
    const result = SkillGeneratorCaseSchema.parse({ ...input, work });
    assert.deepEqual(result.work.existing_skills, []);
  });

  it('expected_themes defaults to [] when omitted', () => {
    const input = makeCase({ rubric: { expected_decision: 'none' } });
    const result = SkillGeneratorCaseSchema.parse(input);
    assert.deepEqual(result.rubric.expected_themes, []);
  });

  it('spurious_traps defaults to [] when omitted', () => {
    const input = makeCase({ rubric: { expected_decision: 'either' } });
    const result = SkillGeneratorCaseSchema.parse(input);
    assert.deepEqual(result.rubric.spurious_traps, []);
  });

  it('all three optional arrays default independently', () => {
    const work   = { ...makeWork() };
    const rubric = { expected_decision: 'generate' as const };
    delete (work as Record<string, unknown>)['existing_skills'];
    const result = SkillGeneratorCaseSchema.parse({ ...makeCase(), work, rubric });
    assert.deepEqual(result.work.existing_skills, []);
    assert.deepEqual(result.rubric.expected_themes, []);
    assert.deepEqual(result.rubric.spurious_traps, []);
  });
});

// ── Rejection: missing required fields in work ────────────────────────────────

describe('SkillGeneratorCaseSchema — rejects missing work.summary', () => {
  it('throws when work.summary is missing', () => {
    const work = { ...makeWork() };
    delete (work as Record<string, unknown>)['summary'];
    assert.throws(() => SkillGeneratorCaseSchema.parse(makeCase({ work })));
  });
});

describe('SkillGeneratorCaseSchema — rejects missing work.diff_context', () => {
  it('throws when work.diff_context is missing', () => {
    const work = { ...makeWork() };
    delete (work as Record<string, unknown>)['diff_context'];
    assert.throws(() => SkillGeneratorCaseSchema.parse(makeCase({ work })));
  });
});

// ── Rejection: missing required rubric field ──────────────────────────────────

describe('SkillGeneratorCaseSchema — rejects missing rubric.expected_decision', () => {
  it('throws when expected_decision is missing', () => {
    const rubric = { expected_themes: [], spurious_traps: [] };
    assert.throws(() => SkillGeneratorCaseSchema.parse(makeCase({ rubric })));
  });
});

// ── Rejection: invalid enum values ───────────────────────────────────────────

describe('SkillGeneratorCaseSchema — rejects invalid source enum', () => {
  it('throws for source "unknown"', () => {
    assert.throws(() => SkillGeneratorCaseSchema.parse(makeCase({ source: 'unknown' })));
  });

  it('throws for source "rich" (lesson-extractor value, not ours)', () => {
    assert.throws(() => SkillGeneratorCaseSchema.parse(makeCase({ source: 'rich' })));
  });
});

describe('SkillGeneratorCaseSchema — rejects invalid expected_decision enum', () => {
  it('throws for expected_decision "generate-maybe"', () => {
    assert.throws(() =>
      SkillGeneratorCaseSchema.parse(
        makeCase({ rubric: makeRubric({ expected_decision: 'generate-maybe' }) }),
      ),
    );
  });

  it('throws for expected_decision "skip" (not in enum)', () => {
    assert.throws(() =>
      SkillGeneratorCaseSchema.parse(
        makeCase({ rubric: makeRubric({ expected_decision: 'skip' }) }),
      ),
    );
  });
});

// ── SkillGeneratorCaseSetSchema ───────────────────────────────────────────────

describe('SkillGeneratorCaseSetSchema — min(1) enforcement', () => {
  it('throws when cases is empty array', () => {
    assert.throws(() => SkillGeneratorCaseSetSchema.parse({ cases: [] }));
  });

  it('parses a set with one valid case', () => {
    const result = SkillGeneratorCaseSetSchema.parse({ cases: [makeCase()] });
    assert.equal(result.cases.length, 1);
  });

  it('parses a set with multiple cases', () => {
    const result = SkillGeneratorCaseSetSchema.parse({
      cases: [
        makeCase({ id: 'c1', source: 'worthy' }),
        makeCase({ id: 'c2', source: 'trivial', rubric: makeRubric({ expected_decision: 'none' }) }),
        makeCase({ id: 'c3', source: 'borderline', rubric: makeRubric({ expected_decision: 'either' }) }),
      ],
    });
    assert.equal(result.cases.length, 3);
  });
});
