/**
 * Secret Confinement Invariant Tests (FR-5 / ADR-005 / T2)
 *
 * Asserts that Anthropic API credentials and other secrets can never surface in
 * the effective config, regardless of where they are placed:
 *  - env variables (ANTHROPIC_*) are excluded by loadEnvLayer
 *  - committed YAML files with planted secrets are structurally harmless because
 *    PolicySchema has no secret-bearing field and strips unknown keys on parse
 *  - the existing worker_auth secret path (BaseCliWorker.workerEnv) is
 *    unchanged and is the ONLY place secrets flow into worker subprocesses
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvLayer } from '../../src/config/envLayer.js';
import { loadTeamConfigLayer, TEAM_CONFIG_FILENAME } from '../../src/config/teamConfig.js';
import { PolicySchema } from '../../src/types.js';
import { BaseCliWorker } from '../../src/orchestrator/BaseCliWorker.js';
import type { WorkerAssignment } from '../../src/orchestrator/WorkerRunner.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function deepContains(obj: unknown, needle: string): boolean {
  return JSON.stringify(obj).includes(needle);
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-secret-confinement-'));
}

/** Minimal concrete subclass to exercise the protected workerEnv() path. */
class TestableWorker extends BaseCliWorker {
  protected binary() { return 'claude'; }
  protected agentArgs(_: WorkerAssignment) { return [] as string[]; }
  workerEnvPublic() { return this.workerEnv(); }
}

// ── T2-A: loadEnvLayer never maps ANTHROPIC_* ────────────────────────────────

describe('secretConfinement — loadEnvLayer never maps ANTHROPIC_* (T2-A)', () => {
  const SECRET = 'sk-ant-api03-test-secret-value';

  it('ANTHROPIC_API_KEY is absent from the env layer tree', () => {
    const { tree } = loadEnvLayer({ ANTHROPIC_API_KEY: SECRET });
    assert.ok(!deepContains(tree, SECRET), 'secret must not appear anywhere in the tree');
    assert.deepEqual(tree, {});
  });

  it('ANTHROPIC_AUTH_TOKEN is absent from the env layer tree', () => {
    const { tree } = loadEnvLayer({ ANTHROPIC_AUTH_TOKEN: 'Bearer ' + SECRET });
    assert.deepEqual(tree, {});
  });

  it('ANTHROPIC_API_KEY exclusion is silent — no console.warn', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0])); };
    try {
      loadEnvLayer({ ANTHROPIC_API_KEY: SECRET });
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.length, 0, 'ANTHROPIC_* skip must be silent, not a warning');
  });

  it('valid LOOM_* keys still resolve alongside ANTHROPIC_* secrets', () => {
    const { tree } = loadEnvLayer({
      ANTHROPIC_API_KEY: SECRET,
      LOOM_AGENTS_MODEL: 'claude-opus-4-8',
      ANTHROPIC_AUTH_TOKEN: 'tok-secret',
    });
    // Secret absent
    assert.ok(!deepContains(tree, SECRET), 'secret must not appear');
    // Valid key present
    assert.equal(
      (tree as Record<string, Record<string, unknown>>)['agents']?.['model'],
      'claude-opus-4-8',
    );
  });
});

// ── T2-B: PolicySchema structurally excludes secret fields ───────────────────

describe('secretConfinement — PolicySchema structurally has no secret-bearing field (T2-B)', () => {
  it('PolicySchema.parse strips an anthropic_api_key key at the top level', () => {
    const raw = { anthropic_api_key: 'sk-ant-planted-secret' };
    const parsed = PolicySchema.parse(raw);
    const json = JSON.stringify(parsed);
    assert.ok(!json.includes('sk-ant-planted-secret'), 'top-level secret must be stripped');
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'anthropic_api_key'));
  });

  it('PolicySchema.parse strips a nested anthropic_api_key under agents', () => {
    const raw = { agents: { model: 'test', anthropic_api_key: 'sk-ant-nested-secret' } };
    const parsed = PolicySchema.parse(raw);
    const json = JSON.stringify(parsed);
    assert.ok(!json.includes('sk-ant-nested-secret'), 'nested secret must be stripped');
    assert.equal(parsed.agents.model, 'test');
  });

  it('Policy type has no anthropic_api_key field — schema rejects/ignores it', () => {
    const validPolicy = PolicySchema.parse({});
    // TypeScript guarantees the type has no secret field; this runtime check
    // confirms the parsed object also has none.
    assert.ok(!Object.prototype.hasOwnProperty.call(validPolicy, 'anthropic_api_key'));
    assert.ok(!Object.prototype.hasOwnProperty.call(validPolicy, 'ANTHROPIC_API_KEY'));
  });
});

