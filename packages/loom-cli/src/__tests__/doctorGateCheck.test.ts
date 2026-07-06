import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightGateCommand } from '@loom-ai/core';
import type { GatePreflightResult, GateStep, GateStepOutcome } from '@loom-ai/core';
import { gateCommandCheck, gateRunnableCheck } from '../commands/doctorGateCheck.js';
import type { PathDivergenceProbe } from '../commands/doctorGateCheck.js';

type Preflight = typeof preflightGateCommand;

function viable(command?: string): GatePreflightResult {
  return {
    resolved:
      command === undefined
        ? { cwd: '/repo', source: 'none' }
        : { command, cwd: '/repo', source: 'auto-detected' },
    viable: true,
    reasons: [],
  };
}

function nonViable(): GatePreflightResult {
  return {
    resolved: { command: 'npm test', cwd: '/repo', source: 'auto-detected' },
    viable: false,
    reasons: ['No package-lock.json at /repo.'],
    recommendation: 'npm ci && npm test',
  };
}

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-doctor-gate-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gateCommandCheck', () => {
  it('reports ok when the preflight is viable', () => {
    const check = gateCommandCheck(tmpDir, () => viable('npm test'));
    assert.equal(check.ok, true);
    assert.equal(check.name, 'integration gate command');
    assert.ok(check.detail.includes('npm test'));
  });

  it('reports not-ok with the test_command recommendation when non-viable', () => {
    const check = gateCommandCheck(tmpDir, nonViable);
    assert.equal(check.ok, false);
    assert.ok(check.detail.includes('test_command'));
    assert.ok(check.detail.includes('npm ci && npm test'));
  });

  it('pins required to false in BOTH outcomes — preflight can never flip doctor exit code', () => {
    const okCheck = gateCommandCheck(tmpDir, () => viable('npm test'));
    const failCheck = gateCommandCheck(tmpDir, nonViable);
    assert.equal(okCheck.required, false);
    assert.equal(failCheck.required, false);
  });

  it('reports the amputation-only state when no command is detectable', () => {
    const check = gateCommandCheck(tmpDir, () => viable(undefined));
    assert.equal(check.ok, true);
    assert.ok(check.detail.includes('amputation'));
    assert.equal(check.required, false);
  });

  it('forwards policy.agents.test_command into the preflight', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-doctor-policy-'));
    fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.loom', 'policy.yaml'),
      'agents:\n  test_command: "make check"\n'
    );
    let received: string | undefined;
    const spy: Preflight = (_root, opts) => {
      received = opts.testCommand;
      return viable('make check');
    };
    gateCommandCheck(root, spy);
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(received, 'make check');
  });

  it('annotates the detail when integration_gate is off', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-doctor-off-'));
    fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.loom', 'policy.yaml'),
      'agents:\n  integration_gate: "off"\n'
    );
    const check = gateCommandCheck(root, nonViable);
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(check.detail.includes('integration_gate is off'));
    assert.equal(check.required, false);
  });

  it('swallows an internal preflight failure instead of breaking doctor', () => {
    const throwing: Preflight = () => {
      throw new Error('boom');
    };
    let check: ReturnType<typeof gateCommandCheck> | undefined;
    assert.doesNotThrow(() => {
      check = gateCommandCheck(tmpDir, throwing);
    });
    assert.ok(check);
    assert.equal(check!.required, false);
    assert.ok(check!.detail.includes('preflight skipped'));
  });
});

describe('loom doctor renders the gate check (subprocess)', () => {
  const LOOM_CLI = path.resolve(__dirname, '../index.js');
  let repoDir: string;

  function doctor(): { stdout: string; status: number } {
    try {
      const stdout = execSync(`node "${LOOM_CLI}" doctor`, {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LOOM_HOME: path.join(repoDir, '.loom-home') },
      });
      return { stdout, status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? '', status: e.status ?? 1 };
    }
  }

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-doctor-cli-'));
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } })
    );
  });

  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('shows a warn line (not FAIL) for a non-viable gate command and still exits 0', () => {
    const result = doctor();
    assert.equal(result.status, 0, 'a non-viable gate command must never fail doctor');
    const line = result.stdout
      .split('\n')
      .find((l) => l.includes('integration gate command'));
    assert.ok(line, 'doctor output includes the gate check');
    assert.ok(line!.includes('[warn]'));
    assert.ok(line!.includes('npm ci && npm test'));
  });

  it('shows an ok line once the command is viable', () => {
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{}');
    const result = doctor();
    assert.equal(result.status, 0);
    const line = result.stdout
      .split('\n')
      .find((l) => l.includes('integration gate command'));
    assert.ok(line, 'doctor output includes the gate check');
    assert.ok(line!.includes('[ok  ]'));
  });
});

// ── gateRunnableCheck — unit tests with injected deps ────────────────────────

/** A minimal passing ResolvedGatePlan for injection into gateRunnableCheck. */
function passingPlan(command = 'npm test') {
  return {
    steps: [{ name: 'unit', kind: 'unit' as const, command, cwd: '/repo' }],
    source: 'configured' as const,
    cwd: '/repo',
  };
}

