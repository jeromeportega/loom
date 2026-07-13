/**
 * Thin smoke tests for `loom retrieve` CLI (story-057-005).
 *
 * Tests that:
 *  1. The retrieve search/read specs validate against CommandDescriptionSchema.
 *  2. The commands are registered in buildProgram().
 *  3. Missing required flags cause a non-zero exit.
 *
 * The real contract is the RetrievalService API — see
 * packages/loom-core/test/retrieval/RetrievalService.test.ts for the
 * end-to-end integration tests. This file keeps the CLI surface thin.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRegistry, resetDatabaseForTest } from '@loom-ai/core';
import { CommandDescriptionSchema } from '../describe/schema.js';
import { specSearch, specRead, runRetrieveSearch, runRetrieveRead } from '../commands/retrieve.js';
import { enumerateRegisteredCommands } from '../describe/registry.js';
import { buildProgram } from '../index.js';

// ── Spec validation ───────────────────────────────────────────────────────────

describe('retrieve CLI — spec validation', () => {
  it('specSearch validates against CommandDescriptionSchema', () => {
    assert.doesNotThrow(
      () => CommandDescriptionSchema.parse(specSearch),
      'specSearch must be a valid CommandDescription',
    );
  });

  it('specRead validates against CommandDescriptionSchema', () => {
    assert.doesNotThrow(
      () => CommandDescriptionSchema.parse(specRead),
      'specRead must be a valid CommandDescription',
    );
  });

  it('specSearch.name is "retrieve search"', () => {
    assert.equal(specSearch.name, 'retrieve search');
  });

  it('specRead.name is "retrieve read"', () => {
    assert.equal(specRead.name, 'retrieve read');
  });
});

// ── Registration in buildProgram() ────────────────────────────────────────────

describe('retrieve CLI — buildProgram registration', () => {
  it('"retrieve search" is registered in the live command tree', () => {
    const cmds = enumerateRegisteredCommands(buildProgram());
    assert.ok(cmds.includes('retrieve search'), `expected "retrieve search" in ${cmds.join(', ')}`);
  });

  it('"retrieve read" is registered in the live command tree', () => {
    const cmds = enumerateRegisteredCommands(buildProgram());
    assert.ok(cmds.includes('retrieve read'), `expected "retrieve read" in ${cmds.join(', ')}`);
  });
});

// ── Missing-flag behavior: exits non-zero ─────────────────────────────────────

interface Captured { errors: string[]; exitCode: number | null }

async function capture(fn: () => Promise<void>): Promise<Captured> {
  const origExit = process.exit as (code?: number) => never;
  const origErr = console.error;
  const origStderr = process.stderr.write.bind(process.stderr);
  const errors: string[] = [];
  let exitCode: number | null = null;

  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  process.stderr.write = (chunk: unknown) => {
    errors.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };

  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit'))) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    console.error = origErr;
    process.stderr.write = origStderr;
  }
  return { errors, exitCode };
}

// ── Directory-independent project resolution ─────────────────────────────────
//
// retrieve is a CROSS-REPO command, so — like `loom web` — it resolves a project
// from the machine registry rather than requiring the CWD to be initialized.
// These tests inject an ISOLATED registry + machine-config path so they exercise
// both resolution outcomes WITHOUT ever touching the developer's real ~/.loom.

describe('retrieve CLI — directory-independent project resolution', () => {
  let tmpDir: string;
  let registryFile: string;
  let emptyMachineConfigPath: string;
  let nonRepoCwd: string;

  function makeRegistry(): ProjectRegistry {
    return new ProjectRegistry({ path: registryFile });
  }

  function makeInitializedRepo(): string {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'loom-repo-'));
    fs.mkdirSync(path.join(dir, '.loom'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.loom', 'policy.yaml'), 'version: 1\n');
    return dir;
  }

  beforeEach(() => {
    // openDatabase returns a process-wide singleton, and retrieve's finally
    // closes it — harmless for a one-shot CLI process, but across tests in one
    // process a prior close would hand the next test a closed handle. Reset the
    // singleton so each test simulates a fresh CLI invocation.
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-retrieve-res-'));
    registryFile = path.join(tmpDir, 'registry.json');
    // A machine config with no project_root so resolution can't fall through to it.
    emptyMachineConfigPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(emptyMachineConfigPath, JSON.stringify({ max_global_workers: 4 }) + '\n');
    // A directory that is NOT a loom project — the "run from anywhere" caller.
    nonRepoCwd = fs.mkdtempSync(path.join(tmpDir, 'non-repo-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runRetrieveSearch: no project resolves anywhere → NO_PROJECT message, exit 1', async () => {
    const { exitCode, errors } = await capture(async () => {
      await runRetrieveSearch({
        repo: 'some-repo', query: 'anything', cwd: nonRepoCwd,
        registry: makeRegistry(), machineConfigPath: emptyMachineConfigPath,
      });
    });
    assert.equal(exitCode, 1, 'should exit 1 when no project resolves');
    assert.ok(
      errors.join(' ').includes('No loom project found'),
      `expected the no-project message; got: ${errors.join(' | ')}`,
    );
  });

  it('runRetrieveRead: no project resolves anywhere → NO_PROJECT message, exit 1', async () => {
    const { exitCode, errors } = await capture(async () => {
      await runRetrieveRead({
        repo: 'some-repo', filePath: 'any.ts', cwd: nonRepoCwd,
        registry: makeRegistry(), machineConfigPath: emptyMachineConfigPath,
      });
    });
    assert.equal(exitCode, 1, 'should exit 1 when no project resolves');
    assert.ok(
      errors.join(' ').includes('No loom project found'),
      `expected the no-project message; got: ${errors.join(' | ')}`,
    );
  });

  it('runRetrieveSearch: CWD not initialized but a project is registered → resolves it', async () => {
    const registry = makeRegistry();
    registry.register(makeInitializedRepo());

    const { exitCode, errors } = await capture(async () => {
      await runRetrieveSearch({
        repo: 'some-repo', query: 'anything', cwd: nonRepoCwd,
        registry, machineConfigPath: emptyMachineConfigPath,
      });
    });
    // Resolution succeeded: retrieve reached the RetrievalService, which refuses
    // because 'some-repo' is not registered in the workspace manifest.
    // The point is that the NO_PROJECT gate did NOT fire — retrieve ran from a
    // non-repo CWD by resolving the registered project.
    const joined = errors.join(' ');
    assert.equal(exitCode, 1, 'still exits 1 — but on a cross_repo refusal, not a missing project');
    assert.ok(!joined.includes('No loom project found'), `must NOT hit the no-project gate; got: ${joined}`);
    assert.ok(
      joined.includes('cross_repo.unregistered'),
      `expected a cross_repo.unregistered refusal proving resolution reached the service; got: ${joined}`,
    );
    // The registry fallback must be announced, not silent, so the operator can
    // see which project's policy governed.
    assert.ok(
      joined.includes('governed by'),
      `expected the governing-project notice on stderr; got: ${joined}`,
    );
  });

  it('runRetrieveSearch: from a SUBDIR of an initialized repo → resolves the enclosing repo', async () => {
    const repo = makeInitializedRepo();
    const subdir = path.join(repo, 'packages', 'x', 'src');
    fs.mkdirSync(subdir, { recursive: true });
    // Registry points elsewhere — the enclosing repo must win over it.
    const registry = makeRegistry();
    registry.register(makeInitializedRepo());

    const { exitCode, errors } = await capture(async () => {
      await runRetrieveSearch({
        repo: 'some-repo', query: 'anything', cwd: subdir,
        registry, machineConfigPath: emptyMachineConfigPath,
      });
    });
    const joined = errors.join(' ');
    assert.equal(exitCode, 1, 'exits 1 on the cross_repo refusal, having resolved the enclosing repo');
    assert.ok(joined.includes('cross_repo.unregistered'), `expected refusal proving resolution reached the service; got: ${joined}`);
    // The notice must NOT claim there is no project — we are inside one.
    assert.ok(joined.includes('enclosing loom project'), `expected the enclosing-project notice; got: ${joined}`);
    assert.ok(!joined.includes('no loom project'), `must not claim no project when enclosed; got: ${joined}`);
  });

  it('runRetrieveRead exits non-zero when --lines is malformed (before resolution)', async () => {
    // parseLines validation fires before project resolution, so no registry needed.
    const { exitCode, errors } = await capture(async () => {
      await runRetrieveRead({ repo: 'some-repo', filePath: 'any.ts', lines: 'not-valid', cwd: nonRepoCwd });
    });
    assert.ok(exitCode !== null && exitCode !== 0, 'malformed --lines should exit non-zero');
    assert.ok(errors.some(e => e.includes('--lines')), `error message should mention --lines; got: ${errors.join(' | ')}`);
  });
});
