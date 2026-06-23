import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  openDatabase,
  resetDatabaseForTest,
  EpicFinalizer,
  EpicStore,
  AgentStore,
} from '../index.js';
import { IntegrationGate, type GateOutcome } from '../orchestrator/IntegrationGate.js';

/**
 * story-006-008 (updated for story-050-004):
 * EpicFinalizer.finalize() must route planning artifacts to loom-home (NOT to
 * the target epic branch's .loom_outputs/). These tests drive a real finalize()
 * against a real git repo and verify the new artifact isolation semantics.
 *
 * Key changes from the original story-006-008 tests:
 * - Artifacts now go to loom-home, never to target epic branch
 * - Gate runs BEFORE promoteArtifacts (gate-then-home, ADR-5)
 * - Block-mode gate → promoteArtifacts is NOT called (returns early before review)
 */

let repo: string;
let loomHomeDir: string;
let base: string;
let loomDir: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Creates `story/<id>` off `base` carrying a one-line change to `file`. */
function storyBranch(id: string, file: string, content: string): void {
  gitc(['checkout', '-q', '-b', `story/${id}`, base]);
  fs.writeFileSync(path.join(repo, file), content);
  gitc(['add', file]);
  gitc(['commit', '-q', '-m', `${id}: work`]);
  gitc(['checkout', '-q', base]);
}

/**
 * Seeds the epic row + a single succeeded story + the planning artifacts the
 * finalizer promotes, and returns the on-disk YAML path. The brief/PRD/arch all
 * live under .loom/planning/<run>/ (gitignored) exactly as the real run lays
 * them out, so promoteArtifacts has something to copy.
 */
function seedEpic(epicId: string, storyId: string): string {
  // Use epicId as runId (matches default heuristic: runId == epicId).
  const planningDir = path.join(loomDir, 'planning', epicId);
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'project-brief.md'), '# brief\n');
  fs.writeFileSync(path.join(planningDir, 'prd.md'), '# prd\n');
  fs.writeFileSync(path.join(planningDir, 'architecture.md'), '# arch\n');

  const epicsSubdir = path.join(planningDir, 'epics');
  fs.mkdirSync(epicsSubdir, { recursive: true });
  const yamlAbs = path.join(epicsSubdir, `${epicId}.yaml`);
  const doc = {
    epic_id: epicId,
    title: 'Gate order epic for tests',
    priority: 'must-have',
    prd_ref: 'prd.md',
    requirements: ['gate runs on merged tree'],
    stories: [
      {
        id: storyId,
        title: 'A small story to merge into the epic',
        description: 'noop',
        acceptance_criteria: ['it merges'],
        estimated_complexity: 'small',
        dependencies: [],
      },
    ],
  };
  fs.writeFileSync(yamlAbs, yaml.dump(doc));

  const rel = (p: string): string => path.relative(repo, p);
  const epicStore = new EpicStore(openDatabase(loomDir));
  epicStore.create(epicId, 'Gate order epic for tests', rel(yamlAbs));
  epicStore.updateBaseSha(epicId, base);
  epicStore.updatePaths(epicId, {
    brief_path: rel(path.join(planningDir, 'project-brief.md')),
    prd_path: rel(path.join(planningDir, 'prd.md')),
    yaml_path: rel(yamlAbs),
  });

  const agentStore = new AgentStore(openDatabase(loomDir));
  const agent = agentStore.create(epicId, storyId, 'A small story to merge into the epic');
  agentStore.updateStatus(agent.id, 'done');

  return rel(yamlAbs);
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-efgo-')));
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-efgo-home-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  // .loom is gitignored in real repos, so its planning sources survive the
  // `git checkout epic/<id>` the finalizer does in the main checkout.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.loom/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.gitignore', 'README.md']);
  gitc(['commit', '-q', '-m', 'initial']);
  base = gitc(['rev-parse', 'HEAD']);
  loomDir = path.join(repo, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
});

