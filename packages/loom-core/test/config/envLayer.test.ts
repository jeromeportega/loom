import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvLayer } from '../../src/config/envLayer.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function get(tree: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let cur: unknown = tree;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function hasKey(tree: unknown, dotPath: string): boolean {
  const parts = dotPath.split('.');
  let cur: unknown = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur !== 'object' || cur === null) return false;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (typeof cur !== 'object' || cur === null) return false;
  return Object.prototype.hasOwnProperty.call(cur, parts[parts.length - 1]);
}

function captureWarns(fn: () => void): string[] {
  const msgs: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { msgs.push(String(args[0])); };
  try { fn(); } finally { console.warn = orig; }
  return msgs;
}

// ── Basic structure ───────────────────────────────────────────────────────────

describe('loadEnvLayer — return shape', () => {
  it('returns { name: "env", tree } always', () => {
    const layer = loadEnvLayer({});
    assert.equal(layer.name, 'env');
    assert.ok(typeof layer.tree === 'object' && layer.tree !== null);
  });

  it('returns an empty tree when env has no LOOM_* keys', () => {
    const layer = loadEnvLayer({ PATH: '/usr/bin', HOME: '/home/u' });
    assert.deepEqual(layer.tree, {});
  });

  it('is sparse — only explicitly set keys appear (ADR-007)', () => {
    const layer = loadEnvLayer({ LOOM_AGENTS_MODEL: 'claude-opus-4-8' });
    const tree = layer.tree as Record<string, unknown>;
    // Only 'agents' should be in the tree — not 'git', 'filesystem', etc.
    assert.deepEqual(Object.keys(tree), ['agents']);
    const agents = tree.agents as Record<string, unknown>;
    assert.deepEqual(Object.keys(agents), ['model']);
  });
});

// ── Happy-path mapping ────────────────────────────────────────────────────────

describe('loadEnvLayer — mapping happy path', () => {
  it('LOOM_AGENTS_MODEL → agents.model', () => {
    const { tree } = loadEnvLayer({ LOOM_AGENTS_MODEL: 'claude-opus-4-8' });
    assert.equal(get(tree, 'agents.model'), 'claude-opus-4-8');
  });

  it('LOOM_GIT_PROTECTED_BRANCHES (list) → git.protected_branches', () => {
    const { tree } = loadEnvLayer({ LOOM_GIT_PROTECTED_BRANCHES: 'main,production' });
    assert.deepEqual(get(tree, 'git.protected_branches'), ['main', 'production']);
  });

  it('LOOM_AGENTS_MAX_CONCURRENT (number) → agents.max_concurrent', () => {
    const { tree } = loadEnvLayer({ LOOM_AGENTS_MAX_CONCURRENT: '3' });
    assert.equal(get(tree, 'agents.max_concurrent'), 3);
    assert.equal(typeof get(tree, 'agents.max_concurrent'), 'number');
  });

  it('LOOM_CROSS_REPO_ENABLED (boolean) → cross_repo.enabled', () => {
    const { tree } = loadEnvLayer({ LOOM_CROSS_REPO_ENABLED: 'false' });
    assert.equal(get(tree, 'cross_repo.enabled'), false);
    assert.equal(typeof get(tree, 'cross_repo.enabled'), 'boolean');
  });

  it('LOOM_MCP_REGISTRY → mcp.registry', () => {
    const { tree } = loadEnvLayer({ LOOM_MCP_REGISTRY: '/srv/mcp/registry' });
    assert.equal(get(tree, 'mcp.registry'), '/srv/mcp/registry');
  });

  it('multiple LOOM_* keys each produce their own sparse leaf', () => {
    const { tree } = loadEnvLayer({
      LOOM_AGENTS_MODEL: 'claude-opus-4-8',
      LOOM_AGENTS_MAX_CONCURRENT: '2',
      LOOM_GIT_PROTECTED_BRANCHES: 'main',
    });
    assert.equal(get(tree, 'agents.model'), 'claude-opus-4-8');
    assert.equal(get(tree, 'agents.max_concurrent'), 2);
    assert.deepEqual(get(tree, 'git.protected_branches'), ['main']);
  });
});

// ── Coercion ──────────────────────────────────────────────────────────────────

