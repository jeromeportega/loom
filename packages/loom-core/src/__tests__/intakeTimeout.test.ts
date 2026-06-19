import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_TIMEOUT_DEFAULT_MS,
  INTAKE_TIMEOUT_FLOOR_MS,
  resolveIntakeTimeoutMs,
} from '../intake/intakeTimeout.js';
import { PolicySchema, type Policy } from '../types.js';

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
  it('returns FLOOR when policy sets a value equal to the floor', () => {
    const policy = PolicySchema.parse({ agents: { intake_classify_timeout_ms: INTAKE_TIMEOUT_FLOOR_MS } });
    assert.equal(resolveIntakeTimeoutMs(policy), INTAKE_TIMEOUT_FLOOR_MS);
  });

  it('clamps to FLOOR for below-floor values (runtime safety net bypassing schema)', () => {
    // Schema rejects values below INTAKE_TIMEOUT_FLOOR_MS; this verifies the
    // Math.max safety net for any path that constructs a Policy without Zod.
    const raw = { agents: { intake_classify_timeout_ms: 30_000 } } as unknown as Policy;
    assert.equal(resolveIntakeTimeoutMs(raw), INTAKE_TIMEOUT_FLOOR_MS);
  });
});

// ── PolicySchema validation of intake_classify_timeout_ms ─────────────────────

describe('PolicySchema — intake_classify_timeout_ms validation', () => {
  it('accepts a value at the floor (120_000)', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 120_000 } });
    assert.ok(r.success);
    assert.equal(r.data?.agents.intake_classify_timeout_ms, 120_000);
  });

  it('accepts the default value (180_000)', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 180_000 } });
    assert.ok(r.success);
    assert.equal(r.data?.agents.intake_classify_timeout_ms, 180_000);
  });

  it('accepts the maximum value (600_000)', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 600_000 } });
    assert.ok(r.success);
    assert.equal(r.data?.agents.intake_classify_timeout_ms, 600_000);
  });

  it('accepts undefined (field is optional)', () => {
    const r = PolicySchema.safeParse({ agents: {} });
    assert.ok(r.success);
    assert.equal(r.data?.agents.intake_classify_timeout_ms, undefined);
  });

  it('rejects a value below the floor (119_999)', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 119_999 } });
    assert.ok(!r.success, 'Values below 120_000 should be rejected');
  });

  it('rejects a value above the maximum (600_001)', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 600_001 } });
    assert.ok(!r.success, 'Values above 600_000 should be rejected');
  });

  it('rejects a float value', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: 180_000.5 } });
    assert.ok(!r.success, 'Non-integer should be rejected by .int()');
  });

  it('rejects a string value', () => {
    const r = PolicySchema.safeParse({ agents: { intake_classify_timeout_ms: '180000' } });
    assert.ok(!r.success, 'String value should be rejected');
  });
});