describe('EpicFinalizer — artifact routing to loom-home (story-050-004)', () => {
  it('gate runs on the merged epic tree with NO .loom_outputs artifacts (artifacts go to loom-home)', async () => {
    const epicId = 'epic-006';
    const storyId = 'story-006-001';
    seedEpic(epicId, storyId);
    storyBranch(storyId, 'feature.txt', 'feature\n');

    // A capturing gate: record what is (and isn't) visible in the working tree
    // when the gate runs. With the new routing, no .loom_outputs should be visible.
    let loomOutputsVisibleToGate: boolean | undefined;
    const capturingGate = {
      async run(input: { projectRoot: string; conflicted?: string[] }): Promise<GateOutcome> {
        loomOutputsVisibleToGate = fs.existsSync(
          path.join(input.projectRoot, '.loom_outputs', epicId),
        );
        return {
          ok: true,
          ran: true,
          command: 'true',
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          output: '',
          amputated: input.conflicted ?? [],
          summary: 'ok',
        };
      },
    } as unknown as IntegrationGate;

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db: openDatabase(loomDir),
      allowedRemotes: [],
      prStrategy: 'per-epic',
      integrationGate: 'block',
      gate: capturingGate,
      loomHome: loomHomeDir,
    });

    const result = await finalizer.finalize(epicId);

    assert.equal(
      loomOutputsVisibleToGate,
      false,
      'gate must NOT see .loom_outputs on the target branch — artifacts go to loom-home',
    );
    // The gate passed and there is no remote, so finalize stops cleanly at merged.
    assert.equal(result.status, 'merged');
    assert.deepEqual(result.merged, [storyId]);
    // No .loom_outputs anywhere on the target branch after finalize.
    assert.ok(!fs.existsSync(path.join(repo, '.loom_outputs')));
  });

  it('block-mode gate failure: returns gated, NO .loom_outputs commit on target branch', async () => {
    const epicId = 'epic-006';
    const storyId = 'story-006-001';
    seedEpic(epicId, storyId);
    storyBranch(storyId, 'feature.txt', 'feature\n');

    // Gate fails → block-mode early return.
    const failingGate = {
      async run(input: { projectRoot: string; conflicted?: string[] }): Promise<GateOutcome> {
        return {
          ok: false,
          ran: true,
          command: 'false',
          exitCode: 1,
          timedOut: false,
          durationMs: 1,
          output: 'boom',
          amputated: input.conflicted ?? [],
          summary: 'suite failed',
        };
      },
    } as unknown as IntegrationGate;

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db: openDatabase(loomDir),
      allowedRemotes: [],
      prStrategy: 'per-epic',
      integrationGate: 'block',
      gate: failingGate,
      loomHome: loomHomeDir,
    });

    const result = await finalizer.finalize(epicId);

    assert.equal(result.status, 'gated', 'block-mode withholds the PR on a red gate');
    // No .loom_outputs directory on target branch (no artifact write at all).
    assert.ok(!fs.existsSync(path.join(repo, '.loom_outputs')));
    // Block-mode returns before the review phase, so promoteArtifacts is NOT called.
    // loom_home_status remains null (no commit was attempted).
    const store = new EpicStore(openDatabase(loomDir));
    const { status: lhStatus } = store.getLoomHomeStatus(epicId);
    assert.equal(lhStatus, null, 'gate-blocked epic should not have a loom-home commit attempt');
  });

  it('success path: artifacts committed to loom-home, target epic branch has NO .loom_outputs', async () => {
    const epicId = 'epic-006';
    const storyId = 'story-006-001';
    seedEpic(epicId, storyId);
    storyBranch(storyId, 'feature.txt', 'feature\n');

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db: openDatabase(loomDir),
      allowedRemotes: [],
      prStrategy: 'per-epic',
      integrationGate: 'off',
      loomHome: loomHomeDir,
    });

    const result = await finalizer.finalize(epicId);

    assert.equal(result.status, 'merged');
    // Target branch: NO .loom_outputs directory (AC2).
    assert.ok(!fs.existsSync(path.join(repo, '.loom_outputs')));
    // Target branch: no artifact-promotion commit (grep returns nothing).
    const logOut = gitc([
      '--no-pager', 'log', '--oneline', '--grep', `loom: artifacts for`, `epic/${epicId}`,
    ]);
    assert.equal(logOut, '', `no loom artifact commit should appear on target epic branch: ${logOut}`);
    // loom-home: got the commit (AC1).
    const store = new EpicStore(openDatabase(loomDir));
    const { status: lhStatus } = store.getLoomHomeStatus(epicId);
    assert.equal(lhStatus, 'committed', 'artifacts must be committed to loom-home on success');
  });
});
