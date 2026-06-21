import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { loadBriefQualityCases } from '../loadCases.js';
import { BriefQualityCaseSchema } from '../caseSchema.js';
import { BANDS, BAND_TOLERANCE } from '../bands.js';

// ── Band / tolerance pin tests (AC3) ─────────────────────────────────────────

describe('bands — config constants', () => {
  it('BANDS.low is [0, 3]', () => {
    assert.deepEqual(BANDS.low, [0, 3]);
  });

  it('BANDS.mid is [4, 6]', () => {
    assert.deepEqual(BANDS.mid, [4, 6]);
  });

  it('BANDS.high is [7, 10]', () => {
    assert.deepEqual(BANDS.high, [7, 10]);
  });

  it('BAND_TOLERANCE is 1', () => {
    assert.equal(BAND_TOLERANCE, 1);
  });
});

// ── Schema validation (AC2) ───────────────────────────────────────────────────

describe('BriefQualityCaseSchema — accepts a well-formed case', () => {
  const GOOD_CASE = {
    id:              'bq-test-001',
    source:          'anchor',
    category:        'plan-ready',
    brief:           'Add a --version flag to the loom CLI.',
    expected_ready:  true,
    expected_band:   'high',
    critique_themes: ['well-bounded scope', 'explicit success criterion'],
    rationale:       'Classic single-concern CLI addition.',
  };

  it('parses a valid case without throwing', () => {
    const result = BriefQualityCaseSchema.safeParse(GOOD_CASE);
    assert.ok(result.success, `Expected success, got: ${!result.success ? JSON.stringify(result.error) : ''}`);
  });
});

describe('BriefQualityCaseSchema — rejects malformed cases', () => {
  function good(): Record<string, unknown> {
    return {
      id:              'bq-test-001',
      source:          'anchor',
      category:        'plan-ready',
      brief:           'Add a --version flag.',
      expected_ready:  true,
      expected_band:   'high',
      critique_themes: ['bounded scope'],
      rationale:       'Narrow change.',
    };
  }

  it('rejects missing expected_ready', () => {
    const bad = good();
    delete bad.expected_ready;
    const result = BriefQualityCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'should fail when expected_ready is missing');
  });

  it('rejects expected_band outside the {low,mid,high} enum', () => {
    const bad = { ...good(), expected_band: 'excellent' };
    const result = BriefQualityCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'should fail for unknown band value');
  });

  it('rejects empty critique_themes (min 1 required)', () => {
    const bad = { ...good(), critique_themes: [] };
    const result = BriefQualityCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'should fail for empty critique_themes array');
  });

  it('rejects empty brief', () => {
    const bad = { ...good(), brief: '' };
    const result = BriefQualityCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'should fail for empty brief string');
  });

  it('rejects invalid category', () => {
    const bad = { ...good(), category: 'unclear' };
    const result = BriefQualityCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'should fail for unknown category value');
  });

  it('rejects invalid source', () => {
    const bad = { ...good(), source: 'unknown-source' };
    const result = BriefQualityCaseSchema.safeParse(bad);
    assert.ok(!result.success, 'should fail for unknown source value');
  });
});

// ── Default fixture loads and validates (AC5) ─────────────────────────────────

describe('loadBriefQualityCases — default fixture', () => {
  it('loads brief-quality.yaml with no argument and returns validated cases', () => {
    const cases = loadBriefQualityCases();
    assert.ok(Array.isArray(cases), 'should return an array');
    assert.ok(cases.length > 0, 'should return at least one case');
  });

  it('every returned case satisfies BriefQualityCaseSchema', () => {
    const cases = loadBriefQualityCases();
    for (const c of cases) {
      const result = BriefQualityCaseSchema.safeParse(c);
      assert.ok(result.success, `case ${c.id} failed schema validation: ${!result.success ? JSON.stringify(result.error.issues) : ''}`);
    }
  });

  it('is idempotent — repeated calls return the same count and first id', () => {
    const first  = loadBriefQualityCases();
    const second = loadBriefQualityCases();
    assert.equal(first.length, second.length, 'same case count on repeated calls');
    assert.equal(first[0].id,  second[0].id,  'first case id matches on repeated calls');
  });
});

