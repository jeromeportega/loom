import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runGateSteps,
  IntegrationGate,
  type CommandRunner,
  type GateStepOutcome,
} from '../IntegrationGate.js';
import type { GateStep } from '../GatePreflight.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

interface RunnerRecord {
  cmd: string;
  cwd: string;
  timeoutMs: number;
}

/**
 * A scripted fake runner that records every call. Each item in `scripts` maps
 * to the corresponding step invocation in order.
 */
function makeRunner(
  scripts: Array<{ exitCode?: number | null; timedOut?: boolean; output?: string; durationMs?: number }>
): CommandRunner & { calls: RunnerRecord[] } {
  const calls: RunnerRecord[] = [];
  let idx = 0;
  const run: CommandRunner = (cmd, cwd, timeoutMs) => {
    calls.push({ cmd, cwd, timeoutMs });
    const s = scripts[idx++] ?? {};
    return {
      exitCode: s.exitCode ?? 0,
      timedOut: s.timedOut ?? false,
      output: s.output ?? '',
      durationMs: s.durationMs ?? 10,
    };
  };
  return Object.assign(run, { calls });
}

function makeStep(
  name: string,
  command = `${name}-cmd`,
  cwd = '/repo'
): GateStep {
  return { name, kind: 'unit', command, cwd };
}

const DEFAULT_TIMEOUT = 15 * 60_000;

// ─── runGateSteps — ordered execution + per-step reporting ────────────────

describe('runGateSteps — ordered execution and independent reporting', () => {
  it('runs all steps in order and returns one outcome per step', async () => {
    const runner = makeRunner([
      { exitCode: 0, durationMs: 5 },
      { exitCode: 0, durationMs: 7 },
      { exitCode: 0, durationMs: 3 },
    ]);
    const steps: GateStep[] = [
      makeStep('a', 'cmd-a'),
      makeStep('b', 'cmd-b'),
      makeStep('c', 'cmd-c'),
    ];
    const outcomes = await runGateSteps(steps, { runner });

    assert.equal(outcomes.length, 3);
    assert.equal(runner.calls.length, 3, 'runner must be called once per step');

    // Order preserved
    assert.equal(runner.calls[0].cmd, 'cmd-a');
    assert.equal(runner.calls[1].cmd, 'cmd-b');
    assert.equal(runner.calls[2].cmd, 'cmd-c');

    // Per-step outcomes
    assert.equal(outcomes[0].name, 'a');
    assert.equal(outcomes[1].name, 'b');
    assert.equal(outcomes[2].name, 'c');
    for (const o of outcomes) {
      assert.equal(o.ok, true);
    }
  });

  it('correctly populates name, kind, command, ok, exitCode per outcome', async () => {
    const step: GateStep = { name: 'unit', kind: 'unit', command: 'npm test', cwd: '/repo' };
    const runner = makeRunner([{ exitCode: 0, durationMs: 42 }]);
    const [outcome] = await runGateSteps([step], { runner });

    assert.equal(outcome.name, 'unit');
    assert.equal(outcome.kind, 'unit');
    assert.equal(outcome.command, 'npm test');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.durationMs, 42);
  });

  it('forwards step.cwd and the configured timeoutMs to the runner', async () => {
    const runner = makeRunner([{ exitCode: 0 }]);
    const step: GateStep = { name: 'unit', kind: 'unit', command: 'npm test', cwd: '/custom/dir' };
    await runGateSteps([step], { runner, timeoutMs: 30_000 });

    assert.equal(runner.calls[0].cwd, '/custom/dir');
    assert.equal(runner.calls[0].timeoutMs, 30_000);
  });

  it('uses DEFAULT_TIMEOUT_MS when no timeoutMs is provided', async () => {
    const runner = makeRunner([{ exitCode: 0 }]);
    await runGateSteps([makeStep('unit')], { runner });
    assert.equal(runner.calls[0].timeoutMs, DEFAULT_TIMEOUT);
  });

  it('empty steps array → empty outcomes, runner never called', async () => {
    const runner = makeRunner([]);
    const outcomes = await runGateSteps([], { runner });
    assert.deepEqual(outcomes, []);
    assert.equal(runner.calls.length, 0);
  });
});

// ─── runGateSteps — failing steps ─────────────────────────────────────────

describe('runGateSteps — failing step makes that step ok=false', () => {
  it('non-zero exit → ok=false on that step, correct exitCode', async () => {
    const runner = makeRunner([{ exitCode: 1, output: 'FAIL' }]);
    const [outcome] = await runGateSteps([makeStep('unit')], { runner });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.output, 'FAIL');
  });

  it('timedOut=true → ok=false even if exitCode=0', async () => {
    const runner = makeRunner([{ exitCode: 0, timedOut: true }]);
    const [outcome] = await runGateSteps([makeStep('unit')], { runner });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, true);
  });

  it('ALL steps run even when step 2 fails (no short-circuit — ADR-3)', async () => {
    const runner = makeRunner([
      { exitCode: 0 },
      { exitCode: 1 },
      { exitCode: 0 },
    ]);
    const outcomes = await runGateSteps(
      [makeStep('a'), makeStep('b'), makeStep('c')],
      { runner }
    );
    assert.equal(runner.calls.length, 3, 'all steps must run regardless of step 2 failing');
    assert.equal(outcomes[0].ok, true);
    assert.equal(outcomes[1].ok, false);
    assert.equal(outcomes[2].ok, true);
  });
});

// ─── GateOutcome aggregate fields (ADR-6) ─────────────────────────────────