describe('loadEnvLayer — coercion against target zod field', () => {
  it('boolean field: "true" → true', () => {
    const { tree } = loadEnvLayer({ LOOM_CROSS_REPO_ENABLED: 'true' });
    assert.strictEqual(get(tree, 'cross_repo.enabled'), true);
  });

  it('boolean field: "false" → false', () => {
    const { tree } = loadEnvLayer({ LOOM_CROSS_REPO_ENABLED: 'false' });
    assert.strictEqual(get(tree, 'cross_repo.enabled'), false);
  });

  it('boolean field: bad value → ignored with warning, key absent', () => {
    let warned = false;
    const orig = console.warn;
    console.warn = () => { warned = true; };
    try {
      const { tree } = loadEnvLayer({ LOOM_CROSS_REPO_ENABLED: 'yes' });
      assert.ok(!hasKey(tree, 'cross_repo.enabled'), 'bad boolean must be absent');
    } finally { console.warn = orig; }
    assert.ok(warned, 'must emit a warning for bad boolean');
  });

  it('number field: "3" → 3', () => {
    const { tree } = loadEnvLayer({ LOOM_AGENTS_MAX_CONCURRENT: '3' });
    assert.equal(get(tree, 'agents.max_concurrent'), 3);
    assert.equal(typeof get(tree, 'agents.max_concurrent'), 'number');
  });

  it('number field: "1.5" → 1.5 (float, using a non-int field)', () => {
    // budget_tokens_per_story is z.number().optional() — accepts floats.
    const { tree } = loadEnvLayer({ LOOM_AGENTS_BUDGET_TOKENS_PER_STORY: '1.5' });
    assert.equal(get(tree, 'agents.budget_tokens_per_story'), 1.5);
  });

  it('number field: non-numeric → ignored with warning, key absent', () => {
    let warned = false;
    const orig = console.warn;
    console.warn = () => { warned = true; };
    try {
      const { tree } = loadEnvLayer({ LOOM_AGENTS_MAX_CONCURRENT: 'many' });
      assert.ok(!hasKey(tree, 'agents.max_concurrent'), 'non-numeric must be absent');
    } finally { console.warn = orig; }
    assert.ok(warned, 'must emit a warning for non-numeric number field');
  });

  it('list field: comma-split → string[]', () => {
    const { tree } = loadEnvLayer({ LOOM_GIT_PROTECTED_BRANCHES: 'main,release,hotfix' });
    assert.deepEqual(get(tree, 'git.protected_branches'), ['main', 'release', 'hotfix']);
  });

  it('list field: JSON array → string[]', () => {
    const { tree } = loadEnvLayer({ LOOM_GIT_PROTECTED_BRANCHES: '["main","release"]' });
    assert.deepEqual(get(tree, 'git.protected_branches'), ['main', 'release']);
  });

  it('list field: single value without commas → single-element array', () => {
    const { tree } = loadEnvLayer({ LOOM_GIT_PROTECTED_BRANCHES: 'main' });
    assert.deepEqual(get(tree, 'git.protected_branches'), ['main']);
  });

  it('string field: returned as-is', () => {
    const { tree } = loadEnvLayer({ LOOM_AGENTS_MODEL: 'my-custom-model' });
    assert.equal(get(tree, 'agents.model'), 'my-custom-model');
  });

  it('enum field: returned as-is (validation deferred to PolicySchema.parse)', () => {
    const { tree } = loadEnvLayer({ LOOM_AGENTS_REVIEW_STRATEGY: 'comment' });
    assert.equal(get(tree, 'agents.review_strategy'), 'comment');
  });
});

// ── ADR-008: ambiguous underscore names ──────────────────────────────────────

describe('loadEnvLayer — ambiguous underscore names (ADR-008)', () => {
  it('LOOM_FILESYSTEM_ALLOWED_WRITE_ROOT → filesystem.allowed_write_root (not a greedy split)', () => {
    const { tree } = loadEnvLayer({ LOOM_FILESYSTEM_ALLOWED_WRITE_ROOT: '/workspace' });
    // Must map to filesystem.allowed_write_root, not some incorrect greedy split.
    assert.equal(get(tree, 'filesystem.allowed_write_root'), '/workspace');
    // Verify no sibling keys invented from the greedy split
    assert.ok(!hasKey(tree, 'filesystem.allowed'), 'must not produce filesystem.allowed');
  });

  it('LOOM_GIT_AGENTS_MUST_USE_PR → git.agents_must_use_pr', () => {
    const { tree } = loadEnvLayer({ LOOM_GIT_AGENTS_MUST_USE_PR: 'false' });
    assert.strictEqual(get(tree, 'git.agents_must_use_pr'), false);
  });

  it('LOOM_AGENTS_ALLOWED_WRITE_ROOT is unmappable (no agents.allowed_write_root field)', () => {
    const warns = captureWarns(() => {
      const { tree } = loadEnvLayer({ LOOM_AGENTS_ALLOWED_WRITE_ROOT: '/bad' });
      assert.ok(!hasKey(tree, 'agents.allowed_write_root'), 'must not appear in tree');
      assert.deepEqual(tree, {}, 'tree must be empty');
    });
    assert.ok(warns.length > 0, 'must emit a warning for unmappable key');
  });

  it('LOOM_GIT_FORBIDDEN_FLAGS resolves to git.forbidden_flags', () => {
    const { tree } = loadEnvLayer({ LOOM_GIT_FORBIDDEN_FLAGS: '--force,--hard' });
    assert.deepEqual(get(tree, 'git.forbidden_flags'), ['--force', '--hard']);
  });
});

