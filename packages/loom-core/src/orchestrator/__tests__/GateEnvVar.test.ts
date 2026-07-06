import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkUndocumentedEnvVars } from '../GateEnvVar.js';
import { runFinalizeGates, readEnvExampleVars } from '../FinalizeGates.js';

// ── checkUndocumentedEnvVars unit tests ──────────────────────────────────────

describe('checkUndocumentedEnvVars', () => {
  it('returns finding for new undocumented var', () => {
    const diff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,0 +1,1 @@',
      '+const secret = process.env.NEW_SECRET;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({
      epicDiff: diff,
      envExampleVars: new Set(['DOCUMENTED']),
    });

    assert.equal(findings.length, 1, 'one finding for undocumented var');
    assert.equal(findings[0].varName, 'NEW_SECRET');
    assert.equal(findings[0].filePath, 'src/config.ts');
    assert.ok(findings[0].lineSnippet.includes('NEW_SECRET'), 'lineSnippet must contain the var');
  });

  it('returns no finding when var is documented in .env.example', () => {
    const diff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '+const url = process.env.DOCUMENTED;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({
      epicDiff: diff,
      envExampleVars: new Set(['DOCUMENTED']),
    });

    assert.deepEqual(findings, [], 'documented var must produce no finding');
  });

  it('returns exactly two findings for two undocumented + one documented in same diff', () => {
    const diff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '+const a = process.env.UNDOC_ONE;',
      '+const b = process.env.DOCUMENTED;',
      '+const c = process.env.UNDOC_TWO;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({
      epicDiff: diff,
      envExampleVars: new Set(['DOCUMENTED']),
    });

    assert.equal(findings.length, 2, 'exactly two findings for two undocumented vars');
    const varNames = findings.map(f => f.varName);
    assert.ok(varNames.includes('UNDOC_ONE'), 'UNDOC_ONE must be found');
    assert.ok(varNames.includes('UNDOC_TWO'), 'UNDOC_TWO must be found');
    assert.ok(!varNames.includes('DOCUMENTED'), 'DOCUMENTED must not produce a finding');
  });

  it('returns [] when envExampleVars is null (missing .env.example)', () => {
    const diff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '+const x = process.env.NEW_SECRET;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({
      epicDiff: diff,
      envExampleVars: null,
    });

    assert.deepEqual(findings, [], 'null envExampleVars must yield no findings');
  });

  it('returns [] for empty diff', () => {
    const findings = checkUndocumentedEnvVars({
      epicDiff: '',
      envExampleVars: new Set(['SOME_VAR']),
    });

    assert.deepEqual(findings, []);
  });

  it('matches UPPER_SNAKE_CASE but not lowercase', () => {
    const diff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '+const a = process.env.UPPER_SNAKE;',
      '+const b = process.env.lowercase;',
      '+const c = process.env.MixedCase;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({
      epicDiff: diff,
      envExampleVars: new Set(),
    });

    const varNames = findings.map(f => f.varName);
    assert.ok(varNames.includes('UPPER_SNAKE'), 'UPPER_SNAKE must match');
    assert.ok(!varNames.includes('lowercase'), 'lowercase must not match [A-Z][A-Z0-9_]*');
    // MixedCase: starts with M (uppercase), then 'ixedCase' — only M matches [A-Z] but
    // the full pattern [A-Z][A-Z0-9_]* stops at the first non-matching char.
    // 'M' alone is only 1 char — but since there's no separator, 'MixedCase' won't match
    // because 'i' is not in [A-Z0-9_]. The regex captures 'M' only (1 char).
    // Since findings deduplicate by varName+filePath, we check the captured names.
    assert.ok(!varNames.includes('MixedCase'), 'MixedCase must not be captured as a whole identifier');
  });

  it('does not produce a finding for lines starting with --- (removed file header)', () => {
    const diff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '-const old = process.env.OLD_SECRET;',
      '+const newVal = process.env.NEW_SECRET;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({
      epicDiff: diff,
      envExampleVars: new Set(),
    });

    const varNames = findings.map(f => f.varName);
    assert.ok(!varNames.includes('OLD_SECRET'), 'removed line must not produce a finding');
    assert.ok(varNames.includes('NEW_SECRET'), 'added line must produce a finding');
  });

  it('deduplicates same var appearing multiple times in same file', () => {
    const diff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '+const a = process.env.REPEATED;',
      '+const b = process.env.REPEATED;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({
      epicDiff: diff,
      envExampleVars: new Set(),
    });

    assert.equal(findings.length, 1, 'same undocumented var in same file must yield one finding');
  });

  it('reports separate findings for same var in different files', () => {
    const diff = [
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '+const a = process.env.MY_SECRET;',
      '--- a/src/worker.ts',
      '+++ b/src/worker.ts',
      '+const b = process.env.MY_SECRET;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({
      epicDiff: diff,
      envExampleVars: new Set(),
    });

    assert.equal(findings.length, 2, 'same undocumented var in two files must yield two findings');
    const filePaths = findings.map(f => f.filePath);
    assert.ok(filePaths.includes('src/api.ts'), 'api.ts must be in findings');
    assert.ok(filePaths.includes('src/worker.ts'), 'worker.ts must be in findings');
  });

  it('does not flag ambient system / CI variables (PATH, NODE_ENV, CI)', () => {
    const diff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '+const p = process.env.PATH;',
      '+const e = process.env.NODE_ENV;',
      '+const c = process.env.CI;',
      '+const s = process.env.APP_SECRET;',
    ].join('\n');

    const findings = checkUndocumentedEnvVars({ epicDiff: diff, envExampleVars: new Set() });
    const varNames = findings.map(f => f.varName);
    assert.ok(!varNames.includes('PATH'), 'PATH is ambient and must not be flagged');
    assert.ok(!varNames.includes('NODE_ENV'), 'NODE_ENV is ambient and must not be flagged');
    assert.ok(!varNames.includes('CI'), 'CI is ambient and must not be flagged');
    assert.ok(varNames.includes('APP_SECRET'), 'a genuine undocumented var is still flagged');
  });
});

