import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightGateCommand } from '@loom-ai/core';
import type { GatePreflightResult } from '@loom-ai/core';
import { gateCommandCheck, gateRunnableCheck } from '../commands/doctorGateCheck.js';

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

describe('gateRunnableCheck — verifies lead binaries resolve on the gate PATH (FR-9/10/11)', () => {
  let tmpDir: string;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ok:true when every step lead binary resolves on the gate PATH', async () => {
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan('make test'),
      binaryResolves: () => true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, 'gate-runnable');
    assert.equal(result.required, false);
  });

  it('ok:false naming a binary that does NOT resolve (the uv-off-the-gate-PATH friction)', async () => {
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan('uv run pytest'),
      binaryResolves: (b) => b !== 'uv',
    });
    assert.equal(result.ok, false, 'a missing lead binary must set ok:false');
    assert.ok(result.detail.includes('"uv"'), `detail must name the missing binary: ${result.detail}`);
    assert.ok(
      result.detail.toLowerCase().includes("gate's path"),
      `detail must mention the gate's PATH: ${result.detail}`
    );
    assert.equal(result.required, false);
  });

  it('does NOT execute the suite (side-effect-free) — points at --dry-run-gate for real exec', async () => {
    // The new check only probes binary resolution; it must never run the command.
    // A command that would fail if executed still yields ok:true because it is not run.
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan('false'),
      binaryResolves: () => true,
    });
    assert.equal(result.ok, true, 'binary-resolution check must not execute the command');
    assert.ok(
      result.detail.includes('--dry-run-gate'),
      `detail should point at --dry-run-gate for real execution: ${result.detail}`
    );
  });

  it('ok:true when source is none (no steps) — amputation-only gate', async () => {
    const result = await gateRunnableCheck(tmpDir, {
      resolve: () => ({ steps: [], source: 'none' as const, cwd: '/repo' }),
      binaryResolves: () => true,
    });
    assert.equal(result.ok, true);
    assert.ok(result.detail.includes('amputation'), `detail should mention amputation: ${result.detail}`);
    assert.equal(result.required, false);
  });

  it('required:false in every branch (advisory)', async () => {
    const pass = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan('make test'),
      binaryResolves: () => true,
    });
    const missing = await gateRunnableCheck(tmpDir, {
      resolve: () => passingPlan('uv run pytest'),
      binaryResolves: () => false,
    });
    assert.equal(pass.required, false);
    assert.equal(missing.required, false);
  });

  it('dedupes lead binaries across steps (npx probed once)', async () => {
    let probeCount = 0;
    const plan = {
      steps: [
        { name: 'unit', kind: 'unit' as const, command: 'npx --no-install jest', cwd: '/repo' },
        { name: 'typecheck:tsc', kind: 'typecheck' as const, command: 'npx --no-install tsc --noEmit', cwd: '/repo' },
      ],
      source: 'auto-detected' as const,
      cwd: '/repo',
    };
    await gateRunnableCheck(tmpDir, {
      resolve: () => plan,
      binaryResolves: () => { probeCount++; return true; },
    });
    assert.equal(probeCount, 1, 'the shared lead binary (npx) is probed once, not per step');
  });
});

