import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNoProductionCallers } from '../orchestrator/GateNoProductionCaller.js';
import { runFinalizeGates } from '../orchestrator/FinalizeGates.js';

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

// ─── Regression: isTestFile must match root-level __tests__/ (no leading /) ──

describe('checkNoProductionCallers — isTestFile root-level __tests__ regression', () => {
  it('counts a caller at __tests__/foo.test.ts (no leading slash) as a test file', () => {
    // The caller file is at the root of the project, so path.relative returns
    // '__tests__/foo.test.ts' with no leading slash.
    write('__tests__/foo.test.ts', "import { rootTestFn } from '../src/rootTest';\n");

    const result = checkNoProductionCallers({
      epicDiff: diff('src/rootTest.ts', ['export function rootTestFn() { return 0; }']),
      projectRoot: tmpDir,
    });

    assert.equal(result.findings.length, 1, 'a root-level __tests__/ caller must still flag the symbol');
    assert.equal(result.findings[0].symbol, 'rootTestFn');
    assert.ok(
      result.findings[0].callers.some(c => c.startsWith('__tests__')),
      'caller path starting with __tests__/ must appear in callers list'
    );
  });
});

// ─── Regression: annotation bleed through removed lines ───────────────────────

describe('checkNoProductionCallers — annotation bleed through removed lines', () => {
  it('does not carry a @loom-public-api annotation forward past a removed declaration', () => {
    // Sequence: context annotation → removed old export → added new export.
    // The annotation must NOT suppress the new export's finding.
    write('__tests__/bleed.test.ts', "import { newFn } from '../src/bleed';\n");

    const epicDiff = [
      '--- a/src/bleed.ts',
      '+++ b/src/bleed.ts',
      '@@ -1,2 +1,2 @@',
      ' // @loom-public-api',
      '-export function oldFn() {}',
      '+export function newFn() {}',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });

    assert.equal(result.findings.length, 1, 'newFn must be flagged — annotation must not bleed past removed line');
    assert.equal(result.findings[0].symbol, 'newFn');
  });
});

// ─── Regression: composite key deduplication ──────────────────────────────────

describe('checkNoProductionCallers — composite key deduplication', () => {
  it('does not let an annotated same-named export from file B shadow an unannotated export from file A', () => {
    // fileB (annotated) appears FIRST in the diff; fileA (unannotated) appears second.
    // With old symbol-only dedup, fileB's entry would be kept (first seen), fileA's
    // dropped. Since fileB is annotated it is skipped, and fileA's test-only export
    // would never be flagged — a silent false negative.
    // With composite-key dedup, both entries are kept and scanned independently.
    write('__tests__/dedup.test.ts', "import { dupFoo } from '../src/fileA';\n");

    const epicDiff = [
      '--- /dev/null',
      '+++ b/src/fileB.ts',      // annotated export appears first in diff
      '@@ -0,0 +1,2 @@',
      '+// @loom-public-api',
      '+export function dupFoo() { return 2; }',
      '--- /dev/null',
      '+++ b/src/fileA.ts',      // unannotated export appears second
      '@@ -0,0 +1,1 @@',
      '+export function dupFoo() { return 1; }',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });

    // Both files must appear in scannedSymbols (one entry per file).
    assert.equal(
      result.scannedSymbols.filter(s => s === 'dupFoo').length,
      2,
      'same-named exports from different files must each appear in scannedSymbols'
    );
    // fileA.dupFoo is unannotated with a test-only caller → must be flagged.
    const flagged = result.findings.filter(f => f.symbol === 'dupFoo');
    assert.equal(flagged.length, 1, 'fileA.dupFoo (unannotated, test-only) must be flagged');
    assert.equal(flagged[0].file, 'src/fileA.ts');
  });
});

// ─── export default is skipped (can't grep by declared name) ─────────────────

