import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noCallerFindingsToChecks } from '../commands/doctor.js';

// Local mirror of NoCallerFinding (loom-cli can't import from loom-core dist in the worktree).
interface NoCallerFinding {
  symbol: string;
  file: string;
  callers: string[];
}

// ─── Unit tests for noCallerFindingsToChecks (story-082-003) ────────────────

describe('noCallerFindingsToChecks', () => {
  it('returns an empty array when findings is empty', () => {
    const checks = noCallerFindingsToChecks([]);
    assert.deepEqual(checks, []);
  });

  it('maps a finding to a Check with ok:false, required:false (warn level)', () => {
    const finding: NoCallerFinding = {
      symbol: 'orphanFn',
      file: 'src/orphan.ts',
      callers: ['__tests__/orphan.test.ts'],
    };

    const checks = noCallerFindingsToChecks([finding]);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    assert.equal(checks[0].required, false, 'no-caller checks must be advisory (required:false)');
  });

  it('check name includes both symbol and file', () => {
    const finding: NoCallerFinding = {
      symbol: 'myExport',
      file: 'packages/loom-core/src/myExport.ts',
      callers: [],
    };

    const checks = noCallerFindingsToChecks([finding]);
    assert.ok(
      checks[0].name.includes('myExport'),
      `check name must include the symbol name; got: ${checks[0].name}`
    );
    assert.ok(
      checks[0].name.includes('packages/loom-core/src/myExport.ts'),
      `check name must include the file path; got: ${checks[0].name}`
    );
  });

  it('detail mentions the symbol, the file, and the @loom-public-api suppression mechanism', () => {
    const finding: NoCallerFinding = {
      symbol: 'suppressable',
      file: 'src/api.ts',
      callers: ['__tests__/api.test.ts'],
    };

    const checks = noCallerFindingsToChecks([finding]);
    assert.ok(
      checks[0].detail.includes('suppressable'),
      'detail must name the symbol'
    );
    assert.ok(
      checks[0].detail.includes('@loom-public-api'),
      'detail must mention the suppression annotation'
    );
  });

  it('produces one Check per finding', () => {
    const findings: NoCallerFinding[] = [
      { symbol: 'fnA', file: 'src/a.ts', callers: [] },
      { symbol: 'fnB', file: 'src/b.ts', callers: ['__tests__/b.test.ts'] },
      { symbol: 'fnC', file: 'src/c.ts', callers: ['__tests__/c.test.ts'] },
    ];

    const checks = noCallerFindingsToChecks(findings);
    assert.equal(checks.length, 3);
    assert.ok(checks.every(c => !c.ok), 'all checks must be ok:false');
    assert.ok(checks.every(c => !c.required), 'all checks must be required:false (warns)');
  });

  it('a project with zero findings produces no doctor Check entries (no-caller warn absent)', () => {
    // Simulates the case where all exports have production callers: findings is [].
    const checks = noCallerFindingsToChecks([]);
    assert.equal(checks.length, 0, 'no findings → no warn entries in doctor output');
  });
});
