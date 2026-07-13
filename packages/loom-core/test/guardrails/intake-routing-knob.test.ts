/**
 * Tests for the intake_routing policy knob (story-045-001).
 *
 * story-094-003 update: intake_routing and intake_timeout_ms are baked-removed
 * fields. AC1/AC2 tests are converted to stripping tests. YAML tests remain
 * (the YAML file still documents these fields for operator reference).
 * AC4 tests use the INTAKE_TIMEOUT_MS constant directly.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { PolicySchema } from '../../src/types.js';
import { MockLLMClient } from '../../src/llm/MockLLMClient.js';
import { classifyIntake } from '../../src/intake/IntakeClassifier.js';
import { INTAKE_TIMEOUT_MS } from '../../src/orchestrator/constants.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function findPolicySchema(): string {
  return path.resolve(__dirname, '../../../../../schemas/policy.schema.yaml');
}

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

// ── YAML/schema agreement ─────────────────────────────────────────────────────

describe('schemas/policy.schema.yaml ↔ PolicySchema agreement', () => {
  let agentsProps: Record<string, unknown>;

  before(() => {
    const filePath = findPolicySchema();
    const raw = fs.readFileSync(filePath, 'utf8');
    const schemaObj = yaml.load(raw) as Record<string, Record<string, unknown>>;
    agentsProps = (
      (schemaObj.properties?.agents as Record<string, unknown>)
        ?.properties as Record<string, unknown>
    ) ?? {};
  });

  it('YAML defines intake_routing in the agents properties', () => {
    assert.ok(agentsProps.intake_routing, 'intake_routing must appear in agents properties');
  });

  it('YAML intake_routing has exactly three enum values', () => {
    const knob = agentsProps.intake_routing as { enum?: unknown[] };
    assert.ok(Array.isArray(knob.enum), 'intake_routing.enum must be an array');
    assert.equal(knob.enum!.length, 3, 'intake_routing must have exactly three allowed values');
  });

  it('YAML enum values are "off", "advisory", "confirm"', () => {
    const knob = agentsProps.intake_routing as { enum?: unknown[] };
    const sorted = knob.enum!.map(String).sort();
    assert.deepEqual(sorted, ['advisory', 'confirm', 'off']);
  });

  it('YAML default for intake_routing is "off"', () => {
    const knob = agentsProps.intake_routing as { default?: unknown };
    assert.equal(knob.default, 'off');
  });

  it('PolicySchema.safeParse succeeds for all three YAML enum levels (field is stripped, not validated)', () => {
    const LEVELS = ['off', 'advisory', 'confirm'];
    for (const level of LEVELS) {
      const r = PolicySchema.safeParse({ agents: { intake_routing: level } });
      assert.ok(r.success, `PolicySchema must not throw when intake_routing="${level}" (stripped)`);
    }
    const knob = agentsProps.intake_routing as { enum?: unknown[] };
    const yamlValues = (knob.enum ?? []).map(String);
    for (const level of LEVELS) {
      assert.ok(yamlValues.includes(level), `YAML enum must contain "${level}"`);
    }
  });
});

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