describe('gateRunnableCheck — integration: real /bin/sh binary resolution', () => {
  it('ok:true when the lead binary resolves (test_command: "true")', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-int-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      fs.writeFileSync(path.join(root, '.loom', 'policy.yaml'), 'agents:\n  test_command: "true"\n');
      const result = await gateRunnableCheck(root);
      assert.equal(result.ok, true, `'true' resolves on PATH → ok:true, got: ${result.detail}`);
      assert.equal(result.required, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ok:false when the lead binary is missing (nonexistent command)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-int-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.loom', 'policy.yaml'),
        'agents:\n  test_command: "loom-nonexistent-binary-xyz --run"\n'
      );
      const result = await gateRunnableCheck(root);
      assert.equal(result.ok, false, `a missing binary → ok:false, got: ${result.detail}`);
      assert.ok(
        result.detail.includes('loom-nonexistent-binary-xyz'),
        `detail names the missing binary: ${result.detail}`
      );
      assert.equal(result.required, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── gateRunnableCheck — test_commands binary preflight ────────────────────────

/** Write a minimal policy YAML with test_commands entries to a .loom dir. */
function writePolicyWithTestCommands(loomDir: string, entries: Array<{ name: string; command: string; paths: string[] }>): void {
  const entriesYaml = entries
    .map((e) => [
      `    - name: "${e.name}"`,
      `      command: "${e.command}"`,
      `      paths:`,
      ...e.paths.map((p) => `        - "${p}"`),
    ].join('\n'))
    .join('\n');
  fs.writeFileSync(
    path.join(loomDir, 'policy.yaml'),
    `agents:\n  test_commands:\n${entriesYaml}\n`
  );
}

/** A zero-step plan (simulates test_commands source path from resolveGatePlan). */
const noStepsPlan = { steps: [] as { name: string; kind: 'unit'; command: string; cwd: string }[], source: 'none' as const, cwd: '/repo' };

describe('gateRunnableCheck — test_commands binary preflight (story-078-003)', () => {
  it('no issues when all test_commands binaries resolve on PATH', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      writePolicyWithTestCommands(path.join(root, '.loom'), [
        { name: 'unit', command: 'jest --coverage', paths: ['src/**'] },
      ]);
      const result = await gateRunnableCheck(root, {
        resolve: () => noStepsPlan,
        binaryResolves: () => true,
      });
      assert.equal(result.ok, true, `all binaries resolve → ok:true, got: ${result.detail}`);
      assert.equal(result.required, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('error when one entry lead binary NOT on PATH — names entry.name and binary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      writePolicyWithTestCommands(path.join(root, '.loom'), [
        { name: 'unit', command: 'jest --coverage', paths: ['src/**'] },
      ]);
      const result = await gateRunnableCheck(root, {
        resolve: () => noStepsPlan,
        binaryResolves: () => false,
      });
      assert.equal(result.ok, false, `missing binary → ok:false`);
      assert.equal(result.required, false);
      assert.ok(result.detail.includes('"unit"'), `detail names entry "unit": ${result.detail}`);
      assert.ok(result.detail.includes('"jest"'), `detail names binary "jest": ${result.detail}`);
      assert.ok(
        result.detail.includes('test_commands entry'),
        `detail uses naming pattern: ${result.detail}`
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('two missing binaries → two error entries, each naming its own entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      writePolicyWithTestCommands(path.join(root, '.loom'), [
        { name: 'unit', command: 'jest --coverage', paths: ['src/**'] },
        { name: 'e2e', command: 'playwright test', paths: ['e2e/**'] },
      ]);
      const result = await gateRunnableCheck(root, {
        resolve: () => noStepsPlan,
        binaryResolves: () => false,
      });
      assert.equal(result.ok, false);
      assert.ok(result.detail.includes('"unit"'), `detail names entry "unit": ${result.detail}`);
      assert.ok(result.detail.includes('"jest"'), `detail names binary "jest": ${result.detail}`);
      assert.ok(result.detail.includes('"e2e"'), `detail names entry "e2e": ${result.detail}`);
      assert.ok(result.detail.includes('"playwright"'), `detail names binary "playwright": ${result.detail}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('policy with no test_commands key → skip check, no new issues', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      fs.writeFileSync(path.join(root, '.loom', 'policy.yaml'), 'agents: {}\n');
      const result = await gateRunnableCheck(root, {
        resolve: () => noStepsPlan,
        binaryResolves: () => { throw new Error('should not probe any binary'); },
      });
      assert.equal(result.ok, true, `no test_commands → ok:true, got: ${result.detail}`);
      assert.equal(result.required, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('policy with test_commands: [] → zero entries, no issues', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      fs.writeFileSync(path.join(root, '.loom', 'policy.yaml'), 'agents:\n  test_commands: []\n');
      const result = await gateRunnableCheck(root, {
        resolve: () => noStepsPlan,
        binaryResolves: () => { throw new Error('should not probe any binary'); },
      });
      assert.equal(result.ok, true, `empty test_commands → ok:true, got: ${result.detail}`);
      assert.equal(result.required, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('multi-word command → lead binary extracted as first token only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      writePolicyWithTestCommands(path.join(root, '.loom'), [
        { name: 'unit', command: 'jest --coverage --watchAll=false', paths: ['src/**'] },
      ]);
      let binaryProbed: string | undefined;
      await gateRunnableCheck(root, {
        resolve: () => noStepsPlan,
        binaryResolves: (b) => { binaryProbed = b; return true; },
      });
      assert.equal(binaryProbed, 'jest', `lead binary should be "jest", got "${binaryProbed}"`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leading whitespace in command → trimmed before binary extraction', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      // Write the YAML with leading space in the command value
      fs.writeFileSync(
        path.join(root, '.loom', 'policy.yaml'),
        'agents:\n  test_commands:\n    - name: unit\n      command: "  jest"\n      paths:\n        - "src/**"\n'
      );
      let binaryProbed: string | undefined;
      await gateRunnableCheck(root, {
        resolve: () => noStepsPlan,
        binaryResolves: (b) => { binaryProbed = b; return true; },
      });
      assert.equal(binaryProbed, 'jest', `whitespace-trimmed binary should be "jest", got "${binaryProbed}"`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('auto-detected step binary errors and test_commands errors surface together', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      writePolicyWithTestCommands(path.join(root, '.loom'), [
        { name: 'unit', command: 'jest --coverage', paths: ['src/**'] },
      ]);
      const result = await gateRunnableCheck(root, {
        resolve: () => ({
          steps: [{ name: 'run', kind: 'unit' as const, command: 'pytest', cwd: root }],
          source: 'auto-detected' as const,
          cwd: root,
        }),
        binaryResolves: () => false,
      });
      assert.equal(result.ok, false, `both missing → ok:false`);
      assert.equal(result.required, false);
      assert.ok(result.detail.includes('"pytest"'), `auto-detected binary in detail: ${result.detail}`);
      assert.ok(result.detail.includes('"jest"'), `test_commands binary in detail: ${result.detail}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gateRunnableCheck — doctor call path integration (story-078-003)', () => {
  const LOOM_CLI = path.resolve(__dirname, '../index.js');

  it('loom doctor surfaces test_commands missing-binary errors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-grc-tc-doctor-'));
    try {
      fs.mkdirSync(path.join(root, '.loom'), { recursive: true });
      // Use a nonexistent binary so the check fails without needing binary stubs.
      fs.writeFileSync(
        path.join(root, '.loom', 'policy.yaml'),
        [
          'agents:',
          '  test_commands:',
          '    - name: unit',
          '      command: "loom-nonexistent-tc-binary-xyz --run"',
          '      paths:',
          '        - "src/**"',
        ].join('\n') + '\n'
      );
      let stdout = '';
      try {
        const out = execSync(`node "${LOOM_CLI}" doctor`, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LOOM_HOME: path.join(root, '.loom-home') },
        });
        stdout = out;
      } catch (err: unknown) {
        stdout = (err as { stdout?: string }).stdout ?? '';
      }
      assert.ok(
        stdout.includes('loom-nonexistent-tc-binary-xyz'),
        `doctor output names the missing binary: ${stdout}`
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