// ── readEnvExampleVars unit tests ────────────────────────────────────────────

describe('readEnvExampleVars', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-envex-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when .env.example is absent', () => {
    const result = readEnvExampleVars(tmpDir);
    assert.equal(result, null, 'absent .env.example must return null');
  });

  it('parses variable names from .env.example', () => {
    fs.writeFileSync(path.join(tmpDir, '.env.example'), [
      '# comment',
      'DATABASE_URL=postgresql://localhost/dev',
      'SECRET_KEY=',
      '',
      '# another comment',
      'PORT=3000',
    ].join('\n'));

    const result = readEnvExampleVars(tmpDir);
    assert.ok(result !== null, '.env.example present must return a Set');
    assert.ok(result!.has('DATABASE_URL'), 'DATABASE_URL must be parsed');
    assert.ok(result!.has('SECRET_KEY'), 'SECRET_KEY must be parsed');
    assert.ok(result!.has('PORT'), 'PORT must be parsed');
    assert.equal(result!.size, 3, 'only three vars must be parsed');
  });
});

// ── Policy wiring via runFinalizeGates ────────────────────────────────────────

describe('runFinalizeGates — undocumented env-var policy wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fg-envvar-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeEnvExample(vars: string[]): void {
    fs.writeFileSync(
      path.join(tmpDir, '.env.example'),
      vars.map(v => `${v}=`).join('\n') + '\n'
    );
  }

  const epicDiffWithUndocVar = [
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    '+const x = process.env.UNDOC_VAR;',
  ].join('\n');

  it('mode=warn with undocumented var: finding present, hardFail=false', async () => {
    writeEnvExample([]);  // empty .env.example — UNDOC_VAR not listed

    const result = await runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD',
      epicId: 'epic-test',
      epicDiff: epicDiffWithUndocVar,
      mode: 'warn',
      deliveredEpicIds: [],
    });

    assert.ok(result.undocumentedEnvVars.length > 0, 'warn mode must return env-var findings');
    assert.equal(result.hardFail, false, 'warn mode must not set hardFail');
  });

  it('mode=block with undocumented var: hardFail=true', async () => {
    writeEnvExample([]);  // empty .env.example

    const result = await runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD',
      epicId: 'epic-test',
      epicDiff: epicDiffWithUndocVar,
      mode: 'block',
      deliveredEpicIds: [],
    });

    assert.ok(result.undocumentedEnvVars.length > 0, 'block mode must return findings');
    assert.equal(result.hardFail, true, 'block mode with findings must set hardFail=true');
  });

  it('mode=off: [] findings, hardFail=false', async () => {
    writeEnvExample([]);

    const result = await runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD',
      epicId: 'epic-test',
      epicDiff: epicDiffWithUndocVar,
      mode: 'off',
      deliveredEpicIds: [],
    });

    assert.deepEqual(result.undocumentedEnvVars, []);
    assert.equal(result.hardFail, false);
  });
});

// ── Integration smoke: no .env.example ───────────────────────────────────────

describe('runFinalizeGates — missing .env.example integration smoke', () => {
  let tmpDir: string;
  let warnMessages: string[];
  const originalWarn = console.warn;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fg-noenv-'));
    warnMessages = [];
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits notice and does not produce findings when .env.example is absent', async () => {
    // No .env.example written — gate should skip with a notice.
    const epicDiff = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '+const x = process.env.SOME_VAR;',
    ].join('\n');

    const result = await runFinalizeGates({
      contractRoot: tmpDir,
      treeRoot: tmpDir,
      headRef: 'HEAD',
      baseRef: 'HEAD',
      epicId: 'epic-test',
      epicDiff,
      mode: 'block',
      deliveredEpicIds: [],
    });

    assert.deepEqual(result.undocumentedEnvVars, [], 'absent .env.example must yield no findings');
    assert.equal(result.hardFail, false, 'absent .env.example must not set hardFail');
    const noticeEmitted = warnMessages.some(m => m.includes('.env.example'));
    assert.ok(noticeEmitted, 'a notice about missing .env.example must be emitted');
  });
});
