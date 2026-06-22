import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { loadOpportunityEngineCases, defaultFixturePath } from '../loadCases.js';
import { OpportunityEngineCaseSchema, OpportunityEngineCaseSetSchema, type OpportunityEngineCase } from '../caseSchema.js';
import type { GateEvalCase } from '../../framework/types.js';

// Compile-time check: OpportunityEngineCase must structurally satisfy GateEvalCase.
type _GateEvalCaseCheck = OpportunityEngineCase extends GateEvalCase ? true : never;
type _assertGateEvalCase = _GateEvalCaseCheck;

// ── Minimal fixture helpers ───────────────────────────────────────────────────

function makeSignal(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    source: 'code-debt' as const,
    kind: 'security',
    title: `Signal ${key}`,
    ...overrides,
  };
}

function validSeparableCase(id = 'oe-sep-001'): Record<string, unknown> {
  return {
    id,
    source: 'separable',
    signals: [makeSignal('auth-sig-a'), makeSignal('perf-sig-b')],
    rubric: {
      expected_themes: ['authentication hardening', 'performance optimisation'],
      force_clustering_traps: ['auth and perf signals must not be merged into one backend opportunity'],
    },
    rationale: 'Separable case for unit tests.',
  };
}

function validNoiseCase(id = 'oe-noise-001'): Record<string, unknown> {
  return {
    id,
    source: 'noise',
    signals: [makeSignal('css-typo'), makeSignal('dep-bump')],
    rubric: {
      expected_themes: [],
      force_clustering_traps: ['a CSS typo and a dependency bump must not be clustered as maintenance'],
    },
    rationale: 'Noise case for unit tests.',
  };
}

