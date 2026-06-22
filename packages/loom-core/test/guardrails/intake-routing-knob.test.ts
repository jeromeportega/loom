/**
 * Tests for the intake_routing policy knob (story-045-001).
 *
 * Covers:
 *   AC1  — schema default to 'off' and valid level acceptance
 *   AC2  — rejection of out-of-range values via zod enum
 *   YAML — schemas/policy.schema.yaml and PolicySchema agree on three levels + default
 *   AC4/NFR-4 — observe-only classifier path unchanged by the knob
 *
 * NFR-1 (PM message byte-equivalence) lives in src/__tests__/intake-routing-pm.test.ts
 * because PMAgent → PersonaLoader resolves personas/ from dist/planner/ (the main
 * compile output), not from dist-test/src/planner/ (the test compile output).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { PolicySchema } from '../../src/types.js';
import { MockLLMClient } from '../../src/llm/MockLLMClient.js';
import { classifyIntake } from '../../src/intake/IntakeClassifier.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Deterministic path to schemas/policy.schema.yaml from the compiled location
 * dist-test/test/guardrails/ (5 levels up to the repo root).
 * Avoids the directory-walk approach that could resolve the wrong file in a
 * monorepo when the schema exists at multiple levels.
 */
function findPolicySchema(): string {
  return path.resolve(__dirname, '../../../../../schemas/policy.schema.yaml');
}

// ── AC1: schema default and valid levels ─────────────────────────────────────

describe('PolicySchema — agents.intake_routing (AC1)', () => {
  it('defaults to "off" when intake_routing is omitted', () => {
    const policy = PolicySchema.parse({});
    assert.equal(policy.agents.intake_routing, 'off');
  });

  it('defaults to "off" when agents block is omitted', () => {
    const policy = PolicySchema.parse({ agents: {} });
    assert.equal(policy.agents.intake_routing, 'off');
  });

  it('accepts explicit value "off"', () => {
    const policy = PolicySchema.parse({ agents: { intake_routing: 'off' } });
    assert.equal(policy.agents.intake_routing, 'off');
  });

  it('accepts "advisory"', () => {
    const policy = PolicySchema.parse({ agents: { intake_routing: 'advisory' } });
    assert.equal(policy.agents.intake_routing, 'advisory');
  });

  it('accepts "confirm"', () => {
    const policy = PolicySchema.parse({ agents: { intake_routing: 'confirm' } });
    assert.equal(policy.agents.intake_routing, 'confirm');
  });

  it('intake_routing coexists with intake_timeout_ms without conflict', () => {
    const policy = PolicySchema.parse({
      agents: { intake_routing: 'advisory', intake_timeout_ms: 90_000 },
    });
    assert.equal(policy.agents.intake_routing, 'advisory');
    assert.equal(policy.agents.intake_timeout_ms, 90_000);
  });
});

// ── AC2: out-of-range values rejected ────────────────────────────────────────

describe('PolicySchema — agents.intake_routing rejection (AC2)', () => {
  it('rejects "auto" (not in the allowed enum)', () => {
    const result = PolicySchema.safeParse({ agents: { intake_routing: 'auto' } });
    assert.equal(result.success, false);
  });

  it('rejects an empty string', () => {
    const result = PolicySchema.safeParse({ agents: { intake_routing: '' } });
    assert.equal(result.success, false);
  });

  it('rejects boolean true', () => {
    const result = PolicySchema.safeParse({ agents: { intake_routing: true } });
    assert.equal(result.success, false);
  });

  it('rejects null', () => {
    const result = PolicySchema.safeParse({ agents: { intake_routing: null } });
    assert.equal(result.success, false);
  });

  it('enum rejects out-of-range via zod alone — no custom validation', () => {
    const result = PolicySchema.safeParse({ agents: { intake_routing: 'auto' } });
    assert.ok(!result.success);
    const issue = result.error.issues[0];
    assert.ok(
      issue.code === 'invalid_enum_value' || issue.code === 'invalid_type',
      `Expected zod enum/type error, got: ${issue.code}`
    );
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

  it('PolicySchema accepts exactly the three levels in the YAML enum', () => {
    const LEVELS = ['off', 'advisory', 'confirm'];
    for (const level of LEVELS) {
      const r = PolicySchema.safeParse({ agents: { intake_routing: level } });
      assert.ok(r.success, `PolicySchema must accept "${level}"`);
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

  it('policy with intake_routing "off" parses; intake_timeout_ms is still available', () => {
    const policy = PolicySchema.parse({ agents: { intake_routing: 'off' } });
    assert.equal(policy.agents.intake_routing, 'off');
    assert.ok(policy.agents.intake_timeout_ms > 0);
  });

  it('classifyIntake returns a verdict with no intake_routing parameter — observe-only path unchanged', async () => {
    const llm = new MockLLMClient([VERDICT_JSON]);
    const result = await classifyIntake(BRIEF, { llm, model: 'test-model', timeoutMs: 5_000 });
    assert.ok(result.ok, 'classifyIntake must return ok:true');
    assert.equal(result.verdict.type, 'feature');
    assert.equal(result.verdict.size, 'story');
    assert.equal(result.verdict.confidence, 'high');
  });

  it('classifyIntake runs for advisory and confirm levels — the knob is not wired to the classifier', async () => {
    for (const level of ['advisory', 'confirm'] as const) {
      const policy = PolicySchema.parse({ agents: { intake_routing: level } });
      const llm = new MockLLMClient([VERDICT_JSON]);
      const result = await classifyIntake(BRIEF, {
        llm,
        model: 'test-model',
        timeoutMs: policy.agents.intake_timeout_ms,
      });
      assert.ok(result.ok, `classifyIntake must succeed when policy.intake_routing="${level}"`);
    }
  });
});
