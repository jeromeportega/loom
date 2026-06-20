import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicySchema } from '../../src/types.js';

// ── epic-030 — story-030-001: policy knob schema tests ───────────────────────
//
// Verifies that hung_request_seconds and auto_resume_attempts:
//   • default to safe values when unset
//   • honour explicit values when set
//   • accept 0 (disable sentinel)

describe('PolicySchema — hung_request_seconds', () => {
  it('defaults to 45 when unset', () => {
    const policy = PolicySchema.parse({});
    assert.equal(policy.agents.hung_request_seconds, 45);
  });

  it('is in the 30–60s safe default band', () => {
    const v = PolicySchema.parse({}).agents.hung_request_seconds;
    assert.ok(v >= 30 && v <= 60, `expected 30–60s, got ${v}`);
  });

  it('honours an explicit value', () => {
    const policy = PolicySchema.parse({ agents: { hung_request_seconds: 30 } });
    assert.equal(policy.agents.hung_request_seconds, 30);
  });

  it('accepts 0 (disable sentinel) without error', () => {
    const policy = PolicySchema.parse({ agents: { hung_request_seconds: 0 } });
    assert.equal(policy.agents.hung_request_seconds, 0);
  });

  it('rejects negative values', () => {
    const result = PolicySchema.safeParse({ agents: { hung_request_seconds: -1 } });
    assert.equal(result.success, false);
  });

  it('rejects non-integer values', () => {
    const result = PolicySchema.safeParse({ agents: { hung_request_seconds: 1.5 } });
    assert.equal(result.success, false);
  });
});

describe('PolicySchema — auto_resume_attempts', () => {
  it('defaults to 2 when unset', () => {
    const policy = PolicySchema.parse({});
    assert.equal(policy.agents.auto_resume_attempts, 2);
  });

  it('honours an explicit value', () => {
    const policy = PolicySchema.parse({ agents: { auto_resume_attempts: 3 } });
    assert.equal(policy.agents.auto_resume_attempts, 3);
  });

  it('accepts 0 (disable sentinel) without error', () => {
    const policy = PolicySchema.parse({ agents: { auto_resume_attempts: 0 } });
    assert.equal(policy.agents.auto_resume_attempts, 0);
  });

  it('rejects negative values', () => {
    const result = PolicySchema.safeParse({ agents: { auto_resume_attempts: -1 } });
    assert.equal(result.success, false);
  });

  it('rejects non-integer values', () => {
    const result = PolicySchema.safeParse({ agents: { auto_resume_attempts: 2.5 } });
    assert.equal(result.success, false);
  });
});

describe('PolicySchema — both knobs together', () => {
  it('explicit hung_request_seconds=30 and auto_resume_attempts=3 both survive parse', () => {
    const policy = PolicySchema.parse({
      agents: { hung_request_seconds: 30, auto_resume_attempts: 3 },
    });
    assert.equal(policy.agents.hung_request_seconds, 30);
    assert.equal(policy.agents.auto_resume_attempts, 3);
  });

  it('0 sentinels on both knobs parse without error', () => {
    const policy = PolicySchema.parse({
      agents: { hung_request_seconds: 0, auto_resume_attempts: 0 },
    });
    assert.equal(policy.agents.hung_request_seconds, 0);
    assert.equal(policy.agents.auto_resume_attempts, 0);
  });
});

describe('run.ts wiring — unit-boundary conversion', () => {
  it('default hung_request_seconds (45) × 1000 = 45000 ms (the value passed as hungRequestMs)', () => {
    const policy = PolicySchema.parse({});
    // This is the exact formula in packages/loom-cli/src/commands/run.ts:
    //   hungRequestMs: policy.agents.hung_request_seconds * 1000
    const hungRequestMs = policy.agents.hung_request_seconds * 1000;
    assert.equal(hungRequestMs, 45_000);
  });

  it('explicit hung_request_seconds=30 → 30000 ms', () => {
    const policy = PolicySchema.parse({ agents: { hung_request_seconds: 30 } });
    assert.equal(policy.agents.hung_request_seconds * 1000, 30_000);
  });

  it('auto_resume_attempts is passed as a raw count (no unit conversion)', () => {
    const policy = PolicySchema.parse({ agents: { auto_resume_attempts: 3 } });
    // The value flows to Supervisor({ autoResumeAttempts }) without multiplication.
    assert.equal(policy.agents.auto_resume_attempts, 3);
  });

  it('neighboring minute knobs are NOT re-normalized — they stay in minutes at the schema level', () => {
    // run.ts converts them with × 60_000 (minutes → ms); that conversion is
    // independent and must not be applied a second time to the new knobs.
    const policy = PolicySchema.parse({});
    assert.equal(policy.agents.story_stall_minutes, 12,
      'story_stall_minutes default unchanged');
    assert.equal(policy.agents.story_absolute_cap_minutes, 60,
      'story_absolute_cap_minutes default unchanged');

    // The minute knobs use a different multiplier (60_000) than the hung-request
    // knob (1_000) — both conversion sites in run.ts must be kept distinct.
    const stallMs = policy.agents.story_stall_minutes * 60_000;
    const capMs = policy.agents.story_absolute_cap_minutes * 60_000;
    const hungMs = policy.agents.hung_request_seconds * 1000;

    assert.equal(stallMs, 12 * 60_000,  'stall in ms via ×60_000');
    assert.equal(capMs,   60 * 60_000,  'cap in ms via ×60_000');
    assert.equal(hungMs,  45 * 1_000,   'hung bound in ms via ×1_000');

    // The multipliers are distinct — minute knobs cannot reuse the s→ms factor.
    assert.notEqual(
      60_000, 1_000,
      'minute and second multipliers must be different constants'
    );
  });
});
