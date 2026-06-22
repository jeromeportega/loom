import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { loadSkillGeneratorCases, defaultFixturePath } from '../loadCases.js';
import {
  SkillGeneratorCaseSchema,
  SkillGeneratorCaseSetSchema,
  type SkillGeneratorCase,
} from '../caseSchema.js';
import type { GateEvalCase } from '../../framework/types.js';

// Compile-time check: SkillGeneratorCase must structurally satisfy GateEvalCase.
type _GateEvalCaseCheck = SkillGeneratorCase extends GateEvalCase ? true : never;
const _enforceGateEvalCase: _GateEvalCaseCheck = true;

// ── Minimal fixture helpers ───────────────────────────────────────────────────

function makeWork(overrides: Record<string, unknown> = {}) {
  return {
    story: {
      id: 'story-001',
      title: 'Add feature X',
      description: 'Implement feature X',
      acceptance_criteria: ['AC1: output is correct', 'AC2: tests pass'],
    },
    summary: 'Worker completed the implementation and all tests pass.',
    diff_context: '[10:00:01] Writing src/feature.ts\n[10:00:03] npm test: 5 passed',
    ...overrides,
  };
}

function makeRubric(overrides: Record<string, unknown> = {}) {
  return {
    expected_decision: 'generate' as const,
    expected_themes: ['reusable recipe for feature X'],
    ...overrides,
  };
}

function validWorthyCase(id = 'sg-worthy-001'): Record<string, unknown> {
  return {
    id,
    source: 'worthy',
    work: makeWork(),
    rubric: makeRubric(),
    rationale: 'The work reveals a reusable multi-step pattern.',
  };
}

function validTrivialCase(id = 'sg-trivial-001'): Record<string, unknown> {
  return {
    id,
    source: 'trivial',
    work: makeWork(),
    rubric: {
      expected_decision: 'none',
      expected_themes: [],
      spurious_traps: ['a one-line fix is not a reusable loom procedure'],
    },
    rationale: 'One-off fix with no reusable recipe.',
  };
}

function validBorderlineCase(id = 'sg-borderline-001'): Record<string, unknown> {
  return {
    id,
    source: 'borderline',
    work: makeWork(),
    rubric: {
      expected_decision: 'either',
      expected_themes: ['pattern that may or may not warrant a skill'],
      spurious_traps: ['the pattern is short enough that reading the code suffices'],
    },
    rationale: 'Borderline case — reasonable evaluators could disagree.',
  };
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sg-test-'));
}
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
function writeFixture(dir: string, name: string, data: unknown): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, yaml.dump(data), 'utf8');
  return p;
}

// ── Default fixture (no arg) — AC per the test plan ─────────────────────────

describe('loadSkillGeneratorCases — default fixture spans all three buckets', () => {
  it('loads the default fixture with no argument and returns at least one case', () => {
    const cases = loadSkillGeneratorCases();
    assert.ok(Array.isArray(cases), 'should return an array');
    assert.ok(cases.length >= 1, 'default fixture must have at least one case');
  });

  it('contains at least one worthy case with expected_decision generate', () => {
    const cases = loadSkillGeneratorCases();
    assert.ok(
      cases.some((c) => c.source === 'worthy' && c.rubric.expected_decision === 'generate'),
      'must have at least one worthy case with expected_decision generate',
    );
  });

  it('contains at least one trivial case with expected_decision none', () => {
    const cases = loadSkillGeneratorCases();
    assert.ok(
      cases.some((c) => c.source === 'trivial' && c.rubric.expected_decision === 'none'),
      'must have at least one trivial case with expected_decision none',
    );
  });

  it('contains at least one borderline case with expected_decision either', () => {
    const cases = loadSkillGeneratorCases();
    assert.ok(
      cases.some((c) => c.source === 'borderline' && c.rubric.expected_decision === 'either'),
      'must have at least one borderline case with expected_decision either',
    );
  });

  it('is idempotent — repeated calls return the same count and first id', () => {
    const first = loadSkillGeneratorCases();
    const second = loadSkillGeneratorCases();
    assert.equal(first.length, second.length, 'same case count on repeated calls');
    assert.equal(first[0].id, second[0].id, 'first case id matches on repeated calls');
  });
});

// ── Data-integrity guard over the committed fixture ──────────────────────────

