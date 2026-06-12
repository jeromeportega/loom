import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightGateCommand } from '@loom-ai/core';
import type { GatePreflightResult } from '@loom-ai/core';
import { gateCommandCheck } from '../commands/doctorGateCheck.js';

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
