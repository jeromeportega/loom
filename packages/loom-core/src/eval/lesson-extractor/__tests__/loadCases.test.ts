import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { loadLessonExtractorCases, defaultFixturePath } from '../loadCases.js';
import { LessonExtractorCaseSchema, type LessonExtractorCase } from '../caseSchema.js';
import type { GateEvalCase } from '../../framework/types.js';

// Compile-time check: LessonExtractorCase must structurally satisfy GateEvalCase.
// If _assertGateEvalCase fails to compile, the case shape diverged from the framework contract.
type _GateEvalCaseCheck = LessonExtractorCase extends GateEvalCase ? true : never;
type _assertGateEvalCase = _GateEvalCaseCheck;

// ── Minimal fixture helpers ───────────────────────────────────────────────────

function makeDecisionTrace(id: number) {
  return {
    id, agent_id: 'worker-001', epic_id: 'epic-001', story_id: 'story-001-001',
    kind: 'thinking', subject: 'impl', rationale: 'Some rationale.',
    metadata: null, timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function makeAgent(storyId: string) {
  return { story_id: storyId, review_summary: 'LGTM.', log_tail: '[00:00] Done.' };
}

function makeAuditRow(id: number) {
  return {
    id, agent_id: 'worker-001', action: 'bash', command: 'npm test',
    allowed: true, policy_rule: null, detail: '5 passing',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function minimalTelemetry(epicId = 'epic-001') {
  return {
    epic_id: epicId, final_status: 'done',
    decision_traces: [makeDecisionTrace(1)],
    agents: [makeAgent('story-001-001')],
    audit_tail: [makeAuditRow(101)],
  };
}

function validRichCase(id = 'le-rich-001') {
  return {
    id,
    source: 'rich',
    telemetry: minimalTelemetry(),
    rubric: {
      expected_themes: ['schema migrations must be idempotent'],
      over_extraction_traps: ['routine build steps are not lessons'],
    },
    rationale: 'Rich case for unit test.',
  };
}

function validThinCase(id = 'le-thin-001') {
  return {
    id,
    source: 'thin',
    telemetry: minimalTelemetry('epic-002'),
    rubric: {
      expected_themes: [],
      over_extraction_traps: ['trivial typo fix should yield no lessons'],
    },
    rationale: 'Thin case for unit test.',
  };
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-le-test-'));
}
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
function writeFixture(dir: string, name: string, data: unknown): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, yaml.dump(data), 'utf8');
  return p;
}

// ── Schema validation — accepts well-formed cases ─────────────────────────────

describe('LessonExtractorCaseSchema — accepts a well-formed rich case', () => {
  it('parses a valid rich case without throwing', () => {
    const result = LessonExtractorCaseSchema.safeParse(validRichCase());
    assert.ok(result.success, `Expected success, got: ${!result.success ? JSON.stringify(result.error.issues) : ''}`);
  });

  it('carries id and source through (GateEvalCase fields)', () => {
    const result = LessonExtractorCaseSchema.safeParse(validRichCase('le-rich-check'));
    assert.ok(result.success);
    if (!result.success) return;
    assert.equal(result.data.id, 'le-rich-check');
    assert.equal(result.data.source, 'rich');
  });
});

describe('LessonExtractorCaseSchema — accepts a well-formed thin case', () => {
  it('parses a valid thin case without throwing', () => {
    const result = LessonExtractorCaseSchema.safeParse(validThinCase());
    assert.ok(result.success, `Expected success, got: ${!result.success ? JSON.stringify(result.error.issues) : ''}`);
  });

  it('allows expected_themes to be empty for thin cases', () => {
    const c = { ...validThinCase(), rubric: { expected_themes: [], over_extraction_traps: ['trap one'] } };
    const result = LessonExtractorCaseSchema.safeParse(c);
    assert.ok(result.success, 'empty expected_themes must be allowed');
  });
});

// ── Schema validation — rejects malformed cases ───────────────────────────────

describe('LessonExtractorCaseSchema — rejects missing required fields', () => {
  it('rejects when id is missing', () => {
    const { id: _, ...noId } = validRichCase();
    assert.ok(!LessonExtractorCaseSchema.safeParse(noId).success, 'should fail with missing id');
  });

  it('rejects when source is missing', () => {
    const { source: _, ...noSource } = validRichCase();
    assert.ok(!LessonExtractorCaseSchema.safeParse(noSource).success, 'should fail with missing source');
  });

  it('rejects when rationale is missing', () => {
    const { rationale: _, ...noRationale } = validRichCase();
    assert.ok(!LessonExtractorCaseSchema.safeParse(noRationale).success, 'should fail with missing rationale');
  });

  it('rejects when rubric is missing', () => {
    const { rubric: _, ...noRubric } = validRichCase();
    assert.ok(!LessonExtractorCaseSchema.safeParse(noRubric).success, 'should fail with missing rubric');
  });

  it('rejects when telemetry is missing', () => {
    const { telemetry: _, ...noTelemetry } = validRichCase();
    assert.ok(!LessonExtractorCaseSchema.safeParse(noTelemetry).success, 'should fail with missing telemetry');
  });

  it('rejects empty rationale', () => {
    const result = LessonExtractorCaseSchema.safeParse({ ...validRichCase(), rationale: '' });
    assert.ok(!result.success, 'empty rationale must be rejected');
  });
});

describe('LessonExtractorCaseSchema — rejects invalid source enum', () => {
  it('rejects source outside rich|thin', () => {
    const result = LessonExtractorCaseSchema.safeParse({ ...validRichCase(), source: 'anchor' });
    assert.ok(!result.success, 'source=anchor must be rejected');
  });

  it('rejects source=medium', () => {
    const result = LessonExtractorCaseSchema.safeParse({ ...validRichCase(), source: 'medium' });
    assert.ok(!result.success, 'source=medium must be rejected');
  });
});

describe('LessonExtractorCaseSchema — rejects invalid rubric shapes', () => {
  it('rejects expected_themes containing an empty string', () => {
    const result = LessonExtractorCaseSchema.safeParse({
      ...validRichCase(),
      rubric: { expected_themes: [''], over_extraction_traps: ['valid trap'] },
    });
    assert.ok(!result.success, 'empty string in expected_themes must be rejected');
  });

  it('rejects over_extraction_traps that is empty (min(1) on array)', () => {
    const result = LessonExtractorCaseSchema.safeParse({
      ...validRichCase(),
      rubric: { expected_themes: ['some theme'], over_extraction_traps: [] },
    });
    assert.ok(!result.success, 'empty over_extraction_traps must be rejected');
  });

  it('rejects over_extraction_traps containing an empty string', () => {
    const result = LessonExtractorCaseSchema.safeParse({
      ...validRichCase(),
      rubric: { expected_themes: ['some theme'], over_extraction_traps: [''] },
    });
    assert.ok(!result.success, 'empty string in over_extraction_traps must be rejected');
  });
});

describe('LessonExtractorCaseSchema — rejects invalid telemetry shapes (EpicTelemetry mirror)', () => {
  it('rejects decision_traces as a non-array (wrong type)', () => {
    const bad = { ...validRichCase(), telemetry: { ...minimalTelemetry(), decision_traces: 'not-an-array' } };
    const result = LessonExtractorCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'decision_traces must be an array');
  });

  it('rejects decision_traces item with wrong id type (string instead of number)', () => {
    const badTrace = { ...makeDecisionTrace(1), id: 'abc' };
    const bad = { ...validRichCase(), telemetry: { ...minimalTelemetry(), decision_traces: [badTrace] } };
    const result = LessonExtractorCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'decision_traces item id must be a number');
  });

  it('rejects audit_tail item with wrong allowed type (string instead of boolean|null)', () => {
    const badRow = { ...makeAuditRow(1), allowed: 'yes' };
    const bad = { ...validRichCase(), telemetry: { ...minimalTelemetry(), audit_tail: [badRow] } };
    const result = LessonExtractorCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'audit_tail item allowed must be boolean or null');
  });

  it('rejects final_status outside done|failed', () => {
    const bad = { ...validRichCase(), telemetry: { ...minimalTelemetry(), final_status: 'cancelled' } };
    const result = LessonExtractorCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'final_status must be done|failed');
  });

  it('rejects missing audit_tail field', () => {
    const { audit_tail: _, ...noTail } = minimalTelemetry();
    const bad = { ...validRichCase(), telemetry: noTail };
    const result = LessonExtractorCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'missing audit_tail must be rejected');
  });
});

