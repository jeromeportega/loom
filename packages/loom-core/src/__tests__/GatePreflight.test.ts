import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveGateCommand,
  preflightGateCommand,
  type GatePreflightResult,
} from '../orchestrator/GatePreflight.js';
import { IntegrationGate, type CommandRunner } from '../orchestrator/IntegrationGate.js';

/** Injectable probes backed by a basename → content map; no disk involved. */
function fakeFs(files: Record<string, string>): {
  fileExists: (p: string) => boolean;
  fileReader: (p: string) => string | null;
} {
  const byName = (p: string): string | undefined => files[path.basename(p)];
  return {
    fileExists: (p) => byName(p) !== undefined,
    fileReader: (p) => byName(p) ?? null,
  };
}

const noFiles = { fileExists: () => false, fileReader: () => null };

const REAL_PKG = JSON.stringify({ scripts: { test: 'node --test' } });
const PLACEHOLDER_PKG = JSON.stringify({
  scripts: { test: 'echo "Error: no test specified" && exit 1' },
});
const MAKEFILE_WITH_TEST = 'build:\n\tgo build ./...\ntest:\n\tgo test ./...\n';
const MAKEFILE_NO_TEST = 'build:\n\tgo build ./...\nlint:\n\tgolint ./...\n';

function assertNonViable(out: GatePreflightResult): void {
  assert.equal(out.viable, false);
  assert.ok(out.reasons.length > 0, 'non-viable must carry at least one reason');
  assert.ok(
    typeof out.recommendation === 'string' && out.recommendation.length > 0,
    'recommendation must always be populated when !viable'
  );
}

describe('resolveGateCommand', () => {
  it('configured testCommand wins with source configured', () => {
    const out = resolveGateCommand('/repo', {
      testCommand: 'npm ci && npm test',
      ...fakeFs({ 'package.json': REAL_PKG }),
    });
    assert.equal(out.command, 'npm ci && npm test');
    assert.equal(out.cwd, '/repo');
    assert.equal(out.source, 'configured');
  });

  it('trims a configured command and ignores a whitespace-only one', () => {
    const trimmed = resolveGateCommand('/repo', { testCommand: '  npm test  ', ...noFiles });
    assert.equal(trimmed.command, 'npm test');
    assert.equal(trimmed.source, 'configured');

    const blank = resolveGateCommand('/repo', { testCommand: '   ', ...noFiles });
    assert.equal(blank.source, 'none');
  });

  it('auto-detects npm test from a real package.json test script', () => {
    const out = resolveGateCommand('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(out.command, 'npm test');
    assert.equal(out.cwd, '/repo');
    assert.equal(out.source, 'auto-detected');
  });

  it('ignores the npm placeholder test script', () => {
    const out = resolveGateCommand('/repo', fakeFs({ 'package.json': PLACEHOLDER_PKG }));
    assert.equal(out.command, undefined);
    assert.equal(out.source, 'none');
  });

  it('auto-detects make test from a Makefile with a test target', () => {
    const out = resolveGateCommand('/repo', fakeFs({ Makefile: MAKEFILE_WITH_TEST }));
    assert.equal(out.command, 'make test');
    assert.equal(out.source, 'auto-detected');
  });

  it('auto-detects pytest from pytest.ini and from pyproject.toml mentioning pytest', () => {
    const ini = resolveGateCommand('/repo', fakeFs({ 'pytest.ini': '[pytest]\n' }));
    assert.equal(ini.command, 'pytest');
    assert.equal(ini.source, 'auto-detected');

    const pyproject = resolveGateCommand(
      '/repo',
      fakeFs({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })
    );
    assert.equal(pyproject.command, 'pytest');
  });

  it('yields source none and command undefined when nothing is resolvable', () => {
    const out = resolveGateCommand('/repo', noFiles);
    assert.equal(out.command, undefined);
    assert.equal(out.cwd, '/repo');
    assert.equal(out.source, 'none');
  });

  it('IntegrationGate.run() resolves via GatePreflight (identical by construction)', async () => {
    const probes = fakeFs({ 'package.json': REAL_PKG });
    const resolved = resolveGateCommand('/repo', probes);

    const calls: { command: string; cwd: string }[] = [];
    const runner: CommandRunner = (command, opts) => {
      calls.push({ command, cwd: opts.cwd });
      return { exitCode: 0, timedOut: false, output: '', durationMs: 1 };
    };
    const gate = new IntegrationGate({ runner, ...probes });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });

    assert.equal(out.command, resolved.command);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, resolved.command);
    assert.equal(calls[0].cwd, resolved.cwd);
  });
});

