/**
 * story-062-002 — CLI integration: `loom approve` rejects a cyclic epic
 * before any worker is dispatched (AC2/AC4, ADR-002 fail-closed seam).
 *
 * These tests drive `runApprove` (the exported function from gate.ts) with a
 * real loom directory whose epic YAML contains a cyclic cross-repo dependency
 * graph. The `runRun` dispatch function is injected as a spy so we can assert
 * it is NEVER called when a cycle is detected.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { EpicStore, resetDatabaseForTest } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';
import type { RunOptions } from '../commands/run.js';
import { runApprove } from '../commands/gate.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

interface RunRunCall { epicIds: string[]; opts: RunOptions }

function makeRunRunStub(): { fn: (ids: string[], opts?: RunOptions) => Promise<void>; calls: RunRunCall[] } {
  const calls: RunRunCall[] = [];
  const fn = async (epicIds: string[], opts: RunOptions = {}): Promise<void> => {
    calls.push({ epicIds, opts });
  };
  return { fn, calls };
}

interface Captured { exitCode: number | null; logs: string[]; errors: string[] }

async function capture(fn: () => Promise<void> | void): Promise<Captured> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
  return { exitCode, logs, errors };
}

function epicStatus(id: string): string | undefined {
  resetDatabaseForTest();
  const db = openProjectDatabase(tmpDir);
  const status = new EpicStore(db).get(id)?.status;
  resetDatabaseForTest();
  return status;
}

/**
 * Writes a minimal epic YAML with cyclic cross-repo dependencies and seeds
 * the epic row in the DB so `runApprove` can find it.
 *
 * The cycle is: repo-a story depends on repo-b story, repo-b story depends
 * on repo-a story → A→B→A.
 *
 * Story IDs must match StorySchema: story-\d{3}(-\d{3})?
 */