// ── Unmappable keys ───────────────────────────────────────────────────────────

describe('loadEnvLayer — unmappable keys', () => {
  it('does NOT throw for an unknown LOOM_* key', () => {
    assert.doesNotThrow(() => {
      loadEnvLayer({ LOOM_NOPE_NOPE: 'value' });
    });
  });

  it('emits a console.warn for LOOM_NOPE_NOPE', () => {
    const warns = captureWarns(() => loadEnvLayer({ LOOM_NOPE_NOPE: 'value' }));
    assert.ok(warns.length > 0, 'expected at least one warning');
    assert.ok(warns.some(w => w.includes('LOOM_NOPE_NOPE')), 'warning must name the key');
  });

  it('unmappable key does NOT appear in the returned tree', () => {
    let tree: unknown;
    captureWarns(() => { ({ tree } = loadEnvLayer({ LOOM_NOPE_NOPE: 'value' })); });
    assert.deepEqual(tree, {});
  });

  it('valid keys are still mapped even alongside an unmappable key', () => {
    let tree: unknown;
    captureWarns(() => {
      ({ tree } = loadEnvLayer({ LOOM_NOPE_NOPE: 'bad', LOOM_AGENTS_MODEL: 'ok' }));
    });
    assert.equal(get(tree, 'agents.model'), 'ok');
    assert.ok(!hasKey(tree, 'nope'), 'unmappable must not appear');
  });
});

// ── Secret exclusion (FR-5 / ADR-005) ────────────────────────────────────────

describe('loadEnvLayer — ANTHROPIC_* secrets are never mapped', () => {
  it('ANTHROPIC_API_KEY is not present in the returned tree', () => {
    const { tree } = loadEnvLayer({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      LOOM_AGENTS_MODEL: 'claude-opus-4-8',
    });
    // Deep-search the tree for the secret value
    const json = JSON.stringify(tree);
    assert.ok(!json.includes('sk-ant-secret'), 'secret must not be in the tree');
    // The valid key IS present
    assert.equal(get(tree, 'agents.model'), 'claude-opus-4-8');
  });

  it('ANTHROPIC_AUTH_TOKEN is not mapped', () => {
    const { tree } = loadEnvLayer({ ANTHROPIC_AUTH_TOKEN: 'tok-secret' });
    const json = JSON.stringify(tree);
    assert.ok(!json.includes('tok-secret'), 'auth token must not be in the tree');
    assert.deepEqual(tree, {});
  });

  it('any ANTHROPIC_* key is excluded regardless of value', () => {
    const { tree } = loadEnvLayer({
      ANTHROPIC_API_KEY: 'key1',
      ANTHROPIC_AUTH_TOKEN: 'tok2',
      ANTHROPIC_ORGANIZATION_ID: 'org3',
    });
    assert.deepEqual(tree, {});
  });

  it('ANTHROPIC_* exclusion emits no warning (intentional, not an error)', () => {
    const warns = captureWarns(() => {
      loadEnvLayer({ ANTHROPIC_API_KEY: 'sk-ant-secret' });
    });
    assert.equal(warns.length, 0, 'silently skipping ANTHROPIC_* must produce no warning');
  });
});

// ── Top-level keys ────────────────────────────────────────────────────────────

describe('loadEnvLayer — top-level keys', () => {
  it('LOOM_LOOM_HOME → loom_home (top-level field)', () => {
    const { tree } = loadEnvLayer({ LOOM_LOOM_HOME: '/srv/team/loom-home' });
    assert.equal((tree as Record<string, unknown>)['loom_home'], '/srv/team/loom-home');
  });
});

// ── Non-LOOM_ env vars ────────────────────────────────────────────────────────

describe('loadEnvLayer — non-LOOM_ vars are ignored', () => {
  it('PATH, HOME, etc. produce no entries', () => {
    const { tree } = loadEnvLayer({ PATH: '/usr/bin', HOME: '/home/u', EDITOR: 'vi' });
    assert.deepEqual(tree, {});
  });

  it('partial prefix match (e.g. LOOM without underscore) is ignored', () => {
    const { tree } = loadEnvLayer({ LOOM: 'nope', LOOMSOMETHING: 'also-nope' });
    assert.deepEqual(tree, {});
  });
});