describe('loadSkillGeneratorCases — fixture data integrity (rubric content quality)', () => {
  it('every worthy case has non-empty expected_themes', () => {
    const cases = loadSkillGeneratorCases();
    for (const c of cases.filter((c) => c.source === 'worthy')) {
      assert.ok(
        c.rubric.expected_themes.length > 0,
        `worthy case ${c.id} must have non-empty expected_themes`,
      );
    }
  });

  it('every trivial case has non-empty spurious_traps', () => {
    const cases = loadSkillGeneratorCases();
    for (const c of cases.filter((c) => c.source === 'trivial')) {
      assert.ok(
        c.rubric.spurious_traps.length > 0,
        `trivial case ${c.id} must have non-empty spurious_traps`,
      );
    }
  });

  it('trivial bucket has at least 3 cases (spuriousGenerationRate needs a meaningful denominator)', () => {
    const cases = loadSkillGeneratorCases();
    const trivial = cases.filter((c) => c.source === 'trivial');
    assert.ok(
      trivial.length >= 3,
      `trivial bucket must have ≥3 cases for a meaningful spuriousGenerationRate, got ${trivial.length}`,
    );
  });

  it('every case has a non-empty rationale', () => {
    const cases = loadSkillGeneratorCases();
    for (const c of cases) {
      assert.ok(
        typeof c.rationale === 'string' && c.rationale.length > 0,
        `case ${c.id} must have a non-empty rationale`,
      );
    }
  });

  it('worthy cases carry expected_decision generate', () => {
    const cases = loadSkillGeneratorCases();
    for (const c of cases.filter((c) => c.source === 'worthy')) {
      assert.equal(
        c.rubric.expected_decision,
        'generate',
        `worthy case ${c.id} must have expected_decision generate`,
      );
    }
  });

  it('trivial cases carry expected_decision none', () => {
    const cases = loadSkillGeneratorCases();
    for (const c of cases.filter((c) => c.source === 'trivial')) {
      assert.equal(
        c.rubric.expected_decision,
        'none',
        `trivial case ${c.id} must have expected_decision none`,
      );
    }
  });

  it('borderline cases carry expected_decision either', () => {
    const cases = loadSkillGeneratorCases();
    for (const c of cases.filter((c) => c.source === 'borderline')) {
      assert.equal(
        c.rubric.expected_decision,
        'either',
        `borderline case ${c.id} must have expected_decision either`,
      );
    }
  });

  it('every trivial spurious trap is a meaningful description (not a short placeholder)', () => {
    const cases = loadSkillGeneratorCases();
    for (const c of cases.filter((c) => c.source === 'trivial')) {
      for (const trap of c.rubric.spurious_traps) {
        assert.ok(
          trap.length > 30,
          `trivial case ${c.id} trap is too short to be meaningful: "${trap}"`,
        );
      }
    }
  });
});

// ── Committed fixture validates against SkillGeneratorCaseSetSchema ──────────

describe('loadSkillGeneratorCases — committed fixture validates clean', () => {
  it('every production case satisfies SkillGeneratorCaseSchema', () => {
    const cases = loadSkillGeneratorCases();
    for (const c of cases) {
      const result = SkillGeneratorCaseSchema.safeParse(c);
      assert.ok(
        result.success,
        `case ${c.id} failed schema re-validation: ${!result.success ? JSON.stringify(result.error.issues) : ''}`,
      );
    }
  });

  it('default fixture path resolves and the file parses against SkillGeneratorCaseSetSchema', () => {
    const fp = defaultFixturePath();
    const raw = yaml.load(fs.readFileSync(fp, 'utf8'), { schema: yaml.JSON_SCHEMA });
    const result = SkillGeneratorCaseSetSchema.safeParse(raw);
    assert.ok(
      result.success,
      `skill-generator.yaml failed SkillGeneratorCaseSetSchema: ${!result.success ? JSON.stringify(result.error.issues) : ''}`,
    );
  });
});

// ── Explicit path — AC3 ───────────────────────────────────────────────────────

