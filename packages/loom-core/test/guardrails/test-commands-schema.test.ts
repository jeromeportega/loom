import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { PolicySchema } from '../../src/types.js';

// ── epic-078 story-078-001: test_commands field in PolicySchema ───────────────
//
// Covers every case in the story QA test plan:
//   - Happy paths: valid entry, field omitted entirely
//   - Errors: missing name / command / paths, empty paths, empty name,
//     non-string path item, non-array test_commands
//   - Co-existence: test_command singular and test_commands plural both present

describe('PolicySchema — test_commands field', () => {
  // ── Happy paths ─────────────────────────────────────────────────────────────

  it('accepts a valid test_commands entry', () => {
    const policy = PolicySchema.parse({
      agents: {
        test_commands: [{ name: 'go-tests', command: 'go test ./...', paths: ['src/**'] }],
      },
    });
    assert.equal(policy.agents.test_commands?.length, 1);
    const entry = policy.agents.test_commands![0];
    assert.equal(entry.name, 'go-tests');
    assert.equal(entry.command, 'go test ./...');
    assert.deepEqual(entry.paths, ['src/**']);
  });

  it('validates without error when test_commands is omitted', () => {
    const result = PolicySchema.safeParse({});
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.agents.test_commands, undefined);
    }
  });

  it('accepts multiple entries in test_commands', () => {
    const policy = PolicySchema.parse({
      agents: {
        test_commands: [
          { name: 'go', command: 'go test ./...', paths: ['**/*.go'] },
          { name: 'js', command: 'npm test', paths: ['**/*.ts', '**/*.js'] },
        ],
      },
    });
    assert.equal(policy.agents.test_commands?.length, 2);
  });

  // ── Error: missing required fields ──────────────────────────────────────────

  it('rejects an entry missing name', () => {
    const result = PolicySchema.safeParse({
      agents: {
        test_commands: [{ command: 'go test ./...', paths: ['src/**'] }],
      },
    });
    assert.equal(result.success, false);
    const err = result.error as ZodError;
    const paths = err.issues.map((i) => i.path.join('.'));
    assert.ok(
      paths.some((p) => p.includes('test_commands') && p.includes('name')),
      `expected a path referencing test_commands…name, got: ${JSON.stringify(paths)}`,
    );
  });

  it('rejects an entry missing command', () => {
    const result = PolicySchema.safeParse({
      agents: {
        test_commands: [{ name: 'go', paths: ['src/**'] }],
      },
    });
    assert.equal(result.success, false);
    const err = result.error as ZodError;
    const paths = err.issues.map((i) => i.path.join('.'));
    assert.ok(
      paths.some((p) => p.includes('test_commands') && p.includes('command')),
      `expected a path referencing test_commands…command, got: ${JSON.stringify(paths)}`,
    );
  });

  it('rejects an entry missing paths', () => {
    const result = PolicySchema.safeParse({
      agents: {
        test_commands: [{ name: 'go', command: 'go test ./...' }],
      },
    });
    assert.equal(result.success, false);
    const err = result.error as ZodError;
    const paths = err.issues.map((i) => i.path.join('.'));
    assert.ok(
      paths.some((p) => p.includes('test_commands') && p.includes('paths')),
      `expected a path referencing test_commands…paths, got: ${JSON.stringify(paths)}`,
    );
  });

  // ── Error: constraint violations ─────────────────────────────────────────────

  it('rejects an entry with paths: [] (empty array, minItems:1)', () => {
    const result = PolicySchema.safeParse({
      agents: {
        test_commands: [{ name: 'go', command: 'go test ./...', paths: [] }],
      },
    });
    assert.equal(result.success, false);
    const err = result.error as ZodError;
    const paths = err.issues.map((i) => i.path.join('.'));
    assert.ok(
      paths.some((p) => p.includes('test_commands') && p.includes('paths')),
      `expected a path referencing test_commands…paths, got: ${JSON.stringify(paths)}`,
    );
  });

  it('rejects an entry with name: "" (empty string)', () => {
    const result = PolicySchema.safeParse({
      agents: {
        test_commands: [{ name: '', command: 'go test ./...', paths: ['src/**'] }],
      },
    });
    assert.equal(result.success, false);
    const err = result.error as ZodError;
    const paths = err.issues.map((i) => i.path.join('.'));
    assert.ok(
      paths.some((p) => p.includes('test_commands') && p.includes('name')),
      `expected a path referencing test_commands…name, got: ${JSON.stringify(paths)}`,
    );
  });

  it('rejects an entry where paths contains a non-string value', () => {
    const result = PolicySchema.safeParse({
      agents: {
        test_commands: [{ name: 'go', command: 'go test ./...', paths: [123] }],
      },
    });
    assert.equal(result.success, false);
    const err = result.error as ZodError;
    const paths = err.issues.map((i) => i.path.join('.'));
    assert.ok(
      paths.some((p) => p.includes('test_commands') && p.includes('paths')),
      `expected a path referencing test_commands…paths, got: ${JSON.stringify(paths)}`,
    );
  });

  it('rejects test_commands when it is a non-array value (string)', () => {
    const result = PolicySchema.safeParse({
      agents: { test_commands: 'go test ./...' },
    });
    assert.equal(result.success, false);
    const err = result.error as ZodError;
    const paths = err.issues.map((i) => i.path.join('.'));
    assert.ok(
      paths.some((p) => p.includes('test_commands')),
      `expected a path referencing test_commands, got: ${JSON.stringify(paths)}`,
    );
  });

  // ── Co-existence with singular test_command ──────────────────────────────────

  it('passes when both test_command and test_commands are present', () => {
    const policy = PolicySchema.parse({
      agents: {
        test_command: 'npm test',
        test_commands: [{ name: 'go', command: 'go test ./...', paths: ['**/*.go'] }],
      },
    });
    assert.equal(policy.agents.test_command, 'npm test');
    assert.equal(policy.agents.test_commands?.length, 1);
  });
});
