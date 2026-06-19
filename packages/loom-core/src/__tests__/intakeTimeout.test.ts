import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_TIMEOUT_DEFAULT_MS,
  INTAKE_TIMEOUT_FLOOR_MS,
  resolveIntakeTimeoutMs,
} from '../intake/intakeTimeout.js';
import { PolicySchema } from '../types.js';

// ── constant values ────────────────────────────────────────────────────────────

describe('timeout constants', () => {
  it('INTAKE_TIMEOUT_DEFAULT_MS is 180_000', () => {
    assert.equal(INTAKE_TIMEOUT_DEFAULT_MS, 180_000);
  });

  it('INTAKE_TIMEOUT_FLOOR_MS is 120_000', () => {
    assert.equal(INTAKE_TIMEOUT_FLOOR_MS, 120_000);
  });

  it('default is strictly greater than floor', () => {
    assert.ok(
      INTAKE_TIMEOUT_DEFAULT_MS > INTAKE_TIMEOUT_FLOOR_MS,
      'default must exceed floor so no-config path is sane',
    );
  });

  it('floor is above the ~100s backend latency (> 100_000)', () => {
    assert.ok(INTAKE_TIMEOUT_FLOOR_MS > 100_000);
  });
});

// ── resolveIntakeTimeoutMs ─────────────────────────────────────────────────────

const defaultPolicy = PolicySchema.parse({});

describe('resolveIntakeTimeoutMs — no policy override', () => {
  it('returns DEFAULT when policy omits intake_classify_timeout_ms', () => {
    const result = resolveIntakeTimeoutMs(defaultPolicy);
    assert.equal(result, INTAKE_TIMEOUT_DEFAULT_MS);
  });
});

describe('resolveIntakeTimeoutMs — policy above default', () => {
  it('uses the configured value when it exceeds both floor and default', () => {
    const policy = PolicySchema.parse({ agents: { intake_classify_timeout_ms: 300_000 } });
    assert.equal(resolveIntakeTimeoutMs(policy), 300_000);
  });

  it('uses the configured value when it is between floor and default', () => {
    const policy = PolicySchema.parse({ agents: { intake_classify_timeout_ms: 150_000 } });
    assert.equal(resolveIntakeTimeoutMs(policy), 150_000);
  });
});

describe('resolveIntakeTimeoutMs — FR-5: floor is the hard lower bound', () => {
  it('returns FLOOR when policy sets a value below the floor', () => {
    const policy = PolicySchema.parse({ agents: { intake_classify_timeout_ms: 30_000 } });
    assert.equal(resolveIntakeTimeoutMs(policy), INTAKE_TIMEOUT_FLOOR_MS);
  });

  it('returns FLOOR when policy sets exactly the minimum schema value (1000 ms)', () => {
    const policy = PolicySchema.parse({ agents: { intake_classify_timeout_ms: 1_000 } });
    assert.equal(resolveIntakeTimeoutMs(policy), INTAKE_TIMEOUT_FLOOR_MS);
  });

  it('returns FLOOR when policy sets a value equal to the floor', () => {
    const policy = PolicySchema.parse({ agents: { intake_classify_timeout_ms: INTAKE_TIMEOUT_FLOOR_MS } });
    assert.equal(resolveIntakeTimeoutMs(policy), INTAKE_TIMEOUT_FLOOR_MS);
  });
});

// ── PolicySchema validation of intake_classify_timeout_ms ─────────────────────

describe('PolicySchema — intake_classify_timeout_ms validation', () => {
  it('accepts a valid integer value', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 60_000 } });
    assert.ok(r.success);
    assert.equal(r.data.agents.intake_classify_timeout_ms, 60_000);
  });

  it('accepts undefined (field is optional)', () => {
    const r = PolicySchema.safeParse({ agents: {} });
    assert.ok(r.success);
    assert.equal(r.data.agents.intake_classify_timeout_ms, undefined);
  });

  it('rejects a value below 1000', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 999 } });
    assert.ok(!r.success, 'Values below 1000 should be rejected');
  });

  it('rejects a float value', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 5000.5 } });
    assert.ok(!r.success, 'Non-integer should be rejected by .int()');
  });

  it('rejects a string value', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: '60000' } });
    assert.ok(!r.success, 'String value should be rejected');
  });
});