describe('loadSkillGeneratorCases — explicit fixture path', () => {
  it('loads a custom fixture when an explicit path is provided', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validWorthyCase('sg-custom-01')] };
      const fp = writeFixture(tmp, 'custom.yaml', fixture);

      const cases = loadSkillGeneratorCases(fp);
      assert.equal(cases.length, 1, 'should return 1 case from custom fixture');
      assert.equal(cases[0].id, 'sg-custom-01');
    } finally {
      cleanup(tmp);
    }
  });

  it('explicit path overrides the default fixture — only cases from that file are returned', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validTrivialCase('sg-explicit-trivial')] };
      const fp = writeFixture(tmp, 'explicit.yaml', fixture);

      const cases = loadSkillGeneratorCases(fp);
      assert.equal(cases.length, 1);
      assert.equal(cases[0].id, 'sg-explicit-trivial');
      assert.equal(cases[0].source, 'trivial');
    } finally {
      cleanup(tmp);
    }
  });

  it('loads all three bucket types from a single custom fixture', () => {
    const tmp = makeTmp();
    try {
      const fixture = {
        cases: [
          validWorthyCase('sg-w-01'),
          validTrivialCase('sg-t-01'),
          validBorderlineCase('sg-b-01'),
        ],
      };
      const fp = writeFixture(tmp, 'all-buckets.yaml', fixture);

      const cases = loadSkillGeneratorCases(fp);
      assert.equal(cases.length, 3);
      assert.ok(cases.some((c) => c.source === 'worthy'));
      assert.ok(cases.some((c) => c.source === 'trivial'));
      assert.ok(cases.some((c) => c.source === 'borderline'));
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Malformed input throws (zod) — AC4/AC5 ───────────────────────────────────

describe('loadSkillGeneratorCases — throws on missing required field (AC4)', () => {
  it('throws (zod) when rubric.expected_decision is missing', () => {
    const tmp = makeTmp();
    try {
      const { expected_decision: _, ...noDecision } = validWorthyCase().rubric as Record<string, unknown>;
      const c = { ...validWorthyCase(), rubric: noDecision };
      const fp = writeFixture(tmp, 'no-decision.yaml', { cases: [c] });
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when id is missing', () => {
    const tmp = makeTmp();
    try {
      const { id: _, ...noId } = validWorthyCase();
      const fp = writeFixture(tmp, 'no-id.yaml', { cases: [noId] });
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when source is outside worthy|trivial|borderline', () => {
    const tmp = makeTmp();
    try {
      const fp = writeFixture(tmp, 'bad-source.yaml', {
        cases: [{ ...validWorthyCase(), source: 'rich' }],
      });
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when expected_decision is outside generate|none|either', () => {
    const tmp = makeTmp();
    try {
      const c = {
        ...validWorthyCase(),
        rubric: { ...makeRubric(), expected_decision: 'maybe' },
      };
      const fp = writeFixture(tmp, 'bad-decision.yaml', { cases: [c] });
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when work.story is missing', () => {
    const tmp = makeTmp();
    try {
      const { story: _, ...noStory } = makeWork();
      const c = { ...validWorthyCase(), work: noStory };
      const fp = writeFixture(tmp, 'no-story.yaml', { cases: [c] });
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when work.summary is missing', () => {
    const tmp = makeTmp();
    try {
      const { summary: _, ...noSummary } = makeWork();
      const c = { ...validWorthyCase(), work: noSummary };
      const fp = writeFixture(tmp, 'no-summary.yaml', { cases: [c] });
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when rationale is empty string', () => {
    const tmp = makeTmp();
    try {
      const fp = writeFixture(tmp, 'empty-rationale.yaml', {
        cases: [{ ...validWorthyCase(), rationale: '' }],
      });
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });
});

describe('loadSkillGeneratorCases — throws when cases list is empty (AC5)', () => {
  it('throws (zod) when cases array is empty (min(1) constraint)', () => {
    const tmp = makeTmp();
    try {
      const fp = writeFixture(tmp, 'empty.yaml', { cases: [] });
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });
});

// ── File-not-found throws ─────────────────────────────────────────────────────

describe('loadSkillGeneratorCases — throws when path does not exist', () => {
  it('throws a descriptive error for a nonexistent file', () => {
    assert.throws(
      () => loadSkillGeneratorCases('/tmp/loom-nonexistent-sg-fixture-xyz.yaml'),
      /not found/i,
    );
  });
});

// ── Schema parity — loader delegates to zod, no custom coercion ──────────────

describe('loadSkillGeneratorCases — delegates to SkillGeneratorCaseSetSchema, no custom coercion', () => {
  it('throws on the same inputs that SkillGeneratorCaseSetSchema.parse() rejects', () => {
    const tmp = makeTmp();
    try {
      const badInput = { cases: [{ ...validWorthyCase(), source: 'unknown' }] };
      const fp = writeFixture(tmp, 'schema-parity.yaml', badInput);

      assert.throws(() => SkillGeneratorCaseSetSchema.parse(badInput));
      assert.throws(() => loadSkillGeneratorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('does not silently drop malformed cases — fails closed on partial-bad fixture', () => {
    const tmp = makeTmp();
    try {
      const mixed = {
        cases: [
          validWorthyCase('sg-valid'),
          { ...validTrivialCase('sg-bad'), source: 'INVALID' },
        ],
      };
      const fp = writeFixture(tmp, 'partial-bad.yaml', mixed);
      assert.throws(
        () => loadSkillGeneratorCases(fp),
        'fixture with one bad case must throw entirely, not return just the valid case',
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Happy path — loader returns correct case structure ────────────────────────

describe('loadSkillGeneratorCases — happy path with inline fixtures', () => {
  it('returns an array of the expected length', () => {
    const tmp = makeTmp();
    try {
      const fixture = {
        cases: [
          validWorthyCase('sg-w-hp-01'),
          validTrivialCase('sg-t-hp-01'),
          validBorderlineCase('sg-b-hp-01'),
        ],
      };
      const fp = writeFixture(tmp, 'test.yaml', fixture);

      const cases = loadSkillGeneratorCases(fp);
      assert.equal(cases.length, 3, 'should return 3 cases matching the fixture');
    } finally {
      cleanup(tmp);
    }
  });

  it('each case carries GateEvalCase fields (id and source)', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validWorthyCase('sg-id-check'), validTrivialCase('sg-t-id-check')] };
      const fp = writeFixture(tmp, 'test-ids.yaml', fixture);

      const cases = loadSkillGeneratorCases(fp);
      assert.equal(cases[0].id, 'sg-id-check');
      assert.equal(cases[0].source, 'worthy');
      assert.equal(cases[1].id, 'sg-t-id-check');
      assert.equal(cases[1].source, 'trivial');
    } finally {
      cleanup(tmp);
    }
  });

  it('rubric fields pass through unchanged', () => {
    const tmp = makeTmp();
    try {
      const themes = ['step recipe for X', 'how to wire the barrel'];
      const traps  = ['this is a one-off fix not a recipe'];
      const c = {
        ...validWorthyCase('sg-rubric-check'),
        rubric: { expected_decision: 'generate', expected_themes: themes, spurious_traps: traps },
      };
      const fp = writeFixture(tmp, 'rubric.yaml', { cases: [c] });

      const [loaded] = loadSkillGeneratorCases(fp);
      assert.deepEqual(loaded.rubric.expected_themes, themes);
      assert.deepEqual(loaded.rubric.spurious_traps, traps);
      assert.equal(loaded.rubric.expected_decision, 'generate');
    } finally {
      cleanup(tmp);
    }
  });

  it('work fields (summary and diff_context) pass through unchanged', () => {
    const tmp = makeTmp();
    try {
      const summary = 'Agent completed the task, all 42 tests pass.';
      const diffCtx = '[09:00:01] Writing src/foo.ts\n[09:00:05] npm test: 42 passed';
      const c = {
        ...validWorthyCase('sg-work-check'),
        work: makeWork({ summary, diff_context: diffCtx }),
      };
      const fp = writeFixture(tmp, 'work.yaml', { cases: [c] });

      const [loaded] = loadSkillGeneratorCases(fp);
      assert.equal(loaded.work.summary, summary);
      assert.equal(loaded.work.diff_context, diffCtx);
    } finally {
      cleanup(tmp);
    }
  });

  it('each case satisfies SkillGeneratorCaseSchema after loading', () => {
    const tmp = makeTmp();
    try {
      const fixture = {
        cases: [
          validWorthyCase('sg-schema-w'),
          validTrivialCase('sg-schema-t'),
          validBorderlineCase('sg-schema-b'),
        ],
      };
      const fp = writeFixture(tmp, 'schema-check.yaml', fixture);

      const cases = loadSkillGeneratorCases(fp);
      for (const c of cases) {
        const result = SkillGeneratorCaseSchema.safeParse(c);
        assert.ok(
          result.success,
          `case ${c.id} failed schema re-validation: ${!result.success ? JSON.stringify(result.error.issues) : ''}`,
        );
      }
    } finally {
      cleanup(tmp);
    }
  });

  it('existing_skills defaults to empty array when absent from fixture', () => {
    const tmp = makeTmp();
    try {
      const { existing_skills: _, ...workNoSkills } = makeWork() as Record<string, unknown>;
      const c = { ...validWorthyCase('sg-no-skills'), work: workNoSkills };
      const fp = writeFixture(tmp, 'no-skills.yaml', { cases: [c] });

      const [loaded] = loadSkillGeneratorCases(fp);
      assert.deepEqual(loaded.work.existing_skills, []);
    } finally {
      cleanup(tmp);
    }
  });
});
