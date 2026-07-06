import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TEAM_CONFIG_FILENAME,
  TeamConfigSchema,
  loadTeamConfigLayer,
} from '../../src/config/teamConfig.js';
import { PolicySchema } from '../../src/types.js';
import { PolicyValidationError } from '../../src/guardrails/policyError.js';
import { resolveLoomHomePath } from '../../src/home/resolveLoomHomePath.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-team-cfg-'));
}

function write(dir: string, content: string): string {
  const p = path.join(dir, TEAM_CONFIG_FILENAME);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ── TEAM_CONFIG_FILENAME ──────────────────────────────────────────────────────

describe('TEAM_CONFIG_FILENAME', () => {
  it('is team-config.yaml', () => {
    assert.equal(TEAM_CONFIG_FILENAME, 'team-config.yaml');
  });
});

// ── TeamConfigSchema — derived from PolicySchema (ADR-001) ────────────────────

describe('TeamConfigSchema — derived from PolicySchema', () => {
  it('accepts a partial policy that PolicySchema would also accept', () => {
    // Any input valid for PolicySchema is also valid for TeamConfigSchema.
    const r = TeamConfigSchema.safeParse({ agents: { model: 'claude-opus-4-8' } });
    assert.ok(r.success, `expected success, got: ${!r.success && r.error}`);
  });

  it('accepts a sparse object with only git.protected_branches', () => {
    // Deep-partial: omitting all other required-in-practice fields is fine.
    const r = TeamConfigSchema.safeParse({ git: { protected_branches: ['main'] } });
    assert.ok(r.success, `expected success, got: ${!r.success && r.error}`);
  });

  it('accepts {} (fully empty — every field is optional)', () => {
    const r = TeamConfigSchema.safeParse({});
    assert.ok(r.success);
  });

  it('rejects agents.model typed as a number', () => {
    const r = TeamConfigSchema.safeParse({ agents: { model: 123 } });
    assert.ok(!r.success, 'expected failure for agents.model: 123');
  });

  it('rejects git.protected_branches typed as a string (not an array)', () => {
    const r = TeamConfigSchema.safeParse({ git: { protected_branches: 'main' } });
    assert.ok(!r.success, 'expected failure for git.protected_branches: "main"');
  });

  it('is derived from PolicySchema — every PolicySchema key is accepted as optional', () => {
    // All top-level PolicySchema fields, when present with a valid value, are
    // also accepted by TeamConfigSchema. This asserts derivation, not duplication.
    const fullPolicy = PolicySchema.parse({});
    const r = TeamConfigSchema.safeParse(fullPolicy);
    assert.ok(r.success, 'a full policy object must parse successfully against TeamConfigSchema');
  });
});

// ── loadTeamConfigLayer — absent file ─────────────────────────────────────────

describe('loadTeamConfigLayer — absent file', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns { name: "team", tree: {} } when file does not exist', () => {
    const layer = loadTeamConfigLayer(tmp);
    assert.equal(layer.name, 'team');
    assert.deepEqual(layer.tree, {});
  });
});

// ── loadTeamConfigLayer — empty file (ADR-007: absence ≠ empty) ──────────────

describe('loadTeamConfigLayer — empty and comment-only files', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns tree: {} for an empty file', () => {
    write(tmp, '');
    const layer = loadTeamConfigLayer(tmp);
    assert.deepEqual(layer.tree, {});
  });

  it('returns tree: {} for a comment-only file', () => {
    write(tmp, '# This file is intentionally empty\n# Populate to override team defaults\n');
    const layer = loadTeamConfigLayer(tmp);
    assert.deepEqual(layer.tree, {});
  });

  it('tree is exactly {} — no defaults injected (ADR-007)', () => {
    write(tmp, '');
    const layer = loadTeamConfigLayer(tmp);
    // Must NOT be a defaults-filled policy object
    assert.deepEqual(Object.keys(layer.tree as object), []);
  });
});

// ── loadTeamConfigLayer — happy path (partial config) ────────────────────────