describe('preflightGateCommand', () => {
  it('npm test with a package-lock.json at cwd is viable with empty reasons', () => {
    const out = preflightGateCommand(
      '/repo',
      fakeFs({ 'package.json': REAL_PKG, 'package-lock.json': '{}' })
    );
    assert.equal(out.resolved.command, 'npm test');
    assert.equal(out.viable, true);
    assert.deepEqual(out.reasons, []);
  });

  it('npm test with an npm-shrinkwrap.json is also viable', () => {
    const out = preflightGateCommand(
      '/repo',
      fakeFs({ 'package.json': REAL_PKG, 'npm-shrinkwrap.json': '{}' })
    );
    assert.equal(out.viable, true);
  });

  it('npm test without a lockfile is non-viable with recommendation exactly "npm ci && npm test"', () => {
    const out = preflightGateCommand('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(out.resolved.command, 'npm test');
    assertNonViable(out);
    assert.equal(out.recommendation, 'npm ci && npm test');
    assert.ok(
      out.reasons.some((r) => r.includes('test_command: "npm ci && npm test"')),
      'failure message must state exactly which test_command to set'
    );
  });

  it('make test with a Makefile test target is viable', () => {
    const out = preflightGateCommand('/repo', fakeFs({ Makefile: MAKEFILE_WITH_TEST }));
    assert.equal(out.resolved.command, 'make test');
    assert.equal(out.viable, true);
    assert.deepEqual(out.reasons, []);
  });

  it('configured make test against a Makefile missing the target is non-viable', () => {
    const out = preflightGateCommand('/repo', {
      testCommand: 'make test',
      ...fakeFs({ Makefile: MAKEFILE_NO_TEST }),
    });
    assert.equal(out.resolved.source, 'configured');
    assertNonViable(out);
    assert.ok(
      out.reasons.some((r) => r.includes('test_command:')),
      'failure message must name the test_command key to set'
    );
  });

  it('configured make test with no Makefile at all is non-viable', () => {
    const out = preflightGateCommand('/repo', { testCommand: 'make test', ...noFiles });
    assertNonViable(out);
    assert.match(out.reasons[0], /No readable Makefile/);
  });

  it('pytest with a pytest config is viable', () => {
    const out = preflightGateCommand('/repo', fakeFs({ 'pytest.ini': '[pytest]\n' }));
    assert.equal(out.resolved.command, 'pytest');
    assert.equal(out.viable, true);
  });

  it('configured pytest without any pytest config is non-viable', () => {
    const out = preflightGateCommand('/repo', { testCommand: 'pytest', ...noFiles });
    assertNonViable(out);
    assert.ok(out.reasons.some((r) => r.includes('test_command:')));
  });

  it('source none is reported viable/informational with a suggestion to set test_command', () => {
    const out = preflightGateCommand('/repo', noFiles);
    assert.equal(out.resolved.source, 'none');
    assert.equal(out.viable, true);
    assert.deepEqual(out.reasons, []);
    assert.ok(out.recommendation?.includes('test_command'));
  });

  it('a configured command outside the detectable forms is viable (annotate only)', () => {
    const out = preflightGateCommand('/repo', {
      testCommand: 'npm ci && npm test',
      ...noFiles,
    });
    assert.equal(out.resolved.source, 'configured');
    assert.equal(out.viable, true);
    assert.deepEqual(out.reasons, []);
  });

  it('a configured command beginning with a detectable form still gets its check', () => {
    const out = preflightGateCommand('/repo', { testCommand: 'npm test', ...noFiles });
    assert.equal(out.resolved.source, 'configured');
    assertNonViable(out);
    assert.equal(out.recommendation, 'npm ci && npm test');
  });

  it('populates recommendation in every non-viable case (invariant)', () => {
    const nonViable: GatePreflightResult[] = [
      preflightGateCommand('/repo', fakeFs({ 'package.json': REAL_PKG })),
      preflightGateCommand('/repo', { testCommand: 'npm test', ...noFiles }),
      preflightGateCommand('/repo', { testCommand: 'make test', ...noFiles }),
      preflightGateCommand('/repo', {
        testCommand: 'make test',
        ...fakeFs({ Makefile: MAKEFILE_NO_TEST }),
      }),
      preflightGateCommand('/repo', { testCommand: 'pytest', ...noFiles }),
    ];
    for (const out of nonViable) assertNonViable(out);
  });

  it('never throws when a probed file exists but is unreadable (reader returns null)', () => {
    const unreadable = {
      fileExists: () => true,
      fileReader: () => null,
    };
    assert.doesNotThrow(() => {
      preflightGateCommand('/repo', { testCommand: 'make test', ...unreadable });
      preflightGateCommand('/repo', { testCommand: 'npm test', ...unreadable });
      preflightGateCommand('/repo', { testCommand: 'pytest', ...unreadable });
      preflightGateCommand('/repo', unreadable);
    });
    const out = preflightGateCommand('/repo', { testCommand: 'make test', ...unreadable });
    assertNonViable(out);
  });
});
