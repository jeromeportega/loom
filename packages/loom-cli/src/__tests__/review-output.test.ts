import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFindingsBlock, findingToJson } from '../commands/review.js';
import type { FindingJsonEntry } from '../commands/review.js';
import type { StoredFinding } from '@loom-ai/core';

function makeFixture(overrides: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: 1,
    agent_id: 'agent-001',
    story_id: 'story-001-001',
    severity: 'blocking',
    file: 'src/foo.ts',
    line: 10,
    message: 'Something is wrong',
    suggestion: null,
    recorded_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const MIXED_FINDINGS: StoredFinding[] = [
  makeFixture({ id: 1, severity: 'blocking', file: 'src/a.ts', line: 5,  message: 'blocking msg',  suggestion: 'fix it' }),
  makeFixture({ id: 2, severity: 'medium',   file: 'src/b.ts', line: 20, message: 'medium msg',   suggestion: null }),
  makeFixture({ id: 3, severity: 'low',      file: 'src/c.ts', line: null, message: 'low msg',    suggestion: 'consider it' }),
  makeFixture({ id: 4, severity: 'info',     file: 'src/d.ts', line: 1,  message: 'info msg',     suggestion: null }),
];

// ─── Text renderer ────────────────────────────────────────────────────────────

describe('renderFindingsBlock — grouping order', () => {
  it('renders sections in blocking → medium → low → info order', () => {
    const out = renderFindingsBlock(MIXED_FINDINGS);
    const blockingIdx = out.indexOf('[blocking]');
    const mediumIdx   = out.indexOf('[medium]');
    const lowIdx      = out.indexOf('[low]');
    const infoIdx     = out.indexOf('[info]');

    assert.ok(blockingIdx !== -1, 'must contain [blocking]');
    assert.ok(mediumIdx   !== -1, 'must contain [medium]');
    assert.ok(lowIdx      !== -1, 'must contain [low]');
    assert.ok(infoIdx     !== -1, 'must contain [info]');

    assert.ok(blockingIdx < mediumIdx, '[blocking] must come before [medium]');
    assert.ok(mediumIdx   < lowIdx,   '[medium] must come before [low]');
    assert.ok(lowIdx      < infoIdx,  '[low] must come before [info]');
  });

  it('omits severity groups that have no findings', () => {
    const findings = [makeFixture({ severity: 'blocking' })];
    const out = renderFindingsBlock(findings);
    assert.ok(out.includes('[blocking]'), 'must contain the present severity');
    assert.ok(!out.includes('[medium]'), 'must not contain absent severity [medium]');
    assert.ok(!out.includes('[low]'),    'must not contain absent severity [low]');
    assert.ok(!out.includes('[info]'),   'must not contain absent severity [info]');
  });
});

describe('renderFindingsBlock — entry format', () => {
  it('shows file:line — message when line is non-null', () => {
    const f = makeFixture({ file: 'src/foo.ts', line: 42, message: 'bad thing', suggestion: null });
    const out = renderFindingsBlock([f]);
    assert.ok(out.includes('src/foo.ts:42 — bad thing'), `expected file:line format; got:\n${out}`);
  });

  it('omits :line segment entirely when line is null', () => {
    const f = makeFixture({ file: 'src/bar.ts', line: null, message: 'no line', suggestion: null });
    const out = renderFindingsBlock([f]);
    assert.ok(out.includes('src/bar.ts — no line'), `expected file-only format; got:\n${out}`);
    assert.ok(!out.match(/src\/bar\.ts:\d/), 'must not include colon+number when line is null');
  });

  it('renders suggestion line when suggestion is non-null', () => {
    const f = makeFixture({ suggestion: 'use the other API' });
    const out = renderFindingsBlock([f]);
    assert.ok(out.includes('suggestion: use the other API'), `suggestion line missing; got:\n${out}`);
  });

  it('omits suggestion line entirely when suggestion is null', () => {
    const f = makeFixture({ suggestion: null });
    const out = renderFindingsBlock([f]);
    assert.ok(!out.includes('suggestion:'), `must not emit suggestion line when null; got:\n${out}`);
  });

  it('indents suggestion 2 extra spaces relative to entry line', () => {
    const f = makeFixture({ file: 'src/x.ts', line: 1, message: 'msg', suggestion: 'fix' });
    const out = renderFindingsBlock([f]);
    const lines = out.split('\n');
    const entryLine = lines.find((l) => l.includes('src/x.ts:1 — msg'));
    const suggLine  = lines.find((l) => l.includes('suggestion: fix'));
    assert.ok(entryLine, 'entry line not found');
    assert.ok(suggLine,  'suggestion line not found');
    const entryIndent = entryLine!.length - entryLine!.trimStart().length;
    const suggIndent  = suggLine!.length  - suggLine!.trimStart().length;
    assert.equal(suggIndent - entryIndent, 2, 'suggestion must be indented 2 extra spaces');
  });
});

describe('renderFindingsBlock — empty findings', () => {
  it('returns empty string when findings array is empty', () => {
    const out = renderFindingsBlock([]);
    assert.equal(out, '', 'empty findings must produce empty string so FINDINGS block is omitted');
  });
});

describe('renderFindingsBlock — unrecognised severity', () => {
  it('silently omits a finding whose severity is not in SEVERITY_ORDER', () => {
    // Guard against a future enum member ('high', etc.) being silently dropped.
    // The intended contract is silent omission (not an error); this test makes
    // that behaviour explicit so a reader can decide to add the new tier.
    const unknown = makeFixture({ severity: 'high' as StoredFinding['severity'] });
    const out = renderFindingsBlock([unknown]);
    // Block will be empty — the unrecognised group has no heading to render.
    assert.equal(out, '', 'unrecognised severity must be silently omitted (no output)');
  });
});

describe('renderFindingsBlock — FINDINGS header present when non-empty', () => {
  it('includes FINDINGS header and separator', () => {
    const out = renderFindingsBlock(MIXED_FINDINGS);
    assert.ok(out.includes('FINDINGS'), 'must include FINDINGS header');
    assert.ok(out.includes('────────'), 'must include separator line');
  });
});

// ─── JSON converter ───────────────────────────────────────────────────────────

describe('findingToJson — schema shape', () => {
  it('includes severity, file, line, message on every finding', () => {
    const f = makeFixture({ severity: 'medium', file: 'src/foo.ts', line: 7, message: 'oops', suggestion: null });
    const entry = findingToJson(f);
    assert.ok('severity' in entry, 'must have severity');
    assert.ok('file'     in entry, 'must have file');
    assert.ok('line'     in entry, 'must have line');
    assert.ok('message'  in entry, 'must have message');
    assert.equal(entry.severity, 'medium');
    assert.equal(entry.file,     'src/foo.ts');
    assert.equal(entry.line,     7);
    assert.equal(entry.message,  'oops');
  });

  it('includes suggestion key when suggestion is non-null', () => {
    const f = makeFixture({ suggestion: 'refactor this' });
    const entry = findingToJson(f);
    assert.ok('suggestion' in entry, 'must have suggestion key when non-null');
    assert.equal(entry.suggestion, 'refactor this');
  });

  it('omits suggestion key entirely when suggestion is null', () => {
    const f = makeFixture({ suggestion: null });
    const entry = findingToJson(f);
    assert.ok(!('suggestion' in entry), 'suggestion key must be absent when null, not set to null');
  });

  it('line is null (not omitted) when the finding has no line number', () => {
    const f = makeFixture({ line: null });
    const entry = findingToJson(f);
    assert.ok('line' in entry, 'line key must always be present');
    assert.equal(entry.line, null);
  });
});

describe('findingToJson — JSON schema shape (full array fixture)', () => {
  it('findings array elements each carry the required keys', () => {
    const jsonFindings: FindingJsonEntry[] = MIXED_FINDINGS.map(findingToJson);

    assert.equal(jsonFindings.length, MIXED_FINDINGS.length, 'one entry per finding');

    for (const entry of jsonFindings) {
      assert.ok('severity' in entry, 'missing severity');
      assert.ok('file'     in entry, 'missing file');
      assert.ok('line'     in entry, 'missing line');
      assert.ok('message'  in entry, 'missing message');
    }

    // Verify suggestion present only when finding had non-null suggestion
    const withSugg    = jsonFindings.filter((_e, i) => MIXED_FINDINGS[i].suggestion !== null);
    const withoutSugg = jsonFindings.filter((_e, i) => MIXED_FINDINGS[i].suggestion === null);

    for (const e of withSugg)    assert.ok('suggestion' in e, 'suggestion key must be present for non-null suggestion');
    for (const e of withoutSugg) assert.ok(!('suggestion' in e), 'suggestion key must be absent for null suggestion');
  });

  it('produced JSON object contains story_id, review_status, review_summary, and findings keys', () => {
    // Simulate what runReview --json emits
    const jsonOutput = {
      story_id:       'story-001-001',
      review_status:  'blocked',
      review_summary: '4 findings (1 blocking, 1 medium, 1 low, 1 info)',
      findings:       MIXED_FINDINGS.map(findingToJson),
    };

    const parsed = JSON.parse(JSON.stringify(jsonOutput)) as Record<string, unknown>;

    assert.ok('story_id'       in parsed, 'must have story_id');
    assert.ok('review_status'  in parsed, 'must have review_status');
    assert.ok('review_summary' in parsed, 'must have review_summary');
    assert.ok('findings'       in parsed, 'must have findings');

    assert.ok(Array.isArray(parsed.findings), 'findings must be an array');
    assert.equal((parsed.findings as unknown[]).length, MIXED_FINDINGS.length);
  });

  it('existing keys story_id, review_status, review_summary have correct types', () => {
    const jsonOutput = {
      story_id:       'story-001-001',
      review_status:  'passed',
      review_summary: '0 findings',
      findings:       [] as FindingJsonEntry[],
    };
    const parsed = JSON.parse(JSON.stringify(jsonOutput)) as Record<string, unknown>;

    assert.equal(typeof parsed.story_id,       'string', 'story_id must be string');
    assert.equal(typeof parsed.review_status,  'string', 'review_status must be string');
    assert.equal(typeof parsed.review_summary, 'string', 'review_summary must be string');
    assert.ok(Array.isArray(parsed.findings),            'findings must be array');
  });

  it('findings is an empty array when there are no findings', () => {
    const jsonOutput = {
      story_id:       'story-001-001',
      review_status:  'passed',
      review_summary: '0 findings',
      findings:       ([] as StoredFinding[]).map(findingToJson),
    };
    const parsed = JSON.parse(JSON.stringify(jsonOutput)) as Record<string, unknown>;

    assert.ok(Array.isArray(parsed.findings), 'findings must be an array');
    assert.equal((parsed.findings as unknown[]).length, 0, 'findings must be empty array when no findings');
  });
});
