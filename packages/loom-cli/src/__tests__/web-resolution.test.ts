/**
 * Integration tests for resolveWebRoot.
 *
 * Tests exercise the resolution helper in isolation (no HTTP server started).
 * A custom ProjectRegistry path is injected via the optional second argument
 * so each test has a hermetic, seeded registry backed by a temp file.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRegistry } from '@loom-ai/core';
import { resolveWebRoot } from '../commands/web.js';

let tmpDir: string;
let registryFile: string;

function makeRegistry(): ProjectRegistry {
  return new ProjectRegistry({ path: registryFile });
}

function makeInitializedDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'loom-repo-'));
  fs.mkdirSync(path.join(dir, '.loom'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.loom', 'policy.yaml'), 'version: 1\n');
  return dir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-web-res-'));
  registryFile = path.join(tmpDir, 'registry.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveWebRoot — CWD is initialized repo', () => {
  it('returns projectRoot === cwd without consulting the registry', async () => {
    const repoDir = makeInitializedDir();
    const emptyRegistry = makeRegistry(); // registry has no entries

    const result = await resolveWebRoot(repoDir, emptyRegistry);

    assert.equal(result.projectRoot, repoDir, 'projectRoot must equal the initialized CWD');
    assert.equal(
      result.loomDir,
      path.join(repoDir, '.loom'),
      'loomDir must be .loom under CWD'
    );
  });
});

describe('resolveWebRoot — CWD not a repo, registry has one entry', () => {
  it('returns the registry entry root when CWD has no policy.yaml', async () => {
    const fixtureRepo = makeInitializedDir();
    const registry = makeRegistry();
    registry.register(fixtureRepo);

    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const result = await resolveWebRoot(nonRepoDir, registry);

    assert.equal(result.projectRoot, fixtureRepo, 'must return the registry fixture path');
    assert.notEqual(result.projectRoot, nonRepoDir, 'must not return the non-repo CWD');
  });
});

describe('resolveWebRoot — resolution order: CWD wins over registry', () => {
  it('returns CWD when both CWD has policy.yaml and registry has a different path', async () => {
    const cwdRepo = makeInitializedDir();
    const registryRepo = makeInitializedDir();

    const registry = makeRegistry();
    registry.register(registryRepo);

    const result = await resolveWebRoot(cwdRepo, registry);

    assert.equal(result.projectRoot, cwdRepo, 'CWD must win over registry when both are valid');
    assert.notEqual(result.projectRoot, registryRepo, 'registry path must not override CWD');
  });
});

describe('resolveWebRoot — registry empty, CWD not a repo', () => {
  it('throws with a clear error message', () => {
    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
    const emptyRegistry = makeRegistry();

    assert.throws(
      () => resolveWebRoot(nonRepoDir, emptyRegistry),
      (err: Error) => {
        assert.ok(
          err.message.includes('not initialized') || err.message.includes('no loom project is registered'),
          `Error message must mention 'not initialized' or 'no loom project is registered', got: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe('resolveWebRoot — registry first entry wins', () => {
  it('returns the first registered path, not the second', async () => {
    const firstRepo = makeInitializedDir();
    const secondRepo = makeInitializedDir();

    const registry = makeRegistry();
    registry.register(firstRepo);
    registry.register(secondRepo);

    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const result = await resolveWebRoot(nonRepoDir, registry);

    assert.equal(result.projectRoot, firstRepo, 'must return the first registered path');
    assert.notEqual(result.projectRoot, secondRepo, 'must not return the second registered path');
  });
});