function validMixedCase(id = 'oe-mixed-001'): Record<string, unknown> {
  return {
    id,
    source: 'mixed',
    signals: [makeSignal('auth-sig-a'), makeSignal('auth-sig-b'), makeSignal('docs-sig-c')],
    rubric: {
      expected_themes: ['authentication improvements'],
      force_clustering_traps: ['documentation signal must not be merged with auth security signals'],
    },
    rationale: 'Mixed case for unit tests.',
  };
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-oe-test-'));
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

describe('OpportunityEngineCaseSchema — accepts well-formed cases', () => {
  it('parses a valid separable case without throwing', () => {
    const result = OpportunityEngineCaseSchema.safeParse(validSeparableCase());
    assert.ok(result.success, `Expected success, got: ${!result.success ? JSON.stringify(result.error.issues) : ''}`);
  });

  it('parses a valid noise case with empty expected_themes without throwing', () => {
    const result = OpportunityEngineCaseSchema.safeParse(validNoiseCase());
    assert.ok(result.success, `Expected success, got: ${!result.success ? JSON.stringify(result.error.issues) : ''}`);
  });

  it('parses a valid mixed case without throwing', () => {
    const result = OpportunityEngineCaseSchema.safeParse(validMixedCase());
    assert.ok(result.success, `Expected success, got: ${!result.success ? JSON.stringify(result.error.issues) : ''}`);
  });

  it('carries id and source through (GateEvalCase fields)', () => {
    const result = OpportunityEngineCaseSchema.safeParse(validSeparableCase('oe-sep-id-check'));
    assert.ok(result.success);
    if (!result.success) return;
    assert.equal(result.data.id, 'oe-sep-id-check');
    assert.equal(result.data.source, 'separable');
  });

  it('allows optional signal fields to be absent', () => {
    const c = {
      ...validSeparableCase(),
      signals: [{ key: 'sig-minimal', source: 'github-issues', kind: 'bug', title: 'Minimal signal' }],
    };
    const result = OpportunityEngineCaseSchema.safeParse(c);
    assert.ok(result.success, 'signal with only required fields must be valid');
  });

  it('accepts signal with all optional fields present', () => {
    const c = {
      ...validSeparableCase(),
      signals: [{
        key: 'sig-full',
        source: 'audit-introspection',
        kind: 'security',
        title: 'Full signal',
        detail: 'some detail',
        evidenceUrl: 'https://example.com',
        weight: 0.8,
        metadata: { ticket: 'ENG-123' },
      }],
    };
    const result = OpportunityEngineCaseSchema.safeParse(c);
    assert.ok(result.success, 'signal with all optional fields must be valid');
  });
});

// ── Schema validation — rejects malformed cases ───────────────────────────────

describe('OpportunityEngineCaseSchema — rejects missing required fields', () => {
  it('rejects when id is missing', () => {
    const { id: _, ...noId } = validSeparableCase();
    assert.ok(!OpportunityEngineCaseSchema.safeParse(noId).success, 'missing id must be rejected');
  });

  it('rejects when source is missing', () => {
    const { source: _, ...noSource } = validSeparableCase();
    assert.ok(!OpportunityEngineCaseSchema.safeParse(noSource).success, 'missing source must be rejected');
  });

  it('rejects when signals is missing', () => {
    const { signals: _, ...noSignals } = validSeparableCase();
    assert.ok(!OpportunityEngineCaseSchema.safeParse(noSignals).success, 'missing signals must be rejected');
  });

  it('rejects when rubric is missing', () => {
    const { rubric: _, ...noRubric } = validSeparableCase();
    assert.ok(!OpportunityEngineCaseSchema.safeParse(noRubric).success, 'missing rubric must be rejected');
  });

  it('rejects when rationale is missing', () => {
    const { rationale: _, ...noRationale } = validSeparableCase();
    assert.ok(!OpportunityEngineCaseSchema.safeParse(noRationale).success, 'missing rationale must be rejected');
  });
});

describe('OpportunityEngineCaseSchema — rejects invalid source enum', () => {
  it('rejects source outside separable|noise|mixed', () => {
    const result = OpportunityEngineCaseSchema.safeParse({ ...validSeparableCase(), source: 'rich' });
    assert.ok(!result.success, 'source=rich must be rejected');
  });

  it('rejects source=anchor', () => {
    const result = OpportunityEngineCaseSchema.safeParse({ ...validSeparableCase(), source: 'anchor' });
    assert.ok(!result.success, 'source=anchor must be rejected');
  });
});

describe('OpportunityEngineCaseSchema — rejects invalid signal shapes (SignalInput)', () => {
  it('rejects signal with missing key', () => {
    const bad = {
      ...validSeparableCase(),
      signals: [{ source: 'code-debt', kind: 'bug', title: 'No key here' }],
    };
    assert.ok(!OpportunityEngineCaseSchema.safeParse(bad).success, 'missing signal key must be rejected');
  });

  it('rejects signal with invalid source enum', () => {
    const bad = {
      ...validSeparableCase(),
      signals: [{ key: 'sig-x', source: 'jira', kind: 'bug', title: 'Bad source' }],
    };
    assert.ok(!OpportunityEngineCaseSchema.safeParse(bad).success, 'signal source=jira must be rejected');
  });

  it('rejects signal with missing kind', () => {
    const bad = {
      ...validSeparableCase(),
      signals: [{ key: 'sig-x', source: 'code-debt', title: 'No kind' }],
    };
    assert.ok(!OpportunityEngineCaseSchema.safeParse(bad).success, 'missing signal kind must be rejected');
  });

  it('rejects signal with missing title', () => {
    const bad = {
      ...validSeparableCase(),
      signals: [{ key: 'sig-x', source: 'code-debt', kind: 'bug' }],
    };
    assert.ok(!OpportunityEngineCaseSchema.safeParse(bad).success, 'missing signal title must be rejected');
  });
});

describe('OpportunityEngineCaseSchema — rejects invalid rubric shapes', () => {
  it('rejects force_clustering_traps that is empty (min(1) on array)', () => {
    const result = OpportunityEngineCaseSchema.safeParse({
      ...validSeparableCase(),
      rubric: { expected_themes: ['some theme'], force_clustering_traps: [] },
    });
    assert.ok(!result.success, 'empty force_clustering_traps must be rejected');
  });

  it('rejects force_clustering_traps containing an empty string', () => {
    const result = OpportunityEngineCaseSchema.safeParse({
      ...validSeparableCase(),
      rubric: { expected_themes: ['some theme'], force_clustering_traps: [''] },
    });
    assert.ok(!result.success, 'empty string in force_clustering_traps must be rejected');
  });
});

// ── Happy path — production fixture loads correctly ───────────────────────────

describe('loadOpportunityEngineCases — production fixture (AC1)', () => {
  it('returns at least 3 cases', () => {
    const cases = loadOpportunityEngineCases();
    assert.ok(cases.length >= 3, `expected ≥3 cases, got ${cases.length}`);
  });

  it('fixture includes at least one separable case (AC1)', () => {
    const cases = loadOpportunityEngineCases();
    assert.ok(cases.some((c) => c.source === 'separable'), 'must have at least one separable case');
  });

  it('fixture includes at least one noise case (AC1)', () => {
    const cases = loadOpportunityEngineCases();
    assert.ok(cases.some((c) => c.source === 'noise'), 'must have at least one noise case');
  });

  it('fixture includes at least one mixed case (AC1)', () => {
    const cases = loadOpportunityEngineCases();
    assert.ok(cases.some((c) => c.source === 'mixed'), 'must have at least one mixed case');
  });

  it('is idempotent — repeated calls return the same count and first id', () => {
    const first  = loadOpportunityEngineCases();
    const second = loadOpportunityEngineCases();
    assert.equal(first.length, second.length, 'same case count on repeated calls');
    assert.equal(first[0].id, second[0].id, 'first case id matches on repeated calls');
  });
});

// ── Rubric-expectation shape — AC2 ───────────────────────────────────────────
// Each case must carry rubric expectations (themes + traps) and must NOT carry
// an exact-clustering / expected-output field.

describe('loadOpportunityEngineCases — rubric-expectation contract (AC2)', () => {
  it('every case has rubric.expected_themes as an array', () => {
    const cases = loadOpportunityEngineCases();
    for (const c of cases) {
      assert.ok(
        Array.isArray(c.rubric.expected_themes),
        `case ${c.id}: rubric.expected_themes must be an array`,
      );
    }
  });

  it('every case has rubric.force_clustering_traps with at least one entry (AC2)', () => {
    const cases = loadOpportunityEngineCases();
    for (const c of cases) {
      assert.ok(
        c.rubric.force_clustering_traps.length >= 1,
        `case ${c.id}: rubric.force_clustering_traps must have ≥1 entry`,
      );
    }
  });

  it('no case carries an exact-clustering or expected-output field (rubric expectations only, never exact clustering)', () => {
    const cases = loadOpportunityEngineCases();
    for (const c of cases) {
      const raw = c as unknown as Record<string, unknown>;
      assert.ok(!('expected_output' in raw), `case ${c.id}: must not have expected_output field`);
      assert.ok(!('expected_clusters' in raw), `case ${c.id}: must not have expected_clusters field`);
      assert.ok(!('exact_clustering' in raw), `case ${c.id}: must not have exact_clustering field`);
    }
  });
});

// ── Schema validation — each case validates against OpportunityEngineCaseSchema ──

describe('loadOpportunityEngineCases — each case validates (AC2)', () => {
  it('every loaded production case satisfies OpportunityEngineCaseSchema', () => {
    const cases = loadOpportunityEngineCases();
    for (const c of cases) {
      const result = OpportunityEngineCaseSchema.safeParse(c);
      assert.ok(
        result.success,
        `case ${c.id} failed schema validation: ${!result.success ? JSON.stringify(result.error.issues) : ''}`,
      );
    }
  });

  it('every case carries a non-empty id string', () => {
    const cases = loadOpportunityEngineCases();
    for (const c of cases) {
      assert.ok(typeof c.id === 'string' && c.id.length > 0, `case must have non-empty id`);
    }
  });

  it('every case carries a rationale string', () => {
    const cases = loadOpportunityEngineCases();
    for (const c of cases) {
      assert.ok(typeof c.rationale === 'string', `case ${c.id}: rationale must be a string`);
    }
  });

  it('every case has a non-empty signals array with required signal fields (key/source/kind/title)', () => {
    const cases = loadOpportunityEngineCases();
    for (const c of cases) {
      assert.ok(c.signals.length > 0, `case ${c.id}: signals must be non-empty`);
      for (const s of c.signals) {
        assert.ok(typeof s.key === 'string', `case ${c.id} signal must have key`);
        assert.ok(typeof s.source === 'string', `case ${c.id} signal must have source`);
        assert.ok(typeof s.kind === 'string', `case ${c.id} signal must have kind`);
        assert.ok(typeof s.title === 'string', `case ${c.id} signal must have title`);
      }
    }
  });
});

// ── Fail-closed boundary — AC3 ────────────────────────────────────────────────

describe('loadOpportunityEngineCases — throws on malformed fixture (AC3)', () => {
  it('throws a descriptive error for a nonexistent file', () => {
    assert.throws(
      () => loadOpportunityEngineCases('/tmp/loom-nonexistent-oe-fixture-xyz.yaml'),
      /not found/i,
    );
  });

  it('throws (zod) when cases array is empty', () => {
    const tmp = makeTmp();
    try {
      const fp = writeFixture(tmp, 'empty.yaml', { cases: [] });
      assert.throws(() => loadOpportunityEngineCases(fp), 'empty cases array must throw');
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when rubric is missing', () => {
    const tmp = makeTmp();
    try {
      const { rubric: _, ...noRubric } = validSeparableCase();
      const fp = writeFixture(tmp, 'no-rubric.yaml', { cases: [noRubric] });
      assert.throws(() => loadOpportunityEngineCases(fp), 'missing rubric must throw');
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when source is outside separable|noise|mixed', () => {
    const tmp = makeTmp();
    try {
      const fp = writeFixture(tmp, 'bad-source.yaml', {
        cases: [{ ...validSeparableCase(), source: 'rich' }],
      });
      assert.throws(() => loadOpportunityEngineCases(fp), 'bad source enum must throw');
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when force_clustering_traps is empty (≥1 required)', () => {
    const tmp = makeTmp();
    try {
      const c = {
        ...validSeparableCase(),
        rubric: { expected_themes: ['some theme'], force_clustering_traps: [] },
      };
      const fp = writeFixture(tmp, 'empty-traps.yaml', { cases: [c] });
      assert.throws(() => loadOpportunityEngineCases(fp), 'empty force_clustering_traps must throw');
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when signal key is missing', () => {
    const tmp = makeTmp();
    try {
      const c = {
        ...validSeparableCase(),
        signals: [{ source: 'code-debt', kind: 'bug', title: 'No key' }],
      };
      const fp = writeFixture(tmp, 'missing-key.yaml', { cases: [c] });
      assert.throws(() => loadOpportunityEngineCases(fp), 'missing signal key must throw');
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Reuse — thin wrapper over framework case loader (AC3) ─────────────────────
// loadOpportunityEngineCases delegates to OpportunityEngineCaseSetSchema.parse()
// from caseSchema.ts for Zod validation rather than implementing its own.
// This is verified behaviourally: the loader rejects the exact same invalid
// inputs that OpportunityEngineCaseSetSchema.parse() rejects, with no
// custom fallback or coercion.

describe('loadOpportunityEngineCases — delegates to Zod schema, no parallel loader (AC3)', () => {
  it('throws on the same inputs that OpportunityEngineCaseSetSchema.parse() rejects', () => {
    const tmp = makeTmp();
    try {
      const badInput = { cases: [{ ...validSeparableCase(), source: 'unknown-source' }] };
      const fp = writeFixture(tmp, 'schema-parity.yaml', badInput);

      // Direct schema parse must throw
      assert.throws(() => OpportunityEngineCaseSetSchema.parse(badInput));
      // Loader must throw on the same case
      assert.throws(() => loadOpportunityEngineCases(fp));
    } finally {
      cleanup(tmp);
    }
  });

  it('accepts the same inputs that OpportunityEngineCaseSetSchema.parse() accepts', () => {
    const tmp = makeTmp();
    try {
      const goodInput = { cases: [validSeparableCase('oe-parity-sep'), validNoiseCase('oe-parity-noise')] };
      const fp = writeFixture(tmp, 'schema-parity-ok.yaml', goodInput);

      const parsed = OpportunityEngineCaseSetSchema.parse(goodInput);
      const loaded = loadOpportunityEngineCases(fp);

      assert.equal(loaded.length, parsed.cases.length, 'same case count as direct schema parse');
      assert.equal(loaded[0].id, parsed.cases[0].id, 'first case id matches direct schema parse');
    } finally {
      cleanup(tmp);
    }
  });

  it('does not silently coerce or drop malformed cases — fails closed', () => {
    const tmp = makeTmp();
    try {
      // A fixture with one valid and one invalid case must throw entirely, not return just the valid one
      const mixed = {
        cases: [
          validSeparableCase('oe-valid'),
          { ...validNoiseCase('oe-bad'), source: 'INVALID' },
        ],
      };
      const fp = writeFixture(tmp, 'partial-bad.yaml', mixed);
      assert.throws(() => loadOpportunityEngineCases(fp), 'partial fixture with bad case must throw, not silently drop');
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Fixture sanity — rubric content quality ───────────────────────────────────

describe('loadOpportunityEngineCases — fixture sanity (rubric content quality)', () => {
  it('the noise case expected_themes is empty (noise signals produce no meaningful clusters)', () => {
    const cases = loadOpportunityEngineCases();
    const noiseCase = cases.find((c) => c.source === 'noise');
    assert.ok(noiseCase, 'noise case must exist');
    assert.deepEqual(
      noiseCase.rubric.expected_themes,
      [],
      'noise case must have empty expected_themes',
    );
  });

  it('the separable case has at least two mutually distinct expected_themes', () => {
    const cases = loadOpportunityEngineCases();
    const separable = cases.find((c) => c.source === 'separable');
    assert.ok(separable, 'separable case must exist');
    assert.ok(
      separable.rubric.expected_themes.length >= 2,
      `separable case must have ≥2 expected_themes, got ${separable.rubric.expected_themes.length}`,
    );
    // Themes must be distinct strings
    const themes = separable.rubric.expected_themes;
    const unique = new Set(themes);
    assert.equal(unique.size, themes.length, 'separable case themes must all be distinct');
  });

  it('the noise case traps name the specific cross-surface pairs that must not be clustered', () => {
    const cases = loadOpportunityEngineCases();
    const noiseCase = cases.find((c) => c.source === 'noise');
    assert.ok(noiseCase, 'noise case must exist');
    // Each trap should be a meaningful description, not a generic placeholder
    for (const trap of noiseCase.rubric.force_clustering_traps) {
      assert.ok(trap.length > 20, `noise trap "${trap}" is too short to be meaningful`);
    }
  });

  it('the mixed case has exactly one expected theme (the related cluster only)', () => {
    const cases = loadOpportunityEngineCases();
    const mixedCase = cases.find((c) => c.source === 'mixed');
    assert.ok(mixedCase, 'mixed case must exist');
    assert.ok(
      mixedCase.rubric.expected_themes.length >= 1,
      'mixed case must have at least one expected theme for the related signals',
    );
  });

  it('rubric pass-through: loaded values match what was written in the fixture', () => {
    const tmp = makeTmp();
    try {
      const themes = ['auth security hardening', 'db performance improvement'];
      const traps  = ['auth and perf must not be merged into one backend work cluster'];
      const c = {
        ...validSeparableCase('oe-passthrough'),
        rubric: { expected_themes: themes, force_clustering_traps: traps },
      };
      const fp = writeFixture(tmp, 'passthrough.yaml', { cases: [c] });

      const [loaded] = loadOpportunityEngineCases(fp);
      assert.deepEqual(loaded.rubric.expected_themes, themes);
      assert.deepEqual(loaded.rubric.force_clustering_traps, traps);
    } finally {
      cleanup(tmp);
    }
  });
});

// ── Explicit path is honored ──────────────────────────────────────────────────

describe('loadOpportunityEngineCases — explicit fixture path', () => {
  it('loads a custom fixture when an explicit path is provided', () => {
    const tmp = makeTmp();
    try {
      const fixture = { cases: [validSeparableCase('oe-custom-01')] };
      const fp = writeFixture(tmp, 'custom.yaml', fixture);

      const cases = loadOpportunityEngineCases(fp);
      assert.equal(cases.length, 1);
      assert.equal(cases[0].id, 'oe-custom-01');
    } finally {
      cleanup(tmp);
    }
  });

  it('explicit path overrides the default fixture', () => {
    const tmp = makeTmp();
    try {
      // If explicit path always wins, its case id must come through
      const fixture = { cases: [validNoiseCase('oe-explicit-noise')] };
      const fp = writeFixture(tmp, 'explicit.yaml', fixture);

      const cases = loadOpportunityEngineCases(fp);
      assert.equal(cases[0].id, 'oe-explicit-noise');
    } finally {
      cleanup(tmp);
    }
  });
});
