/**
 * story-095-003 — `loom approve` cycle rejection prints ordered story IDs.
 *
 * The new detectCycles integration (story-095-002 storyGraph module) surfaces
 * the exact story IDs that form the cycle instead of only repo slugs.
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
import { runApprove } from '../commands/gate.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

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

function seedCyclicEpic(epicId: string, num: string): { idA: string; idB: string } {
  const idA = `story-${num}-001`;
  const idB = `story-${num}-002`;
  const stories = [
    {
      id: idA,
      title: `Story A in repo-a ${num}`,
      description: 'desc',
      acceptance_criteria: ['AC1'],
      estimated_complexity: 'small',
      dependencies: [idB],
      repo: 'repo-a',
    },
    {
      id: idB,
      title: `Story B in repo-b ${num}`,
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
  const rel = `.loom/epics/${epicId}.yaml`;
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  resetDatabaseForTest();
  const db = openProjectDatabase(tmpDir);
  new EpicStore(db).create(epicId, epicYaml.title, rel);
  resetDatabaseForTest();

  return { idA, idB };
}

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cycle-ids-'));
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

describe('loom approve — cycle rejection prints ordered story IDs (story-095-003)', () => {
  it('error output contains both story IDs from the cycle path', async () => {
    seedTwoRepoManifest();
    const { idA, idB } = seedCyclicEpic('epic-301', '301');

    const { exitCode, errors } = await capture(() =>
      runApprove('epic-301', {
        run: false,
        runRun: async () => {},
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, 1, 'must exit non-zero for cyclic epic');
    const errText = errors.join('\n');
    assert.match(errText, new RegExp(idA), `error must contain story id "${idA}"`);
    assert.match(errText, new RegExp(idB), `error must contain story id "${idB}"`);
    assert.match(errText, /→/, 'error must use → to show cycle path');
  });

  it('error mentions "cycle" and the epic ID (regression: existing format preserved)', async () => {
    seedTwoRepoManifest();
    seedCyclicEpic('epic-302', '302');

    const { errors } = await capture(() =>
      runApprove('epic-302', {
        run: false,
        runRun: async () => {},
        printOverlapAdvisory: () => {},
      })
    );

    const errText = errors.join('\n');
    assert.match(errText, /cycle/i, 'error must mention "cycle"');
    assert.match(errText, /epic-302/i, 'error must name the epic');
  });

  it('no agent row is created in the DB when cycle is rejected', async () => {
    seedTwoRepoManifest();
    seedCyclicEpic('epic-303', '303');

    await capture(() =>
      runApprove('epic-303', {
        run: false,
        runRun: async () => {},
        printOverlapAdvisory: () => {},
      })
    );

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    const epicRecord = new EpicStore(db).get('epic-303');
    resetDatabaseForTest();

    assert.equal(epicRecord?.status, 'planned', 'epic must stay "planned" — never dispatched');
  });

  it('in-epic story-level cycle (single repo) is also detected', async () => {
    // No manifest needed — in-epic cycle detected via DFS, not cross-repo check.
    const idA = 'story-304-001';
    const idB = 'story-304-002';
    const stories = [
      {
        id: idA,
        title: 'Story A same repo',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: [idB],
      },
      {
        id: idB,
        title: 'Story B same repo',
        description: 'desc',
        acceptance_criteria: ['AC1'],
        estimated_complexity: 'small',
        dependencies: [idA],
      },
    ];
    const epicYaml = {
      epic_id: 'epic-304',
      title: 'Single-repo cyclic epic',
      status: 'planned',
      priority: 'must-have',
      prd_ref: 'x',
      requirements: ['FR-1'],
      stories,
    };
    const rel = '.loom/epics/epic-304.yaml';
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, yaml.dump(epicYaml));

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    new EpicStore(db).create('epic-304', epicYaml.title, rel);
    resetDatabaseForTest();

    const { exitCode, errors } = await capture(() =>
      runApprove('epic-304', {
        run: false,
        runRun: async () => {},
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, 1, 'single-repo cyclic epic must also exit non-zero');
    const errText = errors.join('\n');
    assert.match(errText, /cycle/i, 'error must mention cycle');
    assert.match(errText, new RegExp(idA), `error must contain "${idA}"`);
    assert.match(errText, new RegExp(idB), `error must contain "${idB}"`);
  });
});
