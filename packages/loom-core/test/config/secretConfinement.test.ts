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

// ── Helpers ───────────────────────────────────────────────────────────────────

function deepContains(obj: unknown, needle: string): boolean {
  return JSON.stringify(obj).includes(needle);
}

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-secret-confinement-'));
}

/** Walk up from startDir until a directory containing package.json is found. */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${startDir}`);
    dir = parent;
  }
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

    // The raw YAML tree may contain 'anthropics_key' — that's OK here because
    // it is an unknown key and will be stripped by PolicySchema.parse at resolve time.
    // Crucially, the secret value NEVER appears at a known schema path:
    assert.ok(
      !(tree['agents'] as Record<string, unknown>)?.['anthropics_key'],
      'secret must not be nested under a valid schema section',
    );

    // Confirm PolicySchema.parse over the raw tree strips the planted key.
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
  // This test verifies the structural invariant that secrets remain confined to
  // BaseCliWorker.workerEnv() — the sole place where ANTHROPIC_* keys flow into
  // worker subprocesses. Story-055-003 does NOT modify BaseCliWorker.ts; this
  // test confirms the existing pattern is intact.

  it('BaseCliWorker.ts still reads process.env directly in workerEnv()', () => {
    // Walk up from __dirname to find the package root regardless of outDir.
    const pkgRoot = findPackageRoot(__dirname);
    const srcPath = path.join(pkgRoot, 'src', 'orchestrator', 'BaseCliWorker.ts');
    const src = fs.readFileSync(srcPath, 'utf8');

    // The method must exist and read process.env
    assert.ok(
      src.includes('protected workerEnv()'),
      'workerEnv() method must still exist in BaseCliWorker',
    );
    assert.ok(
      src.includes('process.env'),
      'workerEnv() must still read process.env directly',
    );

    // The 'session' mode must still strip ANTHROPIC keys from the subprocess env
    assert.ok(
      src.includes('delete env.ANTHROPIC_API_KEY'),
      'session mode must still delete ANTHROPIC_API_KEY from the worker env',
    );
    assert.ok(
      src.includes('delete env.ANTHROPIC_AUTH_TOKEN'),
      'session mode must still delete ANTHROPIC_AUTH_TOKEN from the worker env',
    );
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
