import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveGatePlan,
  resolveGateCommand,
  type GatePreflightOptions,
  type ResolvedGatePlan,
} from '../GatePreflight.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const REAL_PKG = JSON.stringify({ scripts: { test: 'node --test' } });
const PLACEHOLDER_PKG = JSON.stringify({
  scripts: { test: 'echo "Error: no test specified" && exit 1' },
});
const MAKEFILE_WITH_TEST = 'build:\n\tgo build ./...\ntest:\n\tgo test ./...\n';

/** Probe factory backed by a basename→content map; no disk involved. */
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

const noFiles: GatePreflightOptions = { fileExists: () => false, fileReader: () => null };

// ─── Override branch (FR-12 / NFR-3) ──────────────────────────────────────

describe('resolveGatePlan — override branch (FR-12/NFR-3)', () => {
  it('with testCommand set: source=configured, exactly one unit step', () => {
    const plan = resolveGatePlan('/repo', { testCommand: 'foo test', ...noFiles });
    assert.equal(plan.source, 'configured');
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].name, 'unit');
    assert.equal(plan.steps[0].kind, 'unit');
    assert.equal(plan.steps[0].command, 'foo test');
    assert.equal(plan.steps[0].cwd, '/repo');
    assert.equal(plan.cwd, '/repo');
  });

  it('testCommand is used byte-for-byte unchanged', () => {
    const cmd = 'npm ci && npm test -- --reporter=tap';
    const plan = resolveGatePlan('/repo', { testCommand: cmd, ...noFiles });
    assert.equal(plan.steps[0].command, cmd);
  });

  it('detection probes are NEVER called when testCommand is set', () => {
    let existsCalls = 0;
    let readerCalls = 0;
    const spyOpts: GatePreflightOptions = {
      testCommand: 'my-test-runner',
      fileExists: () => { existsCalls++; return true; },
      fileReader: () => { readerCalls++; return REAL_PKG; },
    };
    resolveGatePlan('/repo', spyOpts);
    assert.equal(existsCalls, 0, 'fileExists must never be called in override branch');
    assert.equal(readerCalls, 0, 'fileReader must never be called in override branch');
  });

  it('trims whitespace but preserves the rest of the command', () => {
    const plan = resolveGatePlan('/repo', { testCommand: '  pytest -x  ', ...noFiles });
    assert.equal(plan.steps[0].command, 'pytest -x');
  });

  it('whitespace-only testCommand falls through to auto-detection (source: none when no signals)', () => {
    const plan = resolveGatePlan('/repo', { testCommand: '   ', ...noFiles });
    assert.equal(plan.source, 'none');
    assert.equal(plan.steps.length, 0);
  });
});

// ─── Auto-detection composition ───────────────────────────────────────────

describe('resolveGatePlan — auto-detection', () => {
  it('npm package with real test script → source:auto-detected, steps[0].kind=unit', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(plan.source, 'auto-detected');
    assert.ok(plan.steps.length >= 1);
    assert.equal(plan.steps[0].kind, 'unit');
    assert.equal(plan.steps[0].name, 'unit');
    assert.equal(plan.steps[0].command, 'npm test');
  });

  it('npm placeholder test script → source:none, steps=[]', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'package.json': PLACEHOLDER_PKG }));
    assert.equal(plan.source, 'none');
    assert.deepEqual(plan.steps, []);
  });

  it('Makefile with test target → unit step command is make test', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ Makefile: MAKEFILE_WITH_TEST }));
    assert.equal(plan.source, 'auto-detected');
    assert.equal(plan.steps[0].command, 'make test');
  });

  it('pytest.ini → unit step command is pytest', () => {
    const plan = resolveGatePlan('/repo', fakeFs({ 'pytest.ini': '[pytest]\n' }));
    assert.equal(plan.source, 'auto-detected');
    assert.equal(plan.steps[0].command, 'pytest');
  });

  it('no signals → source:none, steps=[]', () => {
    const plan = resolveGatePlan('/repo', noFiles);
    assert.equal(plan.source, 'none');
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.cwd, '/repo');
  });
});

// ─── Determinism (NFR-1) ──────────────────────────────────────────────────

describe('resolveGatePlan — determinism (NFR-1)', () => {
  it('identical probe inputs produce an identical plan on repeated calls', () => {
    const opts: GatePreflightOptions = fakeFs({ 'package.json': REAL_PKG });
    const planA = resolveGatePlan('/repo', opts);
    const planB = resolveGatePlan('/repo', opts);
    assert.deepEqual(planA, planB);
  });

  it('configured override is also deterministic', () => {
    const opts: GatePreflightOptions = { testCommand: 'npm ci && npm test' };
    const a = resolveGatePlan('/repo', opts);
    const b = resolveGatePlan('/repo', opts);
    assert.deepEqual(a, b);
  });
});

// ─── Adapter compatibility ─────────────────────────────────────────────────

describe('resolveGateCommand adapter', () => {
  it('returns the unit step command and source — backward compat', () => {
    const out = resolveGateCommand('/repo', { testCommand: 'npm ci && npm test' });
    assert.equal(out.command, 'npm ci && npm test');
    assert.equal(out.source, 'configured');
    assert.equal(out.cwd, '/repo');
  });

  it('returns unit step only even when auto-detect would produce multiple steps', () => {
    // Currently only unit step exists (002 will add toolchain); this test
    // confirms the adapter returns just the unit step command.
    const out = resolveGateCommand('/repo', fakeFs({ 'package.json': REAL_PKG }));
    assert.equal(out.command, 'npm test');
    assert.equal(out.source, 'auto-detected');
  });

  it('returns undefined command when source is none', () => {
    const out = resolveGateCommand('/repo', noFiles);
    assert.equal(out.command, undefined);
    assert.equal(out.source, 'none');
  });
});

// ─── Amputation-only gate ─────────────────────────────────────────────────

describe('resolveGatePlan — amputation-only gate', () => {
  it('no runnable command → steps=[], source=none', () => {
    const plan = resolveGatePlan('/repo', noFiles);
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.source, 'none');
  });
});