function seedCyclicEpic(epicId: string, num: string): void {
  const idA = `story-${num}-001`;
  const idB = `story-${num}-002`;
  const stories = [
    {
      id: idA,
      title: 'Story in repo-a long enough title',
      description: 'desc',
      acceptance_criteria: ['AC1'],
      estimated_complexity: 'small',
      dependencies: [idB],
      repo: 'repo-a',
    },
    {
      id: idB,
      title: 'Story in repo-b long enough title',
      description: 'desc',
      acceptance_criteria: ['AC1'],
      estimated_complexity: 'small',
      dependencies: [idA],
      repo: 'repo-b',
    },
  ];
  const epicYaml = {
    epic_id: epicId,
    title: `Cyclic epic ${epicId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  // Use a path outside .loom/planning/ so prepareRepoState's migratePlanningScratch
  // does not move the file before detectRepoCycles can read it.
  const rel = `.loom/epics/${epicId}.yaml`;
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  resetDatabaseForTest();
  const db = openProjectDatabase(tmpDir);
  new EpicStore(db).create(epicId, epicYaml.title, rel);
  resetDatabaseForTest();
}

/**
 * Writes a workspace.yaml in loomHomeDir registering two repos (a and b) so
 * that the manifest resolver can find them. Repo-a is marked primary.
 */
function seedTwoRepoManifest(): void {
  const manifest = {
    version: 1,
    repos: [
      { slug: 'repo-a', path: path.join(tmpDir, 'repo-a'), remote_url: null, primary: true },
      { slug: 'repo-b', path: path.join(tmpDir, 'repo-b'), remote_url: null },
    ],
  };
  fs.writeFileSync(path.join(loomHomeDir, 'workspace.yaml'), yaml.dump(manifest));
}

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cycle-reject-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  execFileSync('node', [LOOM_CLI, 'init'], { cwd: tmpDir, stdio: 'ignore' });

  prevCwd = process.cwd();
  process.chdir(tmpDir);
  resetDatabaseForTest();
});

afterEach(() => {
  process.chdir(prevCwd);
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

describe('loom approve — cyclic epic rejected before dispatch (story-062-002)', () => {
  // AC2/AC4: the critical test — runRun (the dispatch entry point) is NEVER called.
  it('AC2/AC4: cyclic epic exits non-zero, runRun is never called (zero workers dispatched)', async () => {
    seedTwoRepoManifest();
    seedCyclicEpic('epic-201', '201');
    const { fn: runRunStub, calls } = makeRunRunStub();

    const { exitCode, errors } = await capture(() =>
      runApprove('epic-201', {
        run: false,
        runRun: runRunStub,
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, 1, 'cyclic epic must cause exit non-zero');
    assert.equal(calls.length, 0, 'runRun (dispatch) must NEVER be called for a cyclic epic');

    // Error must be operator-readable and mention cycle.
    const errText = errors.join('\n');
    assert.match(errText, /cycle/i, 'error output must mention "cycle"');
    assert.match(errText, /epic-201/i, 'error output must name the epic');
  });

  // AC2: epic status must remain 'planned' — never transitions to 'approved'.
  it('AC2: cyclic epic status stays "planned" after rejected approve', async () => {
    seedTwoRepoManifest();
    seedCyclicEpic('epic-202', '202');
    const { fn: runRunStub } = makeRunRunStub();

    await capture(() =>
      runApprove('epic-202', {
        run: false,
        runRun: runRunStub,
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(epicStatus('epic-202'), 'planned', 'epic must remain "planned" when cycle is rejected');
  });

  // AC2/AC4 with --run: even when chained, runRun is never reached.
  it('AC2/AC4 --run: cyclic epic with --run still exits non-zero, runRun never called', async () => {
    seedTwoRepoManifest();
    seedCyclicEpic('epic-203', '203');
    const { fn: runRunStub, calls } = makeRunRunStub();

    const { exitCode } = await capture(() =>
      runApprove('epic-203', {
        run: true,
        runRun: runRunStub,
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, 1, 'cyclic epic must cause exit non-zero even with --run');
    assert.equal(calls.length, 0, 'dispatch (runRun) is never reached when cycle is detected');
    assert.equal(epicStatus('epic-203'), 'planned', 'epic stays planned');
  });

  // Negative case: an acyclic multi-repo epic passes the gate.
  it('acyclic multi-repo epic is approved normally (no false positives)', async () => {
    // Register two repos in the manifest, but with a one-way dependency.
    const manifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: path.join(tmpDir, 'repo-a'), remote_url: null, primary: true },
        { slug: 'repo-b', path: path.join(tmpDir, 'repo-b'), remote_url: null },
      ],
    };
    fs.writeFileSync(path.join(loomHomeDir, 'workspace.yaml'), yaml.dump(manifest));

    // repo-a depends on repo-b (one-way, acyclic)
    const stories = [
      {
        id: 'story-204-001',
        title: 'Story in repo-b long enough title',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: [],
        repo: 'repo-b',
      },
      {
        id: 'story-204-002',
        title: 'Story in repo-a long enough title',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: ['story-204-001'],
        repo: 'repo-a',
      },
    ];
    const epicYaml = {
      epic_id: 'epic-204',
      title: 'Acyclic multi-repo epic',
      status: 'planned',
      priority: 'must-have',
      prd_ref: 'x',
      requirements: ['FR-1'],
      stories,
    };
    // Use path outside .loom/planning/ to avoid migratePlanningScratch moving the file.
    const rel = '.loom/epics/epic-204.yaml';
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, yaml.dump(epicYaml));

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    new EpicStore(db).create('epic-204', epicYaml.title, rel);
    resetDatabaseForTest();

    const { fn: runRunStub, calls } = makeRunRunStub();
    const { exitCode, errors } = await capture(() =>
      runApprove('epic-204', {
        run: false,
        runRun: runRunStub,
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, null, 'acyclic epic must be approved successfully');
    assert.deepEqual(errors, [], 'no errors for an acyclic graph');
    assert.equal(epicStatus('epic-204'), 'approved', 'epic must reach "approved"');
    assert.equal(calls.length, 0, 'runRun not called without --run flag');
  });

  // Single-repo epic (no yaml_path containing cross-repo deps): must pass unchanged.
  it('single-repo epic (seeded without yaml) is approved normally', async () => {
    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    new EpicStore(db).create('epic-205', 'Single repo epic');
    resetDatabaseForTest();

    const { fn: runRunStub } = makeRunRunStub();
    const { exitCode, errors } = await capture(() =>
      runApprove('epic-205', {
        runRun: runRunStub,
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, null, 'single-repo epic must be approved without error');
    assert.deepEqual(errors, []);
    assert.equal(epicStatus('epic-205'), 'approved');
  });

  // [high] Bulk approve (no epic-id) exits 1 when ALL planned epics are cyclic.
  // Previously the bulk path used console.log + return (exit 0) — now it must
  // call process.exit(1) and write the summary to stderr, mirroring the single-epic path.
  it('bulk approve exits non-zero when all planned epics have cycles', async () => {
    seedTwoRepoManifest();
    // Two separate cyclic epics — different story-id namespaces so IDs don't collide.
    seedCyclicEpic('epic-206', '206');
    seedCyclicEpic('epic-207', '207');
    const { fn: runRunStub, calls } = makeRunRunStub();

    const { exitCode, errors } = await capture(() =>
      runApprove(undefined /* bulk */, {
        runRun: runRunStub,
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, 1, 'bulk approve must exit 1 when all epics are cyclic');
    assert.equal(calls.length, 0, 'runRun (dispatch) must never be called');
    // Summary must go to stderr (not stdout) and mention what happened.
    const errText = errors.join('\n');
    assert.match(errText, /0 of 2 epic\(s\) approved/i, 'stderr must state 0 approved');
    assert.match(errText, /cycle/i, 'stderr must mention cycle');
    // Epics must remain planned.
    assert.equal(epicStatus('epic-206'), 'planned', 'epic-206 must remain planned');
    assert.equal(epicStatus('epic-207'), 'planned', 'epic-207 must remain planned');
  });

  // Bulk approve with a mix: one cyclic + one acyclic.  The acyclic one must be
  // approved; exit code is 0 (partial success) because at least one was approved.
  it('bulk approve exits 0 when at least one epic is approved (partial batch)', async () => {
    seedTwoRepoManifest();
    seedCyclicEpic('epic-208', '208'); // cyclic — skipped

    // Seed a clean single-repo epic that has no yaml_path (no cycle check runs).
    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    new EpicStore(db).create('epic-209', 'Clean planned epic');
    resetDatabaseForTest();

    const { fn: runRunStub } = makeRunRunStub();
    const { exitCode } = await capture(() =>
      runApprove(undefined /* bulk */, {
        runRun: runRunStub,
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, null, 'bulk approve with at least one success must exit 0');
    assert.equal(epicStatus('epic-208'), 'planned', 'cyclic epic stays planned');
    assert.equal(epicStatus('epic-209'), 'approved', 'acyclic epic must be approved');
  });
});
