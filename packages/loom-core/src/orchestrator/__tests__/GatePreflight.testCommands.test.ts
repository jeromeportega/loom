import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGatePlan,
  runTestCommandEntries,
  type GatePreflightOptions,
} from '../GatePreflight.js';
import { IntegrationGate } from '../IntegrationGate.js';
import type { CommandRunner } from '../IntegrationGate.js';
import type { TestCommandEntry } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

interface RunnerRecord {
  cmd: string;
  cwd: string;
  timeoutMs: number;
}

function makeRunner(
  scripts: Array<{ exitCode?: number | null; timedOut?: boolean; output?: string; durationMs?: number }>
): CommandRunner & { calls: RunnerRecord[] } {
  const calls: RunnerRecord[] = [];
  let idx = 0;
  const run: CommandRunner = (cmd, cwd, timeoutMs) => {
    calls.push({ cmd, cwd, timeoutMs });
    const s = scripts[idx++] ?? {};
    return {
      exitCode:   s.exitCode !== undefined ? s.exitCode : 0,
      timedOut:   s.timedOut ?? false,
      output:     s.output ?? '',
      durationMs: s.durationMs ?? 10,
    };
  };
  return Object.assign(run, { calls });
}

const noFiles: GatePreflightOptions = { fileExists: () => false, fileReader: () => null };

const TIMEOUT_MS = 30_000;
const ROOT = '/repo';

function entry(name: string, paths: string[], command = `run-${name}`): TestCommandEntry {
  return { name, paths, command };
}

// ─── resolveGatePlan dispatch order ───────────────────────────────────────

describe('resolveGatePlan — test_commands dispatch', () => {
  it('testCommand present → source:configured, testCommands silently ignored', () => {
    const plan = resolveGatePlan(ROOT, {
      testCommand:  'my-test-runner',
      testCommands: [entry('ts', ['**/*.ts'])],
      ...noFiles,
    });
    assert.equal(plan.source, 'configured');
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].command, 'my-test-runner');
  });

  it('testCommand absent, testCommands non-empty → source:test_commands, steps=[]', () => {
    const plan = resolveGatePlan(ROOT, {
      testCommands: [entry('ts', ['**/*.ts'])],
      ...noFiles,
    });
    assert.equal(plan.source, 'test_commands');
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.cwd, ROOT);
  });

  it('testCommands empty array → falls through to auto-detection (source:none when no signals)', () => {
    const plan = resolveGatePlan(ROOT, {
      testCommands: [],
      ...noFiles,
    });
    assert.equal(plan.source, 'none');
  });

  it('both absent → auto-detection path (source:none when no signals)', () => {
    const plan = resolveGatePlan(ROOT, noFiles);
    assert.equal(plan.source, 'none');
  });

  it('whitespace-only testCommand + testCommands → test_commands fires', () => {
    const plan = resolveGatePlan(ROOT, {
      testCommand:  '   ',
      testCommands: [entry('go', ['**/*.go'])],
      ...noFiles,
    });
    assert.equal(plan.source, 'test_commands');
  });
});

// ─── runTestCommandEntries — glob matching ─────────────────────────────────