// ── Balance & coverage (AC1) ──────────────────────────────────────────────────

describe('loadBriefQualityCases — fixture balance', () => {
  it('contains all three category values', () => {
    const cases = loadBriefQualityCases();
    const categories = new Set(cases.map((c) => c.category));
    assert.ok(categories.has('plan-ready'),  'should have plan-ready cases');
    assert.ok(categories.has('not-ready'),   'should have not-ready cases');
    assert.ok(categories.has('borderline'),  'should have borderline cases');
  });

  it('no category is empty or completely dominant (≥1 and ≤60% of total)', () => {
    const cases = loadBriefQualityCases();
    const total = cases.length;
    const counts = {
      'plan-ready': cases.filter((c) => c.category === 'plan-ready').length,
      'not-ready':  cases.filter((c) => c.category === 'not-ready').length,
      'borderline': cases.filter((c) => c.category === 'borderline').length,
    };
    for (const [cat, count] of Object.entries(counts)) {
      assert.ok(count >= 1, `category "${cat}" must have at least 1 case`);
      assert.ok(
        count / total <= 0.6,
        `category "${cat}" is too dominant: ${count}/${total} = ${(count / total * 100).toFixed(0)}%`,
      );
    }
  });
});

// ── Minimum size (AC4) ────────────────────────────────────────────────────────

describe('loadBriefQualityCases — minimum set size', () => {
  it('case count is at or above minScoredCases threshold (≥5)', () => {
    const MIN_SCORED_CASES = 5;
    const cases = loadBriefQualityCases();
    assert.ok(
      cases.length >= MIN_SCORED_CASES,
      `fixture has ${cases.length} cases but needs ≥${MIN_SCORED_CASES}`,
    );
  });
});

// ── Label sanity (AC2 / AC5) ──────────────────────────────────────────────────

describe('loadBriefQualityCases — label sanity', () => {
  it('plan-ready cases have expected_ready=true', () => {
    const cases = loadBriefQualityCases();
    for (const c of cases.filter((c) => c.category === 'plan-ready')) {
      assert.ok(
        c.expected_ready === true,
        `case ${c.id}: plan-ready category should have expected_ready=true`,
      );
    }
  });

  it('not-ready cases have expected_ready=false', () => {
    const cases = loadBriefQualityCases();
    for (const c of cases.filter((c) => c.category === 'not-ready')) {
      assert.ok(
        c.expected_ready === false,
        `case ${c.id}: not-ready category should have expected_ready=false`,
      );
    }
  });

  it('every expected_band is a valid enum member (low | mid | high)', () => {
    const cases = loadBriefQualityCases();
    const valid = new Set(['low', 'mid', 'high']);
    for (const c of cases) {
      assert.ok(valid.has(c.expected_band), `case ${c.id} has unexpected band: ${c.expected_band}`);
    }
  });
});

// ── Explicit-path and error-path tests (AC5) ──────────────────────────────────