// ── Happy path — loader returns correct case structure ────────────────────────

describe('loadLessonExtractorCases — happy path with inline fixture', () => {
  it('returns an array of the expected length', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validRichCase('le-r-01'), validThinCase('le-t-01')] };
      const fp = writeFixture(tmp, 'test.yaml', fixture);

      const cases = loadLessonExtractorCases(fp);
      assert.equal(cases.length, 2, 'should return 2 cases matching the fixture');
    } finally {
      cleanup(tmp);
    }
  });

  it('single case: returns an array of length 1', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validRichCase('le-only-01')] };
      const fp = writeFixture(tmp, 'one-case.yaml', fixture);

      const cases = loadLessonExtractorCases(fp);
      assert.equal(cases.length, 1);
      assert.equal(cases[0].id, 'le-only-01');
    } finally {
      cleanup(tmp);
    }
  });

  it('each case carries GateEvalCase fields (id and source)', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validRichCase('le-r-id-01'), validThinCase('le-t-id-01')] };
      const fp = writeFixture(tmp, 'test-ids.yaml', fixture);

      const cases = loadLessonExtractorCases(fp);
      assert.equal(cases[0].id, 'le-r-id-01');
      assert.equal(cases[0].source, 'rich');
      assert.equal(cases[1].id, 'le-t-id-01');
      assert.equal(cases[1].source, 'thin');
    } finally {
      cleanup(tmp);
    }
  });

  it('each case satisfies LessonExtractorCaseSchema', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validRichCase('le-r-schema'), validThinCase('le-t-schema')] };
      const fp = writeFixture(tmp, 'schema-check.yaml', fixture);

      const cases = loadLessonExtractorCases(fp);
      for (const c of cases) {
        const result = LessonExtractorCaseSchema.safeParse(c);
        assert.ok(
          result.success,
          `case ${c.id} failed schema re-validation: ${!result.success ? JSON.stringify(result.error.issues) : ''}`,
        );
      }
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Rubric pass-through — exact value assertions ──────────────────────────────

