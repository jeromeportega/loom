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
 * story-006-008 — EpicFinalizer.finalize() must promote the planning artifacts
 * BEFORE the integration gate runs, so the gate validates the exact tree the PR
 * will carry (ADR-6), and must promote at exactly one site (no double commit on
 * the block-mode path). These tests drive a real `finalize()` against a real git
 * repo and inspect the committed tree.
 */

let repo: string;
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

/** Counts the artifact-promotion commits reachable from epic/<id>. */
function promotionCommitCount(epicId: string): number {
  const out = gitc([
    '--no-pager',
    'log',
    '--oneline',
    '--grep',
    `loom: planning artifacts for ${epicId}`,
    `epic/${epicId}`,
  ]);
  return out.length === 0 ? 0 : out.split('\n').length;
}

/**
 * Seeds the epic row + a single succeeded story + the planning artifacts the
 * finalizer promotes, and returns the on-disk YAML path. The brief/PRD/arch all
 * live under .loom/planning/<run>/ (gitignored) exactly as the real run lays
 * them out, so promoteArtifacts has something to copy.
 */
function seedEpic(epicId: string, storyId: string): string {
  const planningDir = path.join(loomDir, 'planning', 'run-1');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'project-brief.md'), '# brief\n');
  fs.writeFileSync(path.join(planningDir, 'prd.md'), '# prd\n');
  fs.writeFileSync(path.join(planningDir, 'architecture.md'), '# arch\n');

  const yamlAbs = path.join(planningDir, 'epic.yaml');
  const doc = {
    epic_id: epicId,
    title: 'Gate order epic for tests',
    priority: 'must-have',
    prd_ref: 'prd.md',
    requirements: ['gate runs on promoted tree'],
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
});

describe('EpicFinalizer — promote-before-gate ordering (story-006-008)', () => {
  it('runs the integration gate on a tree that already contains the promoted artifacts', async () => {
    const epicId = 'epic-006';
    const storyId = 'story-006-001';
    seedEpic(epicId, storyId);
    storyBranch(storyId, 'feature.txt', 'feature\n');

    // A capturing gate: at run() time, snapshot whether the promoted artifact
    // directory is present in the gate's working tree.
    let artifactsVisibleToGate: boolean | undefined;
    let artifactCommittedAtGateTime: boolean | undefined;
    const capturingGate = {
      async run(input: { projectRoot: string; conflicted?: string[] }): Promise<GateOutcome> {
        const artifactDir = path.join(input.projectRoot, '.loom_outputs', epicId);
        artifactsVisibleToGate = fs.existsSync(path.join(artifactDir, 'epic.yaml'));
        // The promotion is a real commit on the gated branch, not just a dirty
        // working tree: confirm the artifact is tracked at HEAD (cat-file -e
        // exits 0 only when the object exists; it throws otherwise).
        try {
          execFileSync('git', ['cat-file', '-e', `HEAD:.loom_outputs/${epicId}/epic.yaml`], {
            cwd: input.projectRoot,
            stdio: 'ignore',
          });
          artifactCommittedAtGateTime = true;
        } catch {
          artifactCommittedAtGateTime = false;
        }
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
    });

    const result = await finalizer.finalize(epicId);

    assert.equal(
      artifactsVisibleToGate,
      true,
      'gate must see the promoted .loom_outputs/<epic>/ artifacts in its working tree'
    );
    assert.equal(
      artifactCommittedAtGateTime,
      true,
      'the promoted artifacts must be committed on the gated branch before the gate runs'
    );
    // The gate passed and there is no remote, so finalize stops cleanly at the
    // local-merge state (not gated, not failed).
    assert.equal(result.status, 'merged');
    assert.deepEqual(result.merged, [storyId]);
  });

  it('promotes exactly once in block-mode when the gate fails (no double commit)', async () => {
    const epicId = 'epic-006';
    const storyId = 'story-006-001';
    seedEpic(epicId, storyId);
    storyBranch(storyId, 'feature.txt', 'feature\n');

    // A failing gate triggers the block-mode early-return path — the one that
    // previously promoted a SECOND time.
    let gateSawArtifacts: boolean | undefined;
    const failingGate = {
      async run(input: { projectRoot: string; conflicted?: string[] }): Promise<GateOutcome> {
        gateSawArtifacts = fs.existsSync(
          path.join(input.projectRoot, '.loom_outputs', epicId, 'epic.yaml')
        );
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
    });

    const result = await finalizer.finalize(epicId);

    assert.equal(result.status, 'gated', 'block-mode withholds the PR on a red gate');
    assert.equal(
      gateSawArtifacts,
      true,
      'even on the block path, the gate ran on the already-promoted tree'
    );
    assert.equal(
      promotionCommitCount(epicId),
      1,
      'block-mode must promote at exactly one site — no double commit'
    );
  });

  it('promotes exactly once on the success path too', async () => {
    const epicId = 'epic-006';
    const storyId = 'story-006-001';
    seedEpic(epicId, storyId);
    storyBranch(storyId, 'feature.txt', 'feature\n');

    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db: openDatabase(loomDir),
      allowedRemotes: [],
      prStrategy: 'per-epic',
      // Gate off — exercise the plain success path's single promotion.
      integrationGate: 'off',
    });

    const result = await finalizer.finalize(epicId);

    assert.equal(result.status, 'merged');
    assert.equal(
      promotionCommitCount(epicId),
      1,
      'success path must also promote exactly once'
    );
    // The artifacts are committed on the epic branch.
    assert.ok(
      gitc(['cat-file', '-t', `epic/${epicId}:.loom_outputs/${epicId}/epic.yaml`]) === 'blob'
    );
  });
});