describe('runTestCommandEntries — glob matching', () => {
  it('entry whose paths glob matches one changed file → status passed (exit 0)', async () => {
    const runner = makeRunner([{ exitCode: 0, durationMs: 5 }]);
    const { results } = await runTestCommandEntries({
      entries:      [entry('unit', ['src/**/*.ts'])],
      changedPaths: ['src/foo.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'unit');
    assert.equal(results[0].status, 'passed');
    assert.equal(results[0].exitCode, 0);
    assert.equal(runner.calls.length, 1);
  });

  it('entry whose paths glob matches none of the changed files → status skipped', async () => {
    const runner = makeRunner([]);
    const { results } = await runTestCommandEntries({
      entries:      [entry('go', ['**/*.go'])],
      changedPaths: ['src/foo.ts', 'README.md'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'skipped');
    assert.equal(results[0].exitCode, null);
    assert.equal(results[0].stdout, '');
    assert.equal(results[0].timedOut, false);
    assert.equal(runner.calls.length, 0, 'runner must not be called for skipped entry');
  });

  it('entry with multiple globs where only second glob matches → entry runs', async () => {
    const runner = makeRunner([{ exitCode: 0 }]);
    const { results } = await runTestCommandEntries({
      entries:      [entry('multi', ['**/*.py', '**/*.ts'])],
      changedPaths: ['src/bar.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(results[0].status, 'passed');
    assert.equal(runner.calls.length, 1);
  });

  it('multiple entries: first matches, second does not → first runs, second skipped; both in results', async () => {
    const runner = makeRunner([{ exitCode: 0 }]);
    const { results } = await runTestCommandEntries({
      entries: [
        entry('ts',  ['**/*.ts']),
        entry('go',  ['**/*.go']),
      ],
      changedPaths: ['src/foo.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(results.length, 2);
    assert.equal(results[0].name, 'ts');
    assert.equal(results[0].status, 'passed');
    assert.equal(results[1].name, 'go');
    assert.equal(results[1].status, 'skipped');
    assert.equal(runner.calls.length, 1);
  });

  it('changedPaths empty → every entry skipped', async () => {
    const runner = makeRunner([]);
    const { results, anyFailed } = await runTestCommandEntries({
      entries: [
        entry('a', ['**/*.ts']),
        entry('b', ['**/*.go']),
      ],
      changedPaths: [],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'skipped'));
    assert.equal(anyFailed, false);
    assert.equal(runner.calls.length, 0);
  });
});

// ─── runTestCommandEntries — execution order ───────────────────────────────

describe('runTestCommandEntries — execution order', () => {
  it('two matched entries: A then B — runner called A first, then B', async () => {
    const runner = makeRunner([
      { exitCode: 0, durationMs: 5 },
      { exitCode: 0, durationMs: 5 },
    ]);
    await runTestCommandEntries({
      entries: [
        entry('A', ['**/*.ts'], 'cmd-a'),
        entry('B', ['**/*.ts'], 'cmd-b'),
      ],
      changedPaths: ['src/x.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(runner.calls.length, 2);
    assert.equal(runner.calls[0].cmd, 'cmd-a');
    assert.equal(runner.calls[1].cmd, 'cmd-b');
  });
});

// ─── runTestCommandEntries — aggregation ──────────────────────────────────

describe('runTestCommandEntries — aggregation', () => {
  it('two matched entries both exit 0 → anyFailed:false', async () => {
    const runner = makeRunner([
      { exitCode: 0 },
      { exitCode: 0 },
    ]);
    const { anyFailed } = await runTestCommandEntries({
      entries: [entry('a', ['**/*.ts']), entry('b', ['**/*.ts'])],
      changedPaths: ['src/x.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(anyFailed, false);
  });

  it('first exits 0, second exits 1 → anyFailed:true; first entry still ran', async () => {
    const runner = makeRunner([
      { exitCode: 0 },
      { exitCode: 1 },
    ]);
    const { results, anyFailed } = await runTestCommandEntries({
      entries: [entry('a', ['**/*.ts']), entry('b', ['**/*.ts'])],
      changedPaths: ['src/x.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(anyFailed, true);
    assert.equal(results[0].status, 'passed');
    assert.equal(results[1].status, 'failed');
    // Crucially — second entry still ran (no fail-fast)
    assert.equal(runner.calls.length, 2);
  });

  it('first exits 1, second exits 0 → second still runs; anyFailed:true', async () => {
    const runner = makeRunner([
      { exitCode: 1 },
      { exitCode: 0 },
    ]);
    const { results, anyFailed } = await runTestCommandEntries({
      entries: [entry('a', ['**/*.ts']), entry('b', ['**/*.ts'])],
      changedPaths: ['src/x.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(anyFailed, true);
    assert.equal(runner.calls.length, 2, 'second entry must still run (no fail-fast)');
    assert.equal(results[0].status, 'failed');
    assert.equal(results[1].status, 'passed');
  });

  it('all entries skipped → anyFailed:false', async () => {
    const runner = makeRunner([]);
    const { anyFailed } = await runTestCommandEntries({
      entries: [entry('a', ['**/*.py']), entry('b', ['**/*.go'])],
      changedPaths: ['src/x.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    assert.equal(anyFailed, false);
  });
});

// ─── runTestCommandEntries — result shape ──────────────────────────────────

describe('runTestCommandEntries — structured result shape', () => {
  it('ran entry has name, command, status passed/failed, non-null exitCode, and stdout', async () => {
    const runner = makeRunner([{ exitCode: 0, output: 'ok output', durationMs: 42 }]);
    const { results } = await runTestCommandEntries({
      entries:      [entry('mytest', ['**/*.ts'], 'run-mytest')],
      changedPaths: ['src/a.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    const r = results[0];
    assert.equal(r.name, 'mytest');
    assert.equal(r.command, 'run-mytest');
    assert.equal(r.status, 'passed');
    assert.equal(r.exitCode, 0);
    assert.equal(typeof r.stdout, 'string');
    assert.equal(r.stdout, 'ok output');
    assert.equal(r.timedOut, false);
    assert.equal(r.durationMs, 42);
  });

  it('skipped entry has status:skipped, exitCode:null, empty stdout, and timedOut:false', async () => {
    const runner = makeRunner([]);
    const { results } = await runTestCommandEntries({
      entries:      [entry('noop', ['**/*.py'])],
      changedPaths: ['src/a.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    const r = results[0];
    assert.equal(r.status, 'skipped');
    assert.equal(r.exitCode, null);
    assert.equal(r.stdout, '');
    assert.equal(r.timedOut, false);
  });

  it('failed entry (non-zero exit) has status:failed and captures output', async () => {
    const runner = makeRunner([{ exitCode: 2, output: 'FAIL output' }]);
    const { results } = await runTestCommandEntries({
      entries:      [entry('bad', ['**/*.ts'])],
      changedPaths: ['src/a.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    const r = results[0];
    assert.equal(r.status, 'failed');
    assert.equal(r.exitCode, 2);
    assert.equal(r.stdout, 'FAIL output');
    assert.equal(r.timedOut, false);
  });

  it('timed-out entry has status:failed, timedOut:true, and anyFailed:true', async () => {
    const runner = makeRunner([{ exitCode: null, timedOut: true, output: '' }]);
    const { results, anyFailed } = await runTestCommandEntries({
      entries:      [entry('slow', ['**/*.ts'])],
      changedPaths: ['src/a.ts'],
      projectRoot:  ROOT,
      runner,
      timeoutMs:    TIMEOUT_MS,
    });
    const r = results[0];
    assert.equal(r.status, 'failed');
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.equal(anyFailed, true);
  });

  it('runner receives the configured command, projectRoot, and timeoutMs', async () => {
    const runner = makeRunner([{ exitCode: 0 }]);
    await runTestCommandEntries({
      entries:      [entry('x', ['**/*.ts'], 'the-command')],
      changedPaths: ['a.ts'],
      projectRoot:  '/my/root',
      runner,
      timeoutMs:    99_000,
    });
    assert.equal(runner.calls[0].cmd, 'the-command');
    assert.equal(runner.calls[0].cwd, '/my/root');
    assert.equal(runner.calls[0].timeoutMs, 99_000);
  });
});

// ─── resolveGatePlan backward compatibility ───────────────────────────────

describe('resolveGatePlan — backward compatibility (no test_commands key)', () => {
  it('opts with no testCommands key → source is not test_commands (falls to detection)', () => {
    const plan = resolveGatePlan(ROOT, noFiles);
    assert.notEqual(plan.source, 'test_commands');
  });

  it('opts with testCommand set → source:configured regardless of testCommands', () => {
    const plan = resolveGatePlan(ROOT, {
      testCommand:  'npm test',
      testCommands: [entry('ts', ['**/*.ts'])],
      ...noFiles,
    });
    assert.equal(plan.source, 'configured');
  });
});

// ─── IntegrationGate.run() — test_commands path ───────────────────────────

describe('IntegrationGate.run() — test_commands path', () => {
  it('matched entries run and gate passes when all exit 0', async () => {
    const runner = makeRunner([
      { exitCode: 0, durationMs: 10 },
      { exitCode: 0, durationMs: 15 },
    ]);
    const gate = new IntegrationGate({
      testCommands:    [entry('a', ['**/*.ts']), entry('b', ['**/*.ts'])],
      runner,
      getChangedPaths: () => ['src/foo.ts'],
    });
    const out = await gate.run({ projectRoot: ROOT, conflicted: [] });
    assert.equal(out.ok, true);
    assert.equal(out.ran, true);
    assert.equal(runner.calls.length, 2);
    assert.equal(out.steps?.length, 2);
    assert.ok(out.steps?.every((s) => s.ok));
  });

  it('one entry fails → gate fails, but both entries still ran (no fail-fast)', async () => {
    const runner = makeRunner([
      { exitCode: 1, durationMs: 5 },
      { exitCode: 0, durationMs: 5 },
    ]);
    const gate = new IntegrationGate({
      testCommands:    [entry('a', ['**/*.ts']), entry('b', ['**/*.ts'])],
      runner,
      getChangedPaths: () => ['src/bar.ts'],
    });
    const out = await gate.run({ projectRoot: ROOT, conflicted: [] });
    assert.equal(out.ok, false);
    assert.equal(runner.calls.length, 2, 'second entry must still run');
    assert.equal(out.steps?.[0].ok, false);
    assert.equal(out.steps?.[1].ok, true);
  });

  it('no changed paths → all entries skipped → gate passes (anyFailed:false)', async () => {
    const runner = makeRunner([]);
    const gate = new IntegrationGate({
      testCommands:    [entry('a', ['**/*.ts']), entry('b', ['**/*.go'])],
      runner,
      getChangedPaths: () => [],
    });
    const out = await gate.run({ projectRoot: ROOT, conflicted: [] });
    assert.equal(out.ok, true);
    assert.equal(out.ran, false);
    assert.equal(runner.calls.length, 0);
  });

  it('testCommand present + testCommands → configured path wins (backward compat)', async () => {
    const runner = makeRunner([{ exitCode: 0, durationMs: 5 }]);
    const gate = new IntegrationGate({
      testCommand:     'npm test',
      testCommands:    [entry('ts', ['**/*.ts'])],
      runner,
      getChangedPaths: () => ['src/foo.ts'],
    });
    const out = await gate.run({ projectRoot: ROOT, conflicted: [] });
    // Only the single unit step from testCommand runs — testCommands is ignored
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].cmd, 'npm test');
    assert.equal(out.ok, true);
  });

  it('amputated stories + anyFailed → gate ok=false with amputation in summary', async () => {
    const runner = makeRunner([{ exitCode: 1, durationMs: 5 }]);
    const gate = new IntegrationGate({
      testCommands:    [entry('ts', ['**/*.ts'])],
      runner,
      getChangedPaths: () => ['src/foo.ts'],
    });
    const out = await gate.run({ projectRoot: ROOT, conflicted: ['story-001'] });
    assert.equal(out.ok, false);
    assert.deepEqual(out.amputated, ['story-001']);
    assert.match(out.summary, /story-001/);
  });

  it('steps field is a GateStepOutcome array with correct shape', async () => {
    const runner = makeRunner([{ exitCode: 0, output: 'test ok', durationMs: 42 }]);
    const gate = new IntegrationGate({
      testCommands:    [entry('mytest', ['src/*.ts'], 'run-mytest')],
      runner,
      getChangedPaths: () => ['src/index.ts'],
    });
    const out = await gate.run({ projectRoot: ROOT, conflicted: [] });
    const step = out.steps?.[0];
    assert.ok(step);
    assert.equal(step.name, 'mytest');
    assert.equal(step.kind, 'unit');
    assert.equal(step.command, 'run-mytest');
    assert.equal(step.ok, true);
    assert.equal(step.exitCode, 0);
    assert.equal(step.durationMs, 42);
    assert.equal(step.output, 'test ok');
  });

  it('timed-out entry → out.ok false AND out.timedOut true', async () => {
    const runner = makeRunner([{ exitCode: null, timedOut: true, durationMs: 5000 }]);
    const gate = new IntegrationGate({
      testCommands:    [entry('slow', ['**/*.ts'])],
      runner,
      getChangedPaths: () => ['src/foo.ts'],
    });
    const out = await gate.run({ projectRoot: ROOT, conflicted: [] });
    assert.equal(out.ok, false);
    assert.equal(out.timedOut, true);
  });

  it('null changedPaths (git base unresolvable) → all entries run unconditionally', async () => {
    const runner = makeRunner([{ exitCode: 0, durationMs: 5 }, { exitCode: 0, durationMs: 5 }]);
    const gate = new IntegrationGate({
      testCommands:    [entry('a', ['**/*.ts']), entry('b', ['**/*.go'])],
      runner,
      getChangedPaths: () => null,
    });
    const out = await gate.run({ projectRoot: ROOT, conflicted: [] });
    assert.equal(out.ok, true);
    assert.equal(runner.calls.length, 2, 'both entries must run when git base unresolvable');
    assert.equal(out.ran, true);
  });
});