// ── T2-C: committed team-config.yaml with planted secret ─────────────────────

describe('secretConfinement — committed team-config.yaml with planted secret (T2-C)', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('loadTeamConfigLayer raw tree does not include planted ANTHROPIC key at known schema paths', () => {
    // Plant a secret alongside a legitimate key in team-config.yaml
    fs.writeFileSync(
      path.join(tmp, TEAM_CONFIG_FILENAME),
      'agents:\n  model: claude-opus-4-8\nanthropics_key: sk-ant-planted\n',
      'utf8',
    );
    const layer = loadTeamConfigLayer(tmp);
    const tree = layer.tree as Record<string, unknown>;

    // Test sanity: the raw YAML tree DOES contain the planted value at the root-level
    // 'anthropics_key' key — confirms the test is wired up correctly.
    assert.ok(
      deepContains(tree, 'sk-ant-planted'),
      'test setup: planted secret must be present in the raw YAML tree at the root level',
    );

    // The secret is an unknown root key — it must NOT appear nested under any valid
    // schema section (like 'agents') where PolicySchema would include it in output.
    assert.ok(
      !(tree['agents'] as Record<string, unknown>)?.['anthropics_key'],
      'secret must not be nested under the agents section where PolicySchema would include it',
    );

    // Confirm PolicySchema.parse strips the unknown root key and its value.
    const parsed = PolicySchema.parse(tree);
    const parsedJson = JSON.stringify(parsed);
    assert.ok(!parsedJson.includes('sk-ant-planted'), 'PolicySchema.parse must strip the planted secret');
    assert.equal(parsed.agents.model, 'claude-opus-4-8');
  });

  it('planted anthropic_api_key in team-config does not survive PolicySchema.parse', () => {
    fs.writeFileSync(
      path.join(tmp, TEAM_CONFIG_FILENAME),
      'anthropic_api_key: sk-ant-top-level-planted\nagents:\n  model: safe-model\n',
      'utf8',
    );
    const layer = loadTeamConfigLayer(tmp);
    const parsed = PolicySchema.parse(layer.tree);
    const json = JSON.stringify(parsed);
    assert.ok(!json.includes('sk-ant-top-level-planted'), 'planted top-level secret must be stripped');
    assert.equal(parsed.agents.model, 'safe-model');
  });
});

// ── T2-D: worker_auth / workerEnv() consistency ───────────────────────────────

describe('secretConfinement — worker_auth precedent: secrets flow only via workerEnv() (T2-D)', () => {
  // These tests verify the behavioral invariant that secrets remain confined to
  // BaseCliWorker.workerEnv() — the sole place where ANTHROPIC_* keys flow into
  // worker subprocesses. Story-055-003 does NOT modify BaseCliWorker.ts; this
  // test confirms the existing pattern is intact via a test subclass.

  it('session-mode workerEnv() strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-behavioral-test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-behavioral-test';
    try {
      const worker = new TestableWorker({ workerAuth: 'session' });
      const env = worker.workerEnvPublic();
      assert.ok(
        !Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY'),
        'session mode must strip ANTHROPIC_API_KEY from the subprocess env',
      );
      assert.ok(
        !Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_AUTH_TOKEN'),
        'session mode must strip ANTHROPIC_AUTH_TOKEN from the subprocess env',
      );
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    }
  });

  it('inherit-mode workerEnv() (default) keeps ANTHROPIC_API_KEY intact', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-inherit-test';
    try {
      const worker = new TestableWorker({ workerAuth: 'inherit' });
      const env = worker.workerEnvPublic();
      assert.equal(
        env.ANTHROPIC_API_KEY,
        'sk-ant-inherit-test',
        'inherit mode must pass ANTHROPIC_API_KEY through unchanged',
      );
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it('loadEnvLayer is NOT the path through which secrets reach workers', () => {
    // Verify that the env layer — even with secrets present — produces a tree
    // with no secret values. Secrets bypass this layer entirely and go direct
    // from process.env → BaseCliWorker.workerEnv() → subprocess env.
    const { tree } = loadEnvLayer({
      ANTHROPIC_API_KEY: 'sk-ant-should-bypass',
      LOOM_AGENTS_WORKER_AUTH: 'session',
    });

    assert.ok(!deepContains(tree, 'sk-ant-should-bypass'), 'secret must not be in env layer');
    // The worker_auth setting IS mappable (it configures behavior, not a secret)
    assert.equal(
      (tree as Record<string, Record<string, unknown>>)['agents']?.['worker_auth'],
      'session',
    );
  });
});