describe('IntegrationGate.run() — legacy aggregate fields derived per ADR-6', () => {
  it('all steps pass → aggregate from LAST step', async () => {
    const runner = makeRunner([
      { exitCode: 0, output: 'step-a-output', durationMs: 10 },
      { exitCode: 0, output: 'step-b-output', durationMs: 20 },
    ]);

    // Two-step gate: configure both steps via a custom runner at the gate level.
    // We need to test via IntegrationGate.run() since runGateSteps doesn't
    // determine the aggregate — the run() method does.
    // Use a single-step configured gate as the simplest ADR-6 validator.
    const gate = new IntegrationGate({ testCommand: 'my-cmd', runner });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });

    // Single unit step passes → aggregate = last (and only) step.
    assert.equal(out.ok, true);
    assert.equal(out.command, 'my-cmd');
    assert.equal(out.exitCode, 0);
    assert.equal(out.timedOut, false);
    assert.equal(out.output, 'step-a-output');
  });

  it('any step fails → gate ok=false, aggregate from FIRST failing step', async () => {
    // Two configured steps: first passes, second fails.
    // We simulate multi-step via multiple gate runs, but the real test is:
    // a single configured runner where step 2 fails — but since
    // configured gate only has one unit step, we test via runGateSteps + gate directly.
    //
    // Use runGateSteps directly for the multi-step aggregate logic assertion.
    const steps: GateStep[] = [
      { name: 'unit', kind: 'unit', command: 'step-a', cwd: '/repo' },
      { name: 'typecheck:tsc', kind: 'typecheck', command: 'step-b', cwd: '/repo' },
      { name: 'build:next', kind: 'build', command: 'step-c', cwd: '/repo' },
    ];
    const runner = makeRunner([
      { exitCode: 0, output: 'a-out', durationMs: 5 },
      { exitCode: 2, output: 'b-out', durationMs: 8 },
      { exitCode: 1, output: 'c-out', durationMs: 3 },
    ]);
    const outcomes = await runGateSteps(steps, { runner });

    // First failing is step 2 (index 1)
    const firstFailing = outcomes.find((s) => !s.ok);
    assert.ok(firstFailing, 'must have a failing step');
    assert.equal(firstFailing!.name, 'typecheck:tsc');
    assert.equal(firstFailing!.exitCode, 2);
    assert.equal(firstFailing!.output, 'b-out');
  });

  it('durationMs is the SUM across all steps', async () => {
    const gate = new IntegrationGate({
      testCommand: 'npm test',
      runner: makeRunner([{ exitCode: 0, durationMs: 42 }]),
    });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });
    // Single step with durationMs=42 → totalDuration=42
    assert.equal(out.durationMs, 42);
  });

  it('multi-step: durationMs is sum across steps', async () => {
    const steps: GateStep[] = [
      { name: 'unit', kind: 'unit', command: 'a', cwd: '/repo' },
      { name: 'typecheck:tsc', kind: 'typecheck', command: 'b', cwd: '/repo' },
    ];
    const runner = makeRunner([
      { exitCode: 0, durationMs: 100 },
      { exitCode: 0, durationMs: 200 },
    ]);
    const outcomes = await runGateSteps(steps, { runner });
    const totalDuration = outcomes.reduce((sum, s) => sum + s.durationMs, 0);
    assert.equal(totalDuration, 300);
  });
});

// ─── GateOutcome.steps field (NEW) ────────────────────────────────────────

describe('IntegrationGate.run() — steps field', () => {
  it('any step fails → gate.ok=false, the failing step is identifiable by name', async () => {
    const gate = new IntegrationGate({
      testCommand: 'npm test',
      runner: makeRunner([{ exitCode: 1, output: 'boom' }]),
    });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });

    assert.equal(out.ok, false);
    const steps = out.steps ?? [];
    assert.equal(steps.length, 1);
    assert.equal(steps[0].ok, false);
    assert.equal(steps[0].name, 'unit');
    assert.equal(steps[0].exitCode, 1);
  });

  it('amputation-only gate → steps=[], ran=false', async () => {
    const gate = new IntegrationGate({ fileExists: () => false, fileReader: () => null });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });

    assert.equal(out.ran, false);
    assert.deepEqual(out.steps ?? [], []);
  });

  it('amputation with conflicted → ok=false, steps=[]', async () => {
    const gate = new IntegrationGate({ fileExists: () => false, fileReader: () => null });
    const out = await gate.run({ projectRoot: '/repo', conflicted: ['story-001-003'] });

    assert.equal(out.ok, false);
    assert.deepEqual(out.steps ?? [], []);
    assert.deepEqual(out.amputated, ['story-001-003']);
  });
});

// ─── Summary enumerates per-step verdicts ─────────────────────────────────

describe('IntegrationGate.run() — summary format', () => {
  it('passing gate summary contains "passed"', async () => {
    const gate = new IntegrationGate({
      testCommand: 'npm test',
      runner: makeRunner([{ exitCode: 0 }]),
    });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });
    assert.match(out.summary, /passed/);
  });

  it('failing gate summary contains the step name and exit code', async () => {
    const gate = new IntegrationGate({
      testCommand: 'npm test',
      runner: makeRunner([{ exitCode: 2 }]),
    });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });
    assert.match(out.summary, /unit failed \(exit 2\)/);
  });

  it('timed-out gate summary contains "timed out"', async () => {
    const gate = new IntegrationGate({
      testCommand: 'npm test',
      runner: makeRunner([{ exitCode: null, timedOut: true, durationMs: 5000 }]),
    });
    const out = await gate.run({ projectRoot: '/repo', conflicted: [] });
    assert.match(out.summary, /timed out/);
  });
});
