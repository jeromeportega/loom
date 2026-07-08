/**
 * Integration tests for resolveWebRoot and runWeb.
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
import { resolveWebRoot, runWeb } from '../commands/web.js';
import type { CreateAppOptions } from '@loom-ai/web';

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

    assert.ok(result !== null, 'must return a result when CWD is initialized');
    assert.equal(result!.projectRoot, repoDir, 'projectRoot must equal the initialized CWD');
    assert.equal(
      result!.loomDir,
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

    assert.ok(result !== null, 'must return a result when registry has an entry');
    assert.equal(result!.projectRoot, fixtureRepo, 'must return the registry fixture path');
    assert.notEqual(result!.projectRoot, nonRepoDir, 'must not return the non-repo CWD');
  });
});

describe('resolveWebRoot — resolution order: CWD wins over registry', () => {
  it('returns CWD when both CWD has policy.yaml and registry has a different path', () => {
    const cwdRepo = makeInitializedDir();
    const registryRepo = makeInitializedDir();

    const registry = makeRegistry();
    registry.register(registryRepo);

    const result = resolveWebRoot(cwdRepo, registry, emptyMachineConfigPath);

    assert.ok(result !== null, 'must return a result when CWD is initialized');
    assert.equal(result!.projectRoot, cwdRepo, 'CWD must win over registry when both are valid');
    assert.notEqual(result!.projectRoot, registryRepo, 'registry path must not override CWD');
  });
});

describe('resolveWebRoot — registry empty, CWD not a repo', () => {
  it('returns null (not a throw, not undefined) when all three resolution paths are exhausted', () => {
    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
    const emptyRegistry = makeRegistry();

    // emptyMachineConfigPath has no project_root, so all three paths are exhausted:
    //   1. CWD — no .loom/policy.yaml
    //   2. Registry — empty
    //   3. Machine config — file exists but has no valid project_root
    const result = resolveWebRoot(nonRepoDir, emptyRegistry, emptyMachineConfigPath);

    assert.strictEqual(result, null, 'must return null (not throw, not undefined) when no project resolves');
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

    assert.ok(result !== null, 'must return a result when registry has entries');
    assert.equal(result!.projectRoot, firstRepo, 'must return the first registered path');
    assert.notEqual(result!.projectRoot, secondRepo, 'must not return the second registered path');
  });
});

describe('resolveWebRoot — skips a registered-but-uninitialized entry', () => {
  it('skips a registered project whose .loom/policy.yaml is gone and returns the next valid one', () => {
    // A registered root that still EXISTS but is no longer initialized (its
    // .loom/policy.yaml was removed) — must not be served with a fresh empty DB.
    const staleRepo = fs.mkdtempSync(path.join(tmpDir, 'stale-repo-'));
    fs.mkdirSync(path.join(staleRepo, '.loom'), { recursive: true }); // .loom exists, no policy.yaml
    const validRepo = makeInitializedDir();

    const registry = makeRegistry();
    registry.register(staleRepo);
    registry.register(validRepo);

    const nonRepoDir = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
    const result = resolveWebRoot(nonRepoDir, registry, emptyMachineConfigPath);

    assert.ok(result !== null, 'must return a result when a valid entry follows a stale one');
    assert.equal(result!.projectRoot, validRepo, 'must skip the stale entry and return the valid one');
    assert.notEqual(result!.projectRoot, staleRepo, 'must not serve the uninitialized (empty-DB) root');
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

    assert.ok(result !== null, 'must return a result, not null');
    assert.equal(result!.projectRoot, machineRepo, 'must return machine config project_root');
    assert.equal(result!.loomDir, path.join(machineRepo, '.loom'), 'loomDir must be under machine config root');
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

    assert.ok(result !== null, 'must return a result, not null');
    assert.equal(result!.projectRoot, registryRepo, 'registry entry must win over machine config');
    assert.notEqual(result!.projectRoot, machineRepo, 'machine config must not override registry');
  });
});

describe('runWeb — null-tolerant when no project resolves', () => {
  it('does not call process.exit and passes db=null, projectRoot=null to createApp', async () => {
    let capturedArgs: CreateAppOptions | undefined;
    let exitWasCalled = false;

    const origExit = process.exit.bind(process);
    // Spy: mark that exit was attempted and throw so the process stays alive.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = (_code?: number): never => {
      exitWasCalled = true;
      throw new Error('process.exit must not be called when no project resolves');
    };

    try {
      await runWeb(
        { noOpen: true },
        {
          _resolveWebRoot: () => null,
          // Capture the createApp call args; return a stub (safe because _listen is also mocked).
          _createApp: (args) => {
            capturedArgs = args;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return {} as any;
          },
          // Avoid real port binding; just echo the start port back.
          _listen: async (_app, startPort) => startPort,
        }
      );
      assert.equal(exitWasCalled, false, 'process.exit must not be called when no project resolves');
      assert.ok(capturedArgs !== undefined, 'createApp must be called');
      assert.strictEqual(capturedArgs?.db, null, 'createApp must be called with db: null');
      assert.strictEqual(capturedArgs?.projectRoot, null, 'createApp must be called with projectRoot: null');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).exit = origExit;
    }
  });
});