describe('loadLessonExtractorCases — rubric pass-through', () => {
  const RICH_THEMES = [
    'schema migrations must be idempotent',
    'cross-story coordination requires explicit contracts',
  ];
  const RICH_TRAPS = [
    'routine npm test runs are expected and not a lesson',
    'sequential story execution is normal epic lifecycle',
  ];
  const THIN_TRAPS = ['a one-line typo fix with green tests should yield zero lessons'];

  it('preserves expected_themes for a rich case (exact values)', () => {
    const tmp = makeTmp();
    try {
      const c = {
        ...validRichCase('le-rubric-rich'),
        rubric: { expected_themes: RICH_THEMES, over_extraction_traps: RICH_TRAPS },
      };
      const fp = writeFixture(tmp, 'rubric-rich.yaml', { cases: [c] });

      const [loaded] = loadLessonExtractorCases(fp);
      assert.deepEqual(loaded.rubric.expected_themes, RICH_THEMES);
    } finally {
      cleanup(tmp);
    }
  });

  it('preserves over_extraction_traps for a rich case (exact values)', () => {
    const tmp = makeTmp();
    try {
      const c = {
        ...validRichCase('le-rubric-traps'),
        rubric: { expected_themes: RICH_THEMES, over_extraction_traps: RICH_TRAPS },
      };
      const fp = writeFixture(tmp, 'rubric-traps.yaml', { cases: [c] });

      const [loaded] = loadLessonExtractorCases(fp);
      assert.deepEqual(loaded.rubric.over_extraction_traps, RICH_TRAPS);
    } finally {
      cleanup(tmp);
    }
  });

  it('preserves empty expected_themes for a thin case (exact values)', () => {
    const tmp = makeTmp();
    try {
      const c = {
        ...validThinCase('le-rubric-thin'),
        rubric: { expected_themes: [], over_extraction_traps: THIN_TRAPS },
      };
      const fp = writeFixture(tmp, 'rubric-thin.yaml', { cases: [c] });

      const [loaded] = loadLessonExtractorCases(fp);
      assert.deepEqual(loaded.rubric.expected_themes, []);
      assert.deepEqual(loaded.rubric.over_extraction_traps, THIN_TRAPS);
    } finally {
      cleanup(tmp);
    }
  });

  it('rubric survives round-trip through YAML serialisation unchanged', () => {
    const tmp = makeTmp();
    try {
      const richCase = {
        ...validRichCase('le-roundtrip-rich'),
        rubric: { expected_themes: RICH_THEMES, over_extraction_traps: RICH_TRAPS },
      };
      const thinCase = {
        ...validThinCase('le-roundtrip-thin'),
        rubric: { expected_themes: [], over_extraction_traps: THIN_TRAPS },
      };
      const fp = writeFixture(tmp, 'roundtrip.yaml', { cases: [richCase, thinCase] });

      const [loadedRich, loadedThin] = loadLessonExtractorCases(fp);
      assert.deepEqual(loadedRich.rubric.expected_themes, RICH_THEMES);
      assert.deepEqual(loadedRich.rubric.over_extraction_traps, RICH_TRAPS);
      assert.deepEqual(loadedThin.rubric.expected_themes, []);
      assert.deepEqual(loadedThin.rubric.over_extraction_traps, THIN_TRAPS);
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Default path resolves production fixture ──────────────────────────────────

let productionFixturePresent: boolean;
try {
  defaultFixturePath();
  productionFixturePresent = true;
} catch (err) {
  if (err instanceof Error && /not found/i.test(err.message)) {
    productionFixturePresent = false;
  } else {
    throw err;
  }
}

describe('loadLessonExtractorCases — default fixture path', () => {
  it('loads lesson-extractor.yaml with no argument and returns validated cases', (t) => {
    if (!productionFixturePresent) { t.skip('production fixture not present'); return; }
    const cases = loadLessonExtractorCases();
    assert.ok(Array.isArray(cases), 'should return an array');
    assert.ok(cases.length >= 1, 'production fixture must have at least one case');
  });

  it('every case from the default fixture satisfies LessonExtractorCaseSchema', (t) => {
    if (!productionFixturePresent) { t.skip('production fixture not present'); return; }
    const cases = loadLessonExtractorCases();
    for (const c of cases) {
      const result = LessonExtractorCaseSchema.safeParse(c);
      assert.ok(
        result.success,
        `production case ${c.id} failed schema validation: ${!result.success ? JSON.stringify(result.error.issues) : ''}`,
      );
    }
  });

  it('production fixture includes at least one rich and one thin case', (t) => {
    if (!productionFixturePresent) { t.skip('production fixture not present'); return; }
    const cases = loadLessonExtractorCases();
    assert.ok(cases.some((c) => c.source === 'rich'), 'must have at least one rich case');
    assert.ok(cases.some((c) => c.source === 'thin'), 'must have at least one thin case');
  });

  it('is idempotent — repeated calls return the same count and first id', (t) => {
    if (!productionFixturePresent) { t.skip('production fixture not present'); return; }
    const first  = loadLessonExtractorCases();
    const second = loadLessonExtractorCases();
    assert.equal(first.length, second.length, 'same case count on repeated calls');
    assert.equal(first[0].id, second[0].id, 'first case id matches on repeated calls');
  });
});

// ── Explicit path is honored ──────────────────────────────────────────────────

describe('loadLessonExtractorCases — explicit fixture path', () => {
  it('loads a custom fixture when an explicit path is provided', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validRichCase('le-custom-01')] };
      const fp = writeFixture(tmp, 'custom.yaml', fixture);

      const cases = loadLessonExtractorCases(fp);
      assert.equal(cases.length, 1, 'should return 1 case from custom fixture');
      assert.equal(cases[0].id, 'le-custom-01');
    } finally {
      cleanup(tmp);
    }
  });

  it('explicit path loads only the cases from that file', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validThinCase('le-explicit-thin-01')] };
      const fp = writeFixture(tmp, 'explicit.yaml', fixture);

      const custom = loadLessonExtractorCases(fp);
      assert.equal(custom.length, 1, 'custom fixture has exactly one case');
      assert.equal(custom[0].id, 'le-explicit-thin-01', 'case id matches the custom fixture');
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Fail-fast on bad fixtures ─────────────────────────────────────────────────

describe('loadLessonExtractorCases — throws when path does not exist', () => {
  it('throws a descriptive error for a nonexistent file', () => {
    assert.throws(
      () => loadLessonExtractorCases('/tmp/loom-nonexistent-le-fixture-xyz.yaml'),
      /not found/i,
    );
  });
});

describe('loadLessonExtractorCases — fail-fast on invalid fixtures', () => {
  it('throws (zod) when cases array is empty', () => {
    const tmp = makeTmp();
    try {
      const fp = writeFixture(tmp, 'empty.yaml', { cases: [] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when a case has missing required field (id)', () => {
    const tmp = makeTmp();
    try {
      const { id: _, ...noId } = validRichCase();
      const fp = writeFixture(tmp, 'no-id.yaml', { cases: [noId] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when source is outside rich|thin', () => {
    const tmp = makeTmp();
    try {
      const fp = writeFixture(tmp, 'bad-source.yaml', { cases: [{ ...validRichCase(), source: 'anchor' }] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when expected_themes contains an empty string', () => {
    const tmp = makeTmp();
    try {
      const c = { ...validRichCase(), rubric: { expected_themes: [''], over_extraction_traps: ['valid'] } };
      const fp = writeFixture(tmp, 'empty-theme.yaml', { cases: [c] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when over_extraction_traps is empty (min(1) on array)', () => {
    const tmp = makeTmp();
    try {
      const c = { ...validRichCase(), rubric: { expected_themes: ['theme'], over_extraction_traps: [] } };
      const fp = writeFixture(tmp, 'empty-traps.yaml', { cases: [c] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when over_extraction_traps contains an empty string', () => {
    const tmp = makeTmp();
    try {
      const c = { ...validRichCase(), rubric: { expected_themes: ['theme'], over_extraction_traps: [''] } };
      const fp = writeFixture(tmp, 'empty-trap-str.yaml', { cases: [c] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when decision_traces is not an array (telemetry shape violation)', () => {
    const tmp = makeTmp();
    try {
      const c = { ...validRichCase(), telemetry: { ...minimalTelemetry(), decision_traces: 'bad' } };
      const fp = writeFixture(tmp, 'bad-traces.yaml', { cases: [c] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when a decision_trace has wrong id type (telemetry shape violation)', () => {
    const tmp = makeTmp();
    try {
      const badTrace = { ...makeDecisionTrace(1), id: 'should-be-number' };
      const c = { ...validRichCase(), telemetry: { ...minimalTelemetry(), decision_traces: [badTrace] } };
      const fp = writeFixture(tmp, 'bad-trace-id.yaml', { cases: [c] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when final_status is outside done|failed (telemetry shape violation)', () => {
    const tmp = makeTmp();
    try {
      const c = { ...validRichCase(), telemetry: { ...minimalTelemetry(), final_status: 'pending' } };
      const fp = writeFixture(tmp, 'bad-status.yaml', { cases: [c] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when audit_tail item has wrong allowed type (string instead of boolean|null)', () => {
    const tmp = makeTmp();
    try {
      const badRow = { ...makeAuditRow(1), allowed: 'yes' };
      const c = { ...validRichCase(), telemetry: { ...minimalTelemetry(), audit_tail: [badRow] } };
      const fp = writeFixture(tmp, 'bad-audit-allowed.yaml', { cases: [c] });
      assert.throws(() => loadLessonExtractorCases(fp));
    } finally {
      cleanup(tmp);
    }
  });
});
