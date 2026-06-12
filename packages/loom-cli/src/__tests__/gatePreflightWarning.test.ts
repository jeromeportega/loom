import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, preflightGateCommand } from '@loom-ai/core';
import type { GatePreflightResult, Policy } from '@loom-ai/core';
import { maybeWarnGatePreflight } from '../commands/gatePreflightWarning.js';

type Preflight = typeof preflightGateCommand;

function policyWith(gate: 'off' | 'warn' | 'block', testCommand?: string): Policy {
  const policy = PolicyEngine.defaultPolicy();
  policy.agents.integration_gate = gate;
  policy.agents.test_command = testCommand;
  return policy;
}

function nonViable(): GatePreflightResult {
  return {
    resolved: { command: 'npm test', cwd: '/repo', source: 'auto-detected' },
    viable: false,
    reasons: ['No package-lock.json at /repo.'],
    recommendation: 'npm ci && npm test',
  };
}

function viable(): GatePreflightResult {
  return {
    resolved: { command: 'npm test', cwd: '/repo', source: 'auto-detected' },
    viable: true,
    reasons: [],
  };
}

let warnings: string[];
let originalWarn: typeof console.warn;
let originalExit: typeof process.exit;
let exitCalls: number;

beforeEach(() => {
  warnings = [];
  exitCalls = 0;
  originalWarn = console.warn;
  originalExit = process.exit;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  // NFR-2 sentinel: any process.exit from the warning path is recorded, not obeyed.
  process.exit = ((code?: number) => {
    exitCalls += 1;
    throw new Error(`process.exit(${code}) called`);
  }) as typeof process.exit;
});

afterEach(() => {
  console.warn = originalWarn;
  process.exit = originalExit;
});

describe('maybeWarnGatePreflight', () => {
  it('warns exactly once, naming the test_command to set, when gate is on and preflight non-viable', () => {
    maybeWarnGatePreflight('/repo', policyWith('warn'), nonViable);
    assert.equal(warnings.length, 1, 'exactly one console.warn block');
    const block = warnings[0];
    assert.ok(block.includes('WARNING'));
    assert.ok(block.includes('test_command: "npm ci && npm test"'));
    assert.ok(block.includes('advisory'));
  });

  it('also warns under integration_gate=block — any non-off gate mode', () => {
    maybeWarnGatePreflight('/repo', policyWith('block'), nonViable);
    assert.equal(warnings.length, 1);
  });

  it('is silent when integration_gate is off', () => {
    let preflightCalled = false;
    const spy: Preflight = () => {
      preflightCalled = true;
      return nonViable();
    };
    maybeWarnGatePreflight('/repo', policyWith('off'), spy);
    assert.equal(warnings.length, 0);
    assert.equal(preflightCalled, false, 'preflight is not even consulted when the gate is off');
  });

  it('is silent when the preflight is viable', () => {
    maybeWarnGatePreflight('/repo', policyWith('warn'), viable);
    assert.equal(warnings.length, 0);
  });

  it('forwards policy.agents.test_command to the preflight', () => {
    let received: string | undefined;
    const spy: Preflight = (_root, opts) => {
      received = opts.testCommand;
      return viable();
    };
    maybeWarnGatePreflight('/repo', policyWith('warn', 'make check'), spy);
    assert.equal(received, 'make check');
  });

  it('swallows an internal preflight throw — nothing escapes (NFR-2)', () => {
    const throwing: Preflight = () => {
      throw new Error('preflight exploded');
    };
    let returned: unknown = 'sentinel';
    assert.doesNotThrow(() => {
      returned = maybeWarnGatePreflight('/repo', policyWith('warn'), throwing);
    });
    assert.equal(returned, undefined, 'returns void');
  });

  it('never calls process.exit in any branch', () => {
    maybeWarnGatePreflight('/repo', policyWith('warn'), nonViable);
    maybeWarnGatePreflight('/repo', policyWith('off'), nonViable);
    maybeWarnGatePreflight('/repo', policyWith('warn'), viable);
    maybeWarnGatePreflight('/repo', policyWith('warn'), () => {
      throw new Error('boom');
    });
    assert.equal(exitCalls, 0);
  });
});