describe('loadBriefQualityCases — explicit fixture path', () => {
  function makeTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bq-test-'));
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
            id:              'bq-custom-01',
            source:          'anchor',
            category:        'plan-ready',
            brief:           'Add --version flag.',
            expected_ready:  true,
            expected_band:   'high',
            critique_themes: ['bounded scope'],
            rationale:       'Single-concern CLI addition.',
          },
          {
            id:              'bq-custom-02',
            source:          'anchor',
            category:        'not-ready',
            brief:           'Make it faster.',
            expected_ready:  false,
            expected_band:   'low',
            critique_themes: ['no metric', 'untestable'],
            rationale:       'No scope.',
          },
          {
            id:              'bq-custom-03',
            source:          'borderline',
            category:        'borderline',
            brief:           'Add retry with exponential backoff.',
            expected_ready:  false,
            expected_band:   'mid',
            critique_themes: ['jitter policy missing'],
            rationale:       'Has mechanism but gaps remain.',
          },
          {
            id:              'bq-custom-04',
            source:          'anchor',
            category:        'plan-ready',
            brief:           'Add auth gate to dashboard.',
            expected_ready:  true,
            expected_band:   'high',
            critique_themes: ['storage explicit', 'error path named'],
            rationale:       'Auth brief with concrete constraints.',
          },
          {
            id:              'bq-custom-05',
            source:          'derived',
            category:        'not-ready',
            brief:           'Improve logging.',
            expected_ready:  false,
            expected_band:   'low',
            critique_themes: ['no format specified'],
            rationale:       'Vague observability request.',
          },
        ],
      };
      const fixturePath = path.join(tmp, 'custom-bq.yaml');
      fs.writeFileSync(fixturePath, yaml.dump(fixture), 'utf8');

      const cases = loadBriefQualityCases(fixturePath);
      assert.equal(cases.length, 5, 'should return 5 cases from custom fixture');
      assert.equal(cases[0].id, 'bq-custom-01');
      assert.equal(cases[0].expected_band, 'high');
    } finally {
      cleanup(tmp);
    }
  });

  it('throws when explicit path does not exist', () => {
    assert.throws(
      () => loadBriefQualityCases('/tmp/loom-nonexistent-bq-fixture-xyz.yaml'),
      /not found/i,
    );
  });

  it('throws (zod) when fixture has empty cases array', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'empty-cases.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({ cases: [] }), 'utf8');
      assert.throws(() => loadBriefQualityCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when a case has missing expected_ready', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'missing-expected-ready.yaml');
      const bad = {
        cases: [
          {
            id: 'bq-bad-01',
            source: 'anchor',
            category: 'plan-ready',
            brief: 'Some brief.',
            expected_band: 'high',
            critique_themes: ['a theme'],
            rationale: 'A rationale.',
            // missing: expected_ready
          },
        ],
      };
      fs.writeFileSync(fixturePath, yaml.dump(bad), 'utf8');
      assert.throws(() => loadBriefQualityCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when expected_band is outside the enum', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'bad-band.yaml');
      const bad = {
        cases: [
          {
            id: 'bq-bad-02',
            source: 'anchor',
            category: 'plan-ready',
            brief: 'Some brief.',
            expected_ready: true,
            expected_band: 'excellent',  // invalid
            critique_themes: ['a theme'],
            rationale: 'A rationale.',
          },
        ],
      };
      fs.writeFileSync(fixturePath, yaml.dump(bad), 'utf8');
      assert.throws(() => loadBriefQualityCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when critique_themes is empty', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'empty-themes.yaml');
      const bad = {
        cases: [
          {
            id: 'bq-bad-03',
            source: 'anchor',
            category: 'plan-ready',
            brief: 'Some brief.',
            expected_ready: true,
            expected_band: 'high',
            critique_themes: [],  // invalid — min 1
            rationale: 'A rationale.',
          },
        ],
      };
      fs.writeFileSync(fixturePath, yaml.dump(bad), 'utf8');
      assert.throws(() => loadBriefQualityCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when brief is an empty string', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'empty-brief.yaml');
      const bad = {
        cases: [
          {
            id: 'bq-bad-04',
            source: 'anchor',
            category: 'plan-ready',
            brief: '',  // invalid — min 1
            expected_ready: true,
            expected_band: 'high',
            critique_themes: ['a theme'],
            rationale: 'A rationale.',
          },
        ],
      };
      fs.writeFileSync(fixturePath, yaml.dump(bad), 'utf8');
      assert.throws(() => loadBriefQualityCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });

  it('throws (zod) when category is invalid', () => {
    const tmp = makeTmp();
    try {
      const fixturePath = path.join(tmp, 'bad-category.yaml');
      const bad = {
        cases: [
          {
            id: 'bq-bad-05',
            source: 'anchor',
            category: 'unclear',  // invalid
            brief: 'Some brief.',
            expected_ready: true,
            expected_band: 'high',
            critique_themes: ['a theme'],
            rationale: 'A rationale.',
          },
        ],
      };
      fs.writeFileSync(fixturePath, yaml.dump(bad), 'utf8');
      assert.throws(() => loadBriefQualityCases(fixturePath));
    } finally {
      cleanup(tmp);
    }
  });
});
