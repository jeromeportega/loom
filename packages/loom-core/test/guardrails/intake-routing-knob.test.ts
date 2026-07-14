/**
 * Tests for the intake_routing policy knob (story-045-001).
 *
 * story-094-003 update: intake_routing and intake_timeout_ms are baked-removed
 * fields. AC1/AC2 tests are converted to stripping tests. The former YAML ↔
 * schema agreement block was deleted (the knob no longer appears in
 * policy.schema.yaml). AC4 tests use the INTAKE_TIMEOUT_MS constant directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicySchema } from '../../src/types.js';
import { MockLLMClient } from '../../src/llm/MockLLMClient.js';
import { classifyIntake } from '../../src/intake/IntakeClassifier.js';
import { INTAKE_TIMEOUT_MS } from '../../src/orchestrator/constants.js';

// ── AC1: intake_routing silently stripped (story-094-003) ─────────────────────

describe('PolicySchema — agents.intake_routing silently stripped (story-094-003)', () => {
  it('intake_routing is absent from the parsed result (baked field removed)', () => {
    const policy = PolicySchema.parse({});
    assert.ok(!('intake_routing' in policy.agents), 'intake_routing must be stripped');
  });

  it('passing intake_routing: "off" does not cause a parse error', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { intake_routing: 'off' } }));
  });

  it('passing intake_routing: "advisory" does not cause a parse error', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { intake_routing: 'advisory' } }));
  });

  it('passing intake_routing: "confirm" does not cause a parse error', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { intake_routing: 'confirm' } }));
  });

  it('intake_timeout_ms is also absent from the parsed result (baked field removed)', () => {
    const policy = PolicySchema.parse({});
    assert.ok(!('intake_timeout_ms' in policy.agents), 'intake_timeout_ms must be stripped');
  });

  it('passing both removed fields does not cause a parse error', () => {
    assert.doesNotThrow(() =>
      PolicySchema.parse({ agents: { intake_routing: 'advisory', intake_timeout_ms: 90_000 } })
    );
  });
});

// ── AC2: invalid values are silently stripped (not validated) ─────────────────

describe('PolicySchema — agents.intake_routing invalid values stripped (story-094-003)', () => {
  it('passing intake_routing: "auto" does not cause a parse error (stripped, not validated)', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { intake_routing: 'auto' } }));
  });

  it('passing intake_routing: "" does not cause a parse error (stripped, not validated)', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { intake_routing: '' } }));
  });

  it('passing intake_routing: true does not cause a parse error (stripped, not validated)', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { intake_routing: true } }));
  });

  it('passing intake_routing: null does not cause a parse error (stripped, not validated)', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { intake_routing: null } }));
  });
});

// intake_routing is a baked-removed knob (knob-hardening): it no longer appears
// in schemas/policy.schema.yaml or PolicySchema, so the former "YAML ↔ schema
// agreement" block for it was deleted. Strip behavior is covered above.

// ── AC4 / NFR-4: observe-only classifier path unchanged ──────────────────────

describe('AC4/NFR-4 — observe-only classifier runs independently of intake_routing', () => {
  const BRIEF = 'Add email notifications for deployment events.';
  const VERDICT_JSON =
    '{"type":"feature","size":"story","confidence":"high","rationale":"New notification capability."}';

  it('policy parses when intake_routing is set (field stripped)', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: { intake_routing: 'off' } }));
  });

  it('classifyIntake returns a verdict — observe-only path unchanged', async () => {
    const llm = new MockLLMClient([VERDICT_JSON]);
    const result = await classifyIntake(BRIEF, { llm, model: 'test-model', timeoutMs: 5_000 });
    assert.ok(result.ok, 'classifyIntake must return ok:true');
    assert.equal(result.verdict.type, 'feature');
    assert.equal(result.verdict.size, 'story');
    assert.equal(result.verdict.confidence, 'high');
  });

  it('classifyIntake runs for advisory and confirm levels — the knob is not wired to the classifier', async () => {
    for (const _level of ['advisory', 'confirm']) {
      const llm = new MockLLMClient([VERDICT_JSON]);
      const result = await classifyIntake(BRIEF, {
        llm,
        model: 'test-model',
        timeoutMs: INTAKE_TIMEOUT_MS,
      });
      assert.ok(result.ok, `classifyIntake must succeed (timeoutMs from INTAKE_TIMEOUT_MS constant)`);
    }
  });
});