describe('checkNoProductionCallers — export default is not tracked', () => {
  it('does not capture export default function declarations (caller name is unpredictable)', () => {
    // A caller can do `import renamed from './file'` — grepping for the
    // declared function name would miss all such callers and produce false positives.
    const epicDiff = diff('src/defaultExport.ts', [
      'export default function myDefaultFn() { return 42; }',
    ]);

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.deepEqual(result.scannedSymbols, [], 'export default function must not be tracked');
    assert.deepEqual(result.findings, []);
  });

  it('does not capture export default class declarations', () => {
    const epicDiff = diff('src/defaultClass.ts', [
      'export default class MyDefaultClass {}',
    ]);

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.deepEqual(result.scannedSymbols, []);
    assert.deepEqual(result.findings, []);
  });

  it('still captures non-default exports in the same diff as a default export', () => {
    // Ensure that skipping the default does not drop the named export on the next line.
    write('__tests__/mixed.test.ts', "import { namedFn } from '../src/mixed';\n");
    const epicDiff = [
      '--- /dev/null',
      '+++ b/src/mixed.ts',
      '@@ -0,0 +1,2 @@',
      '+export default function defaultOnly() {}',
      '+export function namedFn() { return 1; }',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff, projectRoot: tmpDir });
    assert.ok(result.scannedSymbols.includes('namedFn'), 'namedFn must still be scanned');
    assert.ok(!result.scannedSymbols.includes('defaultOnly'), 'defaultOnly must not be scanned');
  });
});

// ─── Malformed diff: no +++ b/ header (currentFile stays empty) ───────────────

describe('checkNoProductionCallers — malformed diff with no file header', () => {
  it('skips exports whose file is empty string (no preceding +++ b/ header)', () => {
    // A diff without the +++ b/ header line — currentFile never set.
    const malformedDiff = [
      '@@ -0,0 +1,1 @@',
      '+export function noHeaderFn() { return 0; }',
    ].join('\n');

    const result = checkNoProductionCallers({ epicDiff: malformedDiff, projectRoot: tmpDir });
    // The export is skipped because its file is '' — no false findings emitted.
    assert.equal(result.findings.length, 0, 'no findings from a diff with no file header');
    assert.ok(
      result.findings.every(f => f.file !== ''),
      'no finding should have an empty file field'
    );
  });
});

// ─── runFinalizeGates wiring ──────────────────────────────────────────────────

describe('runFinalizeGates — noCallers wiring', () => {
  it('sets hardFail:true and populates noCallers.findings when export has test-only caller', async () => {
    // Set up a minimal project: .env.example to silence the env-var gate,
    // and a test file that imports the symbol but no production caller.
    write('.env.example', '');
    write('__tests__/wired.test.ts', "import { wiredFn } from '../src/wired';\n");

    const epicDiff = diff('src/wired.ts', ['export function wiredFn() { return 1; }']);

    const result = await runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD~1',
      epicId: 'epic-test',
      epicDiff,
      mode: 'block',
      deliveredEpicIds: [],
    });

    assert.ok(result.noCallers, 'noCallers field must be present');
    assert.equal(result.noCallers.findings.length, 1, 'one no-caller finding expected');
    assert.equal(result.noCallers.findings[0].symbol, 'wiredFn');
    assert.equal(result.hardFail, true, 'hardFail must be true in block mode with a no-caller finding');
  });

  it('does not set hardFail when the export has a production caller', async () => {
    write('.env.example', '');
    write('src/prodCaller.ts', "import { wiredProdFn } from './wired';\nwiredProdFn();\n");

    const epicDiff = diff('src/wired.ts', ['export function wiredProdFn() { return 2; }']);

    const result = await runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD~1',
      epicId: 'epic-test',
      epicDiff,
      mode: 'block',
      deliveredEpicIds: [],
    });

    assert.ok(result.noCallers, 'noCallers field must be present');
    assert.equal(result.noCallers.findings.length, 0, 'no findings when production caller exists');
    assert.equal(result.hardFail, false, 'hardFail must be false when no no-caller findings');
  });

  it('returns empty noCallers when mode is off', async () => {
    const result = await runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD~1',
      epicId: 'epic-test',
      epicDiff: diff('src/off.ts', ['export function offFn() {}']),
      mode: 'off',
      deliveredEpicIds: [],
    });

    assert.ok(result.noCallers, 'noCallers field must be present even in off mode');
    assert.deepEqual(result.noCallers.findings, [], 'no findings in off mode');
    assert.equal(result.hardFail, false);
  });

  it('does not hard-fail in warn mode even when no-caller findings exist', async () => {
    write('.env.example', '');
    write('__tests__/warnMode.test.ts', "import { warnFn } from '../src/warnMode';\n");

    const epicDiff = diff('src/warnMode.ts', ['export function warnFn() { return 3; }']);

    const result = await runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD~1',
      epicId: 'epic-test',
      epicDiff,
      mode: 'warn',
      deliveredEpicIds: [],
    });

    assert.equal(result.noCallers.findings.length, 1, 'finding exists in warn mode');
    assert.equal(result.hardFail, false, 'hardFail must be false in warn mode regardless of findings');
  });
});
