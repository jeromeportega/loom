import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationGate, type CommandRunner } from '../orchestrator/IntegrationGate.js';

interface RunnerCall {
  command: string;
  cwd: string;
  timeoutMs: number;
}

/** A runner that records each call (command + cwd + timeoutMs) and returns a scripted result. */
function fakeRunner(
  script: { exitCode?: number | null; timedOut?: boolean; output?: string; durationMs?: number } = {}
): CommandRunner & { calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const run: CommandRunner = (command, cwd, timeoutMs) => {
    calls.push({ command, cwd, timeoutMs });
    return {
      exitCode: script.exitCode ?? 0,
      timedOut: script.timedOut ?? false,
      output: script.output ?? '',
      durationMs: script.durationMs ?? 1000,
    };
  };
  return Object.assign(run, { calls });
}

const noFiles = { fileExists: () => false, fileReader: () => null };
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

describe('IntegrationGate', () => {
  it('passes when the test command exits 0 and nothing was dropped', async () => {
    const runner = fakeRunner({ exitCode: 0 });
    const gate = new IntegrationGate({ testCommand: 'npm test', runner });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });
    assert.equal(out.ok, true);
    assert.equal(out.ran, true);
    assert.equal(out.command, 'npm test');
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].command, 'npm test');
    // The gate must run in the integrated tree and forward the default timeout.
    assert.equal(runner.calls[0].cwd, '/repo');
    assert.equal(runner.calls[0].timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.match(out.summary, /passed/);
  });

  it('forwards the configured cwd and timeout to the runner', async () => {
    const runner = fakeRunner({ exitCode: 0 });
    const gate = new IntegrationGate({ testCommand: 'npm test', timeoutMs: 42_000, runner });
    await gate.run({ projectRoot: '/work/tree', conflicted: [] });
    assert.equal(runner.calls[0].cwd, '/work/tree');
    assert.equal(runner.calls[0].timeoutMs, 42_000);
  });

  it('fails when the test command exits non-zero', async () => {
    const gate = new IntegrationGate({
      testCommand: 'npm test',
      runner: fakeRunner({ exitCode: 1, output: 'AssertionError: boom' }),
    });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 1);
    assert.match(out.summary, /failed \(exit 1\)/);
  });

  it('fails when the command times out', async () => {
    const gate = new IntegrationGate({
      testCommand: 'npm test',
      runner: fakeRunner({ exitCode: null, timedOut: true, durationMs: 900000 }),
    });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });
    assert.equal(out.ok, false);
    assert.equal(out.timedOut, true);
    assert.match(out.summary, /timed out/);
  });

  it('fails on amputation (a dropped story) even when tests pass', async () => {
    const gate = new IntegrationGate({
      testCommand: 'npm test',
      runner: fakeRunner({ exitCode: 0 }),
    });
    const out = await gate.run({ projectRoot: '/repo', conflicted: ['story-001-003'] });
    assert.equal(out.ok, false);
    assert.deepEqual(out.amputated, ['story-001-003']);
    assert.match(out.summary, /story-001-003/);
  });

  it('with no resolvable command, runs the amputation check only', async () => {
    const runner = fakeRunner();
    const gate = new IntegrationGate({ runner, ...noFiles });
    const clean = await gate.run({ projectRoot: '/repo', conflicted: [] });
    assert.equal(clean.ran, false);
    assert.equal(clean.ok, true);
    assert.equal(runner.calls.length, 0, 'no command should run');

    const amputated = await gate.run({ projectRoot: '/repo', conflicted: ['story-001-002'] });
    assert.equal(amputated.ran, false);
    assert.equal(amputated.ok, false);
  });

  it('auto-detects `npm test` from a real package.json test script', async () => {
    const runner = fakeRunner({ exitCode: 0 });
    const gate = new IntegrationGate({
      runner,
      fileExists: (p) => p.endsWith('package.json'),
      // Path-aware: only package.json has content; tsconfig.json etc. are absent
      // (a path-agnostic stub would falsely trigger the tsc toolchain step).
      fileReader: (p) => (p.endsWith('package.json') ? JSON.stringify({ scripts: { test: 'node --test' } }) : null),
    });
    const out = await gate.run({ projectRoot: '/repo' });
    assert.equal(out.command, 'npm test');
    assert.equal(runner.calls[0].command, 'npm test');
  });

  it('ignores the npm placeholder test script', async () => {
    const runner = fakeRunner();
    const gate = new IntegrationGate({
      runner,
      fileExists: (p) => p.endsWith('package.json'),
      fileReader: () => JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    });
    const out = await gate.run({ projectRoot: '/repo' });
    assert.equal(out.ran, false, 'placeholder script must not be treated as a real suite');
    assert.equal(runner.calls.length, 0);
  });

  it('detects `make test` when a Makefile has a test target', async () => {
    const runner = fakeRunner({ exitCode: 0 });
    const gate = new IntegrationGate({
      runner,
      fileExists: (p) => p.endsWith('Makefile'),
      // Path-aware: only the Makefile has content (see npm-test case above).
      fileReader: (p) => (p.endsWith('Makefile') ? 'build:\n\tgo build ./...\ntest:\n\tgo test ./...\n' : null),
    });
    const out = await gate.run({ projectRoot: '/repo' });
    assert.equal(out.command, 'make test');
  });

  it('prefers an explicit test_command over auto-detection', async () => {
    const runner = fakeRunner({ exitCode: 0 });
    const gate = new IntegrationGate({
      testCommand: 'npm ci && npm test',
      runner,
      fileExists: (p) => p.endsWith('package.json'),
      fileReader: () => JSON.stringify({ scripts: { test: 'node --test' } }),
    });
    const out = await gate.run({ projectRoot: '/repo' });
    assert.equal(out.command, 'npm ci && npm test');
    assert.equal(runner.calls[0].command, 'npm ci && npm test');
  });
});

// Exercises the real (non-injected) defaultRunner: a non-blocking spawn so the
// finalizer doesn't freeze the event loop. POSIX-shell commands only.
describe('IntegrationGate defaultRunner (real subprocess)', () => {
  it('runs a passing command and captures its output', async () => {
    const gate = new IntegrationGate({ testCommand: 'echo gate-marker' });
    const out = await gate.run({ projectRoot: process.cwd(), conflicted: [] });
    assert.equal(out.ok, true);
    assert.equal(out.exitCode, 0);
    assert.match(out.output, /gate-marker/);
  });

  it('reports the non-zero exit code of a failing command', async () => {
    const gate = new IntegrationGate({ testCommand: 'exit 3' });
    const out = await gate.run({ projectRoot: process.cwd(), conflicted: [] });
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 3);
  });

  it('kills and flags a command that exceeds its timeout', async () => {
    const gate = new IntegrationGate({ testCommand: 'sleep 30', timeoutMs: 200 });
    const out = await gate.run({ projectRoot: process.cwd(), conflicted: [] });
    assert.equal(out.ok, false);
    assert.equal(out.timedOut, true);
  });
});
