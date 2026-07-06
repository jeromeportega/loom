/**
 * Integration tests for resolveWebRoot.
 *
 * Tests exercise the resolution helper in isolation (no HTTP server started).
 * A custom ProjectRegistry path and machineConfigPath are injected so each
 * test has a hermetic, seeded environment backed by temp files.
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
let emptyMachineConfigPath: string;

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
  // A config file with no project_root, so tests don't fall through to real machine config.
  emptyMachineConfigPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(emptyMachineConfigPath, JSON.stringify({ max_global_workers: 4 }) + '\n');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveWebRoot — CWD is initialized repo', () => {
  it('returns projectRoot === cwd without consulting the registry', () => {
    const repoDir = makeInitializedDir();
    const emptyRegistry = makeRegistry();

    const result = resolveWebRoot(repoDir, emptyRegistry, emptyMachineConfigPath);

    assert.equal(result.projectRoot, repoDir, 'projectRoot must equal the initialized CWD');
    assert.equal(
      result.loomDir,
      path.join(repoDir, '.loom'),
      'loomDir must be .loom under CWD'
    );
  });
});

describe('resolveWebRoot — CWD not a repo, registry has one entry', () => {
  it('returns the registry entry root when CWD has no policy.yaml', () => {
    const fixtureRepo = makeInitializedDir();
    const registry = makeRegistry();
    registry.register(fixtureRepo);

    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const result = resolveWebRoot(nonRepoDir, registry, emptyMachineConfigPath);

    assert.equal(result.projectRoot, fixtureRepo, 'must return the registry fixture path');
    assert.notEqual(result.projectRoot, nonRepoDir, 'must not return the non-repo CWD');
  });
});

describe('resolveWebRoot — resolution order: CWD wins over registry', () => {
  it('returns CWD when both CWD has policy.yaml and registry has a different path', () => {
    const cwdRepo = makeInitializedDir();
    const registryRepo = makeInitializedDir();

    const registry = makeRegistry();
    registry.register(registryRepo);

    const result = resolveWebRoot(cwdRepo, registry, emptyMachineConfigPath);

    assert.equal(result.projectRoot, cwdRepo, 'CWD must win over registry when both are valid');
    assert.notEqual(result.projectRoot, registryRepo, 'registry path must not override CWD');
  });
});

describe('resolveWebRoot — registry empty, CWD not a repo', () => {
  it('throws with a clear error message when no resolution succeeds', () => {
    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
    const emptyRegistry = makeRegistry();

    assert.throws(
      () => resolveWebRoot(nonRepoDir, emptyRegistry, emptyMachineConfigPath),
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
  it('returns the first registered path, not the second', () => {
    const firstRepo = makeInitializedDir();
    const secondRepo = makeInitializedDir();

    const registry = makeRegistry();
    registry.register(firstRepo);
    registry.register(secondRepo);

    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const result = resolveWebRoot(nonRepoDir, registry, emptyMachineConfigPath);

    assert.equal(result.projectRoot, firstRepo, 'must return the first registered path');
    assert.notEqual(result.projectRoot, secondRepo, 'must not return the second registered path');
  });
});

describe('resolveWebRoot — machine config resolution', () => {
  it('returns machine config project_root when registry is empty and CWD is not a repo', () => {
    const machineRepo = makeInitializedDir();
    const machineConfigPath = path.join(tmpDir, 'machine-config.json');
    fs.writeFileSync(
      machineConfigPath,
      JSON.stringify({ project_root: machineRepo }) + '\n'
    );

    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const emptyRegistry = makeRegistry();

    const result = resolveWebRoot(nonRepoDir, emptyRegistry, machineConfigPath);

    assert.equal(result.projectRoot, machineRepo, 'must return machine config project_root');
    assert.equal(result.loomDir, path.join(machineRepo, '.loom'), 'loomDir must be under machine config root');
  });

  it('prefers registry over machine config when registry has an entry', () => {
    const registryRepo = makeInitializedDir();
    const machineRepo = makeInitializedDir();

    const registry = makeRegistry();
    registry.register(registryRepo);

    const machineConfigPath = path.join(tmpDir, 'machine-config.json');
    fs.writeFileSync(
      machineConfigPath,
      JSON.stringify({ project_root: machineRepo }) + '\n'
    );

    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const result = resolveWebRoot(nonRepoDir, registry, machineConfigPath);

    assert.equal(result.projectRoot, registryRepo, 'registry entry must win over machine config');
    assert.notEqual(result.projectRoot, machineRepo, 'machine config must not override registry');
  });
});
