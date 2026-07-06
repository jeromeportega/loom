/**
 * Tests for the allowed_read_root policy knob (story-067-001).
 *
 * Covers:
 *   AC1 — PolicySchema.parse({}) yields filesystem.allowed_read_root === '.'
 *   AC2 — explicit value round-trips through zod unchanged
 *   AC3 — type exposes allowed_read_root as string alongside allowed_write_root
 *   AC4 — example policy in init.ts contains allowed_read_root: "."
 *   AC5 — knob is present and defaulted with cross_repo.enabled: false
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PolicySchema } from '../../src/types.js';

// ── AC1: default value ────────────────────────────────────────────────────────

describe('PolicySchema — filesystem.allowed_read_root default (AC1)', () => {
  it('PolicySchema.parse({}) yields filesystem.allowed_read_root === "."', () => {
    const policy = PolicySchema.parse({});
    assert.equal(policy.filesystem.allowed_read_root, '.');
  });

  it('defaults to "." when filesystem block is omitted', () => {
    const policy = PolicySchema.parse({ filesystem: {} });
    assert.equal(policy.filesystem.allowed_read_root, '.');
  });
});

// ── AC2: explicit value round-trips ──────────────────────────────────────────

describe('PolicySchema — filesystem.allowed_read_root explicit value (AC2)', () => {
  it('explicit path round-trips through zod unchanged', () => {
    const policy = PolicySchema.parse({
      filesystem: { allowed_read_root: '/some/path' },
    });
    assert.equal(policy.filesystem.allowed_read_root, '/some/path');
  });

  it('arbitrary string values are accepted (no enum constraint)', () => {
    const policy = PolicySchema.parse({
      filesystem: { allowed_read_root: '/workspace/project' },
    });
    assert.equal(policy.filesystem.allowed_read_root, '/workspace/project');
  });
});

// ── AC3: type exposes allowed_read_root as string alongside allowed_write_root ─

describe('PolicySchema — allowed_read_root type shape (AC3)', () => {
  it('allowed_read_root is a string in the parsed result', () => {
    const policy = PolicySchema.parse({});
    assert.equal(typeof policy.filesystem.allowed_read_root, 'string');
  });

  it('allowed_read_root coexists with allowed_write_root without conflict', () => {
    const policy = PolicySchema.parse({
      filesystem: {
        allowed_write_root: '/write/root',
        allowed_read_root: '/read/root',
      },
    });
    assert.equal(policy.filesystem.allowed_write_root, '/write/root');
    assert.equal(policy.filesystem.allowed_read_root, '/read/root');
  });
});

// ── AC4: example policy in init.ts contains allowed_read_root ────────────────

describe('init.ts DEFAULT_POLICY_YAML — allowed_read_root present (AC4)', () => {
  it('DEFAULT_POLICY_YAML contains allowed_read_root: "."', async () => {
    // Path from dist-test/test/guardrails/ → packages/loom-cli/src/commands/init.ts
    const initPath = path.resolve(
      __dirname,
      '../../../../loom-cli/src/commands/init.ts'
    );
    const src = fs.readFileSync(initPath, 'utf8');
    assert.ok(
      src.includes('allowed_read_root: "."'),
      'init.ts DEFAULT_POLICY_YAML must contain allowed_read_root: "."'
    );
  });
});

// ── AC5: knob is active regardless of cross_repo.enabled ─────────────────────

describe('PolicySchema — allowed_read_root independent of cross_repo (AC5)', () => {
  it('present and defaulted when cross_repo.enabled is false (explicit)', () => {
    const policy = PolicySchema.parse({
      cross_repo: { enabled: false },
    });
    assert.equal(policy.filesystem.allowed_read_root, '.');
  });

  it('present and defaulted when cross_repo is omitted entirely', () => {
    const policy = PolicySchema.parse({});
    assert.equal(policy.filesystem.allowed_read_root, '.');
  });

  it('cross_repo.enabled false does not suppress allowed_read_root', () => {
    const policy = PolicySchema.parse({
      cross_repo: { enabled: false },
      filesystem: { allowed_read_root: '/custom/root' },
    });
    assert.equal(policy.filesystem.allowed_read_root, '/custom/root');
  });
});