/** Run stub: every step passes. */
async function allGreenRunner(steps: GateStep[]): Promise<GateStepOutcome[]> {
  return steps.map((s) => ({
    name: s.name,
    kind: s.kind,
    command: s.command,
    ok: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 50,
    output: '',
  }));
}

/** Run stub: every step fails with exit 1. */
async function allFailRunner(steps: GateStep[]): Promise<GateStepOutcome[]> {
  return steps.map((s) => ({
    name: s.name,
    kind: s.kind,
    command: s.command,
    ok: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 50,
    output: 'error output',
  }));
}

/** Probe stub: no PATH divergence (binary on both login and sh PATH). */
const noDivergenceProbe = (_steps: GateStep[]): PathDivergenceProbe[] =>
  _steps.map((s) => ({ binary: s.command.split(/\s+/)[0], onLogin: true, onSh: true }));

describe('gateRunnableCheck — passes iff gate passes (FR-10)', () => {
  let tmpDir: string;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-fr10-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ok:true when all steps pass', async () => {
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan(),
      run: allGreenRunner,
      probePathDivergence: noDivergenceProbe,
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, 'gate-runnable');
    assert.equal(result.required, false);
  });

  it('ok:false when any step fails', async () => {
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan(),
      run: allFailRunner,
      probePathDivergence: noDivergenceProbe,
    });
    assert.equal(result.ok, false);
    assert.equal(result.required, false);
    assert.ok(result.detail.includes('gate failed'), `detail should describe failure: ${result.detail}`);
  });

  it('required:false in both pass and fail branches', async () => {
    const pass = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan(),
      run: allGreenRunner,
      probePathDivergence: noDivergenceProbe,
    });
    const fail = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan(),
      run: allFailRunner,
      probePathDivergence: noDivergenceProbe,
    });
    assert.equal(pass.required, false, 'pass case: required must be false');
    assert.equal(fail.required, false, 'fail case: required must be false');
  });

  it('consumes runGateSteps output — run dep is called with the resolved plan steps', async () => {
    let receivedSteps: GateStep[] | undefined;
    const plan = passingPlan('make test');
    await gateRunnableCheck(tmpDir, {
      resolve: () => plan,
      run: async (steps) => {
        receivedSteps = steps;
        return allGreenRunner(steps);
      },
      probePathDivergence: noDivergenceProbe,
    });
    assert.deepEqual(receivedSteps, plan.steps, 'run dep must receive the plan steps');
  });

  it('ok:true when source is none (no steps)', async () => {
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => ({ steps: [], source: 'none' as const, cwd: '/repo' }),
      run: allGreenRunner,
      probePathDivergence: noDivergenceProbe,
    });
    assert.equal(result.ok, true);
    assert.ok(result.detail.includes('amputation'), `detail should mention amputation: ${result.detail}`);
    assert.equal(result.required, false);
  });
});

describe('gateRunnableCheck — PATH-divergence warning (FR-11)', () => {
  let tmpDir: string;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-fr11-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ok:false with explicit warning when binary on login PATH but not gate sh PATH', async () => {
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan('uv run pytest'),
      run: allGreenRunner,
      probePathDivergence: (_steps) => [{ binary: 'uv', onLogin: true, onSh: false }],
    });
    assert.equal(result.ok, false, 'PATH divergence must set ok:false');
    assert.ok(result.detail.includes('"uv"'), `detail must name the diverged binary: ${result.detail}`);
    assert.ok(
      result.detail.toLowerCase().includes('path divergence'),
      `detail must mention PATH divergence: ${result.detail}`
    );
    assert.equal(result.required, false);
  });

  it('no warning and run is called when binary is on both paths', async () => {
    let runCalled = false;
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan('uv run pytest'),
      run: async (steps) => {
        runCalled = true;
        return allGreenRunner(steps);
      },
      probePathDivergence: (_steps) => [{ binary: 'uv', onLogin: true, onSh: true }],
    });
    assert.equal(result.ok, true);
    assert.ok(runCalled, 'run dep must be called when no PATH divergence');
    assert.ok(
      !result.detail.toLowerCase().includes('path divergence'),
      `detail must not mention PATH divergence: ${result.detail}`
    );
  });

  it('required:false in PATH-divergence branch', async () => {
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan('uv run pytest'),
      run: allGreenRunner,
      probePathDivergence: (_steps) => [{ binary: 'uv', onLogin: true, onSh: false }],
    });
    assert.equal(result.required, false);
  });
});

describe('gateRunnableCheck — integration: real /bin/sh execution', () => {
  it('ok:true for `true` — end-to-end /bin/sh execution via defaultRunner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-int-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.loom', 'policy.yaml'),
        'agents:\n  test_command: "true"\n'
      );
      const result = await gateRunnableCheck(root);
      assert.equal(result.ok, true, `expected ok:true for 'true', got: ${result.detail}`);
      assert.equal(result.required, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ok:false for `false` — exit code 1 reflects real gate failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-int-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.loom', 'policy.yaml'),
        'agents:\n  test_command: "false"\n'
      );
      const result = await gateRunnableCheck(root);
      assert.equal(result.ok, false, `expected ok:false for 'false', got: ${result.detail}`);
      assert.equal(result.required, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