describe('loadTeamConfigLayer — valid partial config', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('accepts a partial file and returns the sparse raw tree (no sibling keys invented)', () => {
    write(tmp, 'agents:\n  model: claude-opus-4-8\n');
    const layer = loadTeamConfigLayer(tmp);
    assert.equal(layer.name, 'team');
    // Raw tree must contain only what was written — no defaults applied
    const tree = layer.tree as { agents: { model: string } };
    assert.equal(tree.agents.model, 'claude-opus-4-8');
    assert.deepEqual(Object.keys(tree), ['agents']);
    assert.deepEqual(Object.keys(tree.agents), ['model']);
  });

  it('accepts a file with only git.protected_branches', () => {
    write(tmp, 'git:\n  protected_branches:\n    - main\n    - production\n');
    const layer = loadTeamConfigLayer(tmp);
    const tree = layer.tree as { git: { protected_branches: string[] } };
    assert.deepEqual(tree.git.protected_branches, ['main', 'production']);
    assert.deepEqual(Object.keys(tree), ['git']);
  });
});

// ── loadTeamConfigLayer — invalid config ──────────────────────────────────────

describe('loadTeamConfigLayer — invalid config throws PolicyValidationError', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('throws PolicyValidationError for agents.model typed as a number', () => {
    write(tmp, 'agents:\n  model: 123\n');
    assert.throws(
      () => loadTeamConfigLayer(tmp),
      (err: unknown) => {
        assert.ok(err instanceof PolicyValidationError, `expected PolicyValidationError, got ${err}`);
        assert.match(err.message, /agents\.model/, 'message must name the field');
        return true;
      },
    );
  });

  it('throws PolicyValidationError for git.protected_branches typed as a string', () => {
    write(tmp, 'git:\n  protected_branches: main\n');
    assert.throws(
      () => loadTeamConfigLayer(tmp),
      (err: unknown) => {
        assert.ok(err instanceof PolicyValidationError, `expected PolicyValidationError, got ${err}`);
        assert.match(err.message, /git\.protected_branches/, 'message must name the field');
        return true;
      },
    );
  });

  it('a numeric out-of-range error echoes the received value, not "Received: undefined"', () => {
    // The team-config layer must match the policy.yaml layer's error quality:
    // max_concurrent: 0 violates `>= 1` and Zod omits `received` for too_small,
    // so the rawInput-by-path fallback must supply the operator's actual value.
    write(tmp, 'agents:\n  max_concurrent: 0\n');
    assert.throws(
      () => loadTeamConfigLayer(tmp),
      (err: unknown) => {
        assert.ok(err instanceof PolicyValidationError, `expected PolicyValidationError, got ${err}`);
        assert.match(err.message, /max_concurrent/, 'message must name the field');
        assert.match(err.message, /Received:\s*0\b/, 'must echo the actual received value (0)');
        assert.doesNotMatch(err.message, /Received:\s*undefined/, 'must not print "Received: undefined"');
        return true;
      },
    );
  });

  it('PolicyValidationError carries the file path', () => {
    write(tmp, 'agents:\n  model: 123\n');
    assert.throws(
      () => loadTeamConfigLayer(tmp),
      (err: unknown) => {
        assert.ok(err instanceof PolicyValidationError);
        assert.ok(
          err.policyPath.endsWith(TEAM_CONFIG_FILENAME),
          `expected policyPath to end with ${TEAM_CONFIG_FILENAME}, got: ${err.policyPath}`,
        );
        return true;
      },
    );
  });
});

// ── Path derivation ───────────────────────────────────────────────────────────

describe('path derivation — TEAM_CONFIG_FILENAME in loom-home', () => {
  it('resolveLoomHomePath + TEAM_CONFIG_FILENAME yields <parent>/loom-home/team-config.yaml', () => {
    const projectRoot = '/home/u/repos/app';
    const loomHome = resolveLoomHomePath(projectRoot, {});
    const teamConfigPath = path.join(loomHome, TEAM_CONFIG_FILENAME);
    assert.equal(teamConfigPath, '/home/u/repos/loom-home/team-config.yaml');
  });

  it('honors policy.loom_home override in the derived path', () => {
    const projectRoot = '/home/u/repos/app';
    const loomHome = resolveLoomHomePath(projectRoot, { loom_home: '/srv/team/loom-home' });
    const teamConfigPath = path.join(loomHome, TEAM_CONFIG_FILENAME);
    assert.equal(teamConfigPath, '/srv/team/loom-home/team-config.yaml');
  });

  it('loadTeamConfigLayer looks for team-config.yaml inside the given directory', () => {
    // A directory that exists but has no team-config.yaml returns empty tree.
    const tmp = makeTmp();
    try {
      const layer = loadTeamConfigLayer(tmp);
      assert.deepEqual(layer.tree, {});
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
