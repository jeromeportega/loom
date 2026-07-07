import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNoProductionCallers } from '../orchestrator/GateNoProductionCaller.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-nocaller-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a file inside tmpDir, creating directories as needed. */
function write(rel: string, content: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Build a synthetic unified-diff string for added lines in `file`. */
function diff(file: string, lines: string[]): string {
  return [
    `--- /dev/null`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(l => `+${l}`),
  ].join('\n');
}

// ─── FR-13 scenario (c): test-only caller → symbol flagged ───────────────────

describe('checkNoProductionCallers — scenario (c): test-only caller', () => {
  it('flags a symbol whose only caller is a test file', () => {
    write('__tests__/orphan.test.ts', "import { orphanFn } from '../src/orphan';\n");

    const result = checkNoProductionCallers({
      epicDiff: diff('src/orphan.ts', ['export function orphanFn() { return 42; }']),
      projectRoot: tmpDir,
    });

    assert.equal(result.findings.length, 1, 'one finding for a test-only export');
    assert.equal(result.findings[0].symbol, 'orphanFn');
    assert.ok(
      result.findings[0].callers.some(c => c.includes('test')),
      'callers list must name the test file'
    );
    assert.ok(
      result.findings[0].callers.every(c =>
        /[._]test\.[mc]?[jt]sx?$/.test(c) ||
        /[._]spec\.[mc]?[jt]sx?$/.test(c) ||
        c.includes('__tests__') ||
        c.includes('/test/')
      ),
      'all callers must be test files'
    );
  });
});

// ─── FR-13 scenario (d): production caller suppresses the finding ─────────────

describe('checkNoProductionCallers — scenario (d): production caller suppresses', () => {
  it('returns empty findings when at least one non-test caller exists', () => {
    write('src/production.ts', "import { orphanFn } from './orphan';\norphanFn();\n");
    write('__tests__/orphan.test.ts', "import { orphanFn } from '../src/orphan';\n");

    const result = checkNoProductionCallers({
      epicDiff: diff('src/orphan.ts', ['export function orphanFn() { return 42; }']),
      projectRoot: tmpDir,
    });

    assert.deepEqual(result.findings, [], 'a production caller must suppress the finding');
  });
});

// ─── FR-13 scenario (e): @loom-public-api annotation suppresses ───────────────

describe('checkNoProductionCallers — scenario (e): @loom-public-api annotation', () => {
  it('does not flag an annotated export even when all callers are test files', () => {
    write('__tests__/public.test.ts', "import { publicFn } from '../src/public';\n");

    const result = checkNoProductionCallers({
      epicDiff: diff('src/public.ts', [
        '// @loom-public-api',
        'export function publicFn() { return 42; }',
      ]),
      projectRoot: tmpDir,
    });

    assert.deepEqual(result.findings, [], '@loom-public-api must suppress the finding');
    assert.ok(
      result.scannedSymbols.includes('publicFn'),
      'annotated symbol must still appear in scannedSymbols'
    );
  });

  it('suppresses annotation on a context (unchanged) line before the export', () => {
    write('__tests__/pub.test.ts', "import { ctxAnnotated } from '../src/pub';\n");

    // Simulate the annotation already existing (context line) while only
    // the export itself is new (added line).
    const epicDiff = [
      '--- a/src/pub.ts',
      '+++ b/src/pub.ts',
      '@@ -1,1 +1,2 @@',
      ' // @loom-public-api',
      '+export function ctxAnnotated() {}',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.deepEqual(result.findings, []);
  });
});

// ─── Cross-package production caller (FR-4) ───────────────────────────────────

describe('checkNoProductionCallers — cross-package production caller', () => {
  it('counts a cross-package import as a production caller and suppresses the finding', () => {
    // The export lives in loom-core; the caller is in loom-web.
    write(
      'packages/loom-web/src/api.ts',
      "import { crossFn } from '../../loom-core/src/crossFn';\ncrossFn();\n"
    );

    const result = checkNoProductionCallers({
      epicDiff: diff('packages/loom-core/src/crossFn.ts', [
        'export function crossFn() { return true; }',
      ]),
      projectRoot: tmpDir,
    });

    assert.deepEqual(result.findings, [], 'a cross-package production caller must suppress the finding');
  });

  it('flags when the only cross-package caller is a test file', () => {
    // Same setup but the cross-package file is a test.
    write(
      'packages/loom-web/src/__tests__/api.test.ts',
      "import { crossOnlyTest } from '../../loom-core/src/crossFn';\n"
    );

    const result = checkNoProductionCallers({
      epicDiff: diff('packages/loom-core/src/crossFn.ts', [
        'export function crossOnlyTest() { return true; }',
      ]),
      projectRoot: tmpDir,
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].symbol, 'crossOnlyTest');
  });
});

// ─── Zero callers → still flagged ─────────────────────────────────────────────

describe('checkNoProductionCallers — zero callers', () => {
  it('flags a symbol with no callers anywhere', () => {
    // No files reference the symbol at all.
    const result = checkNoProductionCallers({
      epicDiff: diff('src/orphan.ts', ['export function nocallerFn() { return 0; }']),
      projectRoot: tmpDir,
    });

    assert.equal(result.findings.length, 1, 'zero callers must still produce a finding');
    assert.equal(result.findings[0].symbol, 'nocallerFn');
    assert.deepEqual(result.findings[0].callers, [], 'callers must be an empty array');
  });
});

// ─── Multiple exports — mixed profile ─────────────────────────────────────────

describe('checkNoProductionCallers — multiple exports in one diff', () => {
  it('flags only test-only-unannotated symbols when the diff has mixed exports', () => {
    // orphanFn  → only test caller  → should be flagged
    // prodFn    → has prod caller   → should NOT be flagged
    // publicFn  → annotated         → should NOT be flagged
    write('src/main.ts', "import { prodFn } from './target';\nprodFn();\n");
    write(
      '__tests__/target.test.ts',
      "import { orphanFn, prodFn, publicFn } from '../src/target';\n"
    );

    const epicDiff = [
      '--- /dev/null',
      '+++ b/src/target.ts',
      '@@ -0,0 +1,4 @@',
      '+export function orphanFn() { return 1; }',
      '+export function prodFn() { return 2; }',
      '+// @loom-public-api',
      '+export function publicFn() { return 3; }',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });

    const flagged = result.findings.map(f => f.symbol);
    assert.ok(flagged.includes('orphanFn'), 'orphanFn (test-only) must be flagged');
    assert.ok(!flagged.includes('prodFn'), 'prodFn (prod caller) must NOT be flagged');
    assert.ok(!flagged.includes('publicFn'), 'publicFn (annotated) must NOT be flagged');
  });

  it('scannedSymbols includes every exported symbol from the diff', () => {
    const epicDiff = [
      '--- /dev/null',
      '+++ b/src/multi.ts',
      '@@ -0,0 +1,5 @@',
      '+export function fnOne() {}',
      '+export const constTwo = 42;',
      '+// @loom-public-api',
      '+export class ClassThree {}',
      '+export interface IFour {}',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });

    assert.ok(result.scannedSymbols.includes('fnOne'), 'fnOne must be in scannedSymbols');
    assert.ok(result.scannedSymbols.includes('constTwo'), 'constTwo must be in scannedSymbols');
    assert.ok(result.scannedSymbols.includes('ClassThree'), 'ClassThree must be in scannedSymbols');
    assert.ok(result.scannedSymbols.includes('IFour'), 'IFour must be in scannedSymbols');
    assert.equal(result.scannedSymbols.length, 4, 'exactly four symbols must be scanned');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('checkNoProductionCallers — edge cases', () => {
  it('returns empty result for an empty diff', () => {
    const result = checkNoProductionCallers({ epicDiff: '', projectRoot: tmpDir });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.scannedSymbols, []);
  });

  it('returns empty result for a diff with only non-export added lines', () => {
    const epicDiff = diff('src/helper.ts', [
      'const x = 1;',
      'function internal() {}',
    ]);
    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.scannedSymbols, []);
  });

  it('handles export of various declaration kinds', () => {
    const epicDiff = [
      '--- /dev/null',
      '+++ b/src/kinds.ts',
      '@@ -0,0 +1,7 @@',
      '+export class MyClass {}',
      '+export interface MyInterface {}',
      '+export type MyType = string;',
      '+export enum MyEnum { A, B }',
      '+export const MY_CONST = 1;',
      '+export async function asyncFn() {}',
      '+export abstract class AbstractClass {}',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    const symbols = result.scannedSymbols;
    assert.ok(symbols.includes('MyClass'), 'class export captured');
    assert.ok(symbols.includes('MyInterface'), 'interface export captured');
    assert.ok(symbols.includes('MyType'), 'type export captured');
    assert.ok(symbols.includes('MyEnum'), 'enum export captured');
    assert.ok(symbols.includes('MY_CONST'), 'const export captured');
    assert.ok(symbols.includes('asyncFn'), 'async function export captured');
    assert.ok(symbols.includes('AbstractClass'), 'abstract class export captured');
  });

  it('does not flag a symbol from a removed line (- prefix)', () => {
    const epicDiff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,0 @@',
      '-export function removedFn() {}',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.deepEqual(result.scannedSymbols, []);
    assert.deepEqual(result.findings, []);
  });

  it('deduplicates symbols appearing in multiple hunks of the same diff', () => {
    const epicDiff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,0 +1,1 @@',
      '+export function dupFn() {}',
      '@@ -10,0 +11,1 @@',
      '+export function dupFn() {} // second occurrence',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.equal(
      result.scannedSymbols.filter(s => s === 'dupFn').length,
      1,
      'duplicate symbol must appear only once in scannedSymbols'
    );
  });

  it('durationMs is non-negative and reflects elapsed wall-clock time', () => {
    const result = checkNoProductionCallers({ epicDiff: '', projectRoot: tmpDir });
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs >= 0);
  });

  it('named-export form { foo, bar as baz } extracts the exported names', () => {
    const epicDiff = [
      '--- a/src/re-export.ts',
      '+++ b/src/re-export.ts',
      '@@ -0,0 +1,1 @@',
      '+export { fooImpl as fooFn, barImpl as barFn }',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.ok(result.scannedSymbols.includes('fooFn'), 'aliased export fooFn captured');
    assert.ok(result.scannedSymbols.includes('barFn'), 'aliased export barFn captured');
    assert.ok(!result.scannedSymbols.includes('fooImpl'), 'local name fooImpl must not appear');
  });

  it('annotation on the line immediately before a named-export also suppresses it', () => {
    const epicDiff = [
      '--- /dev/null',
      '+++ b/src/named.ts',
      '@@ -0,0 +1,2 @@',
      '+// @loom-public-api',
      '+export { internalImpl as annotatedFn }',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.ok(!result.findings.some(f => f.symbol === 'annotatedFn'));
  });
});

// ─── Performance: must complete in under 5 seconds ───────────────────────────

describe('checkNoProductionCallers — performance', () => {
  it('completes 10 symbols in under 5 seconds against a small project tree', () => {
    // Seed a minimal project tree so grep has real files to scan.
    for (let i = 0; i < 5; i++) {
      write(`src/module${i}.ts`, `export function helper${i}() {}\n`);
    }

    const lines = Array.from({ length: 10 }, (_, i) => `export function perf${i}Fn() {}`);
    const result = checkNoProductionCallers({
      epicDiff: diff('src/perf.ts', lines),
      projectRoot: tmpDir,
    });

    assert.ok(
      result.durationMs < 5000,
      `durationMs ${result.durationMs} must be under 5000ms`
    );
    assert.equal(result.scannedSymbols.length, 10);
  });
});
