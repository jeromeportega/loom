/**
 * Acceptance spec for linkWorkspaceDeps — cross-package API-addition scenario.
 *
 * Exercises the REAL IntegrationBranch / IntegrationGate path INCLUDING the
 * linkWorkspaceDeps preflight from story-007-001.  The fixture repo mimics
 * the loom monorepo layout:
 *
 *   packages/loom-core — the dependency (@loom-ai/core)
 *   packages/loom-web  — the dependent  (@loom-ai/web)
 *
 * The parent repo has stale `node_modules/@loom-ai/core` pointing to its own
 * packages/loom-core (as npm-workspaces installs would create).  The
 * integration worktree is created at `<repo>/.loom/integration/<epic>`,
 * physically *inside* the parent repo, so without a local dep-link Node.js
 * resolution climbs up and lands on the parent's stale module — the real
 * defect precondition.  With `linkWorkspaceDeps` in place the worktree-local
 * node_modules intercepts the climb and points at the freshly merged packages.
 *
 * Four test cases cover all four acceptance criteria:
 *   AC2 (pass)  — gate passes once dep-link is in place
 *   AC2 (fail) / AC1 / AC3 — gate fails on stale parent resolution, non-vacuously
 *   AC4 (regression) — gate still fails on a genuine cross-package regression
 *   AC4 (amputated)  — gate fails when a story is dropped regardless of test result
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntegrationBranch } from '../orchestrator/IntegrationBranch.js';
import { IntegrationGate } from '../orchestrator/IntegrationGate.js';

// ---- constants -------------------------------------------------------

const EPIC = 'epic-reg-001';

/**
 * Gate command: loads loom-web from the worktree and calls .run().
 * In Node.js eval mode, require('./...') resolves from process.cwd(),
 * which IntegrationGate sets to the integration worktree root.
 * The @loom-ai/core import inside loom-web starts resolution from
 * <worktree>/packages/loom-web/src/ and walks up through node_modules:
 *   - WITH dep-link: stops at <worktree>/node_modules/@loom-ai/core
 *     (symlink to ../../packages/loom-core — the worktree's fresh copy).
 *   - WITHOUT dep-link: climbs past the worktree boundary and resolves to
 *     <parent-repo>/node_modules/@loom-ai/core (the stale copy).
 */
const GATE_CMD = "node -e \"require('./packages/loom-web/src/index.js').run()\"";

// ---- git helper -------------------------------------------------------

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// ---- Fixture builders ------------------------------------------------

function writeInitialPackages(repo: string): void {
  // packages/loom-core — exports only greet() in the initial state
  const coreDir = path.join(repo, 'packages', 'loom-core', 'src');
  fs.mkdirSync(coreDir, { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'packages', 'loom-core', 'package.json'),
    JSON.stringify({ name: '@loom-ai/core', version: '1.0.0', main: 'src/index.js' }, null, 2),
  );
  fs.writeFileSync(
    path.join(coreDir, 'index.js'),
    `'use strict';\nexports.greet = () => 'hello';\n`,
  );

  // packages/loom-web — calls core.greet() in the initial state
  const webDir = path.join(repo, 'packages', 'loom-web', 'src');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'packages', 'loom-web', 'package.json'),
    JSON.stringify(
      { name: '@loom-ai/web', version: '1.0.0', main: 'src/index.js', dependencies: { '@loom-ai/core': '*' } },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(webDir, 'index.js'),
    `'use strict';\nconst core = require('@loom-ai/core');\nexports.run = () => core.greet();\n`,
  );
}

/**
 * Creates the parent fixture repo with a stale `node_modules/@loom-ai/`
 * pointing at the parent's own packages (as npm workspaces would create).
 * This is the "defect state": a fresh integration worktree inside this repo
 * will resolve @loom-ai/core to the parent's stale packages if no local
 * dep-link is in place.
 */
function createParentRepo(): { repo: string; base: string; branch: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reg-')));

  gitc(['init', '-q'], repo);
  gitc(['config', 'user.email', 'test@loom.dev'], repo);
  gitc(['config', 'user.name', 'Loom Test'], repo);
  gitc(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');

  writeInitialPackages(repo);
  gitc(['add', '.'], repo);
  gitc(['commit', '-q', '-m', 'initial'], repo);
  const base = gitc(['rev-parse', 'HEAD'], repo);
  // Capture the initial branch name (varies by git config: main or master).
  const branch = gitc(['rev-parse', '--abbrev-ref', 'HEAD'], repo);

  // Simulate the stale npm-workspaces install: parent node_modules points at
  // THIS checkout's packages, which do NOT have newMethod yet.
  const scopeDir = path.join(repo, 'node_modules', '@loom-ai');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync('../../packages/loom-core', path.join(scopeDir, 'core'));
  fs.symlinkSync('../../packages/loom-web', path.join(scopeDir, 'web'));

  return { repo, base, branch };
}

/**
 * story-a: adds newMethod() to loom-core.
 * This is the "story A adds a method to the dependency" part of the scenario.
 */
function createStoryA(repo: string, base: string, returnBranch: string): void {
  gitc(['checkout', '-q', '-b', 'story/story-a', base], repo);
  fs.writeFileSync(
    path.join(repo, 'packages', 'loom-core', 'src', 'index.js'),
    `'use strict';\nexports.greet = () => 'hello';\nexports.newMethod = () => 'world';\n`,
  );
  gitc(['add', '.'], repo);
  gitc(['commit', '-q', '-m', 'story-a: add newMethod to loom-core'], repo);
  // Return to a named branch rather than a detached-HEAD SHA so the main
  // worktree is in a well-defined state when ensure() creates the integration worktree.
  gitc(['checkout', '-q', returnBranch], repo);
}

/**
 * story-b: switches loom-web from greet() to newMethod().
 * Calling this method requires that loom-core exports newMethod — which only
 * exists on the WORKTREE's freshly merged packages, not on the parent's stale ones.
 */
function createStoryB(repo: string, base: string, returnBranch: string): void {
  gitc(['checkout', '-q', '-b', 'story/story-b', base], repo);
  fs.writeFileSync(
    path.join(repo, 'packages', 'loom-web', 'src', 'index.js'),
    `'use strict';\nconst core = require('@loom-ai/core');\nexports.run = () => core.newMethod();\n`,
  );
  gitc(['add', '.'], repo);
  gitc(['commit', '-q', '-m', 'story-b: call newMethod from loom-web'], repo);
  gitc(['checkout', '-q', returnBranch], repo);
}

// ---- Suite -----------------------------------------------------------

describe('IntegrationGate regression — cross-package API-addition scenario', () => {
  let repo: string;
  let base: string;
  let branch: string;

  beforeEach(() => {
    ({ repo, base, branch } = createParentRepo());
    createStoryA(repo, base, branch);
    createStoryB(repo, base, branch);
  });

  afterEach(() => {
    // Delete entire temp repo (includes .loom/integration worktree inside it).
    fs.rmSync(repo, { recursive: true, force: true });
  });

  // ---- AC2 (pass side) -----------------------------------------------

  it('gate passes after linkWorkspaceDeps resolves cross-package method (AC2 pass)', async () => {
    // Use the REAL linkWorkspaceDeps — this is the default IntegrationBranch behaviour.
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure(EPIC, base);

    // Merge both stories: story-a adds newMethod to core, story-b uses it.
    ib.mergeStory(EPIC, 'story-a', 'Add newMethod to core');
    ib.mergeStory(EPIC, 'story-b', 'Call newMethod from web');

    // linkWorkspaceDeps created <worktree>/node_modules/@loom-ai/core ->
    //   ../../packages/loom-core (the worktree's own fresh copy with newMethod).
    assert.equal(
      fs.lstatSync(path.join(info.path, 'node_modules', '@loom-ai', 'core')).isSymbolicLink(),
      true,
      'dep-link must exist: linkWorkspaceDeps must have created the symlink',
    );

    const gate = new IntegrationGate({ testCommand: GATE_CMD });
    const outcome = await gate.run({ projectRoot: info.path });

    assert.equal(outcome.ok, true, 'gate must pass: dep-link resolves to worktree\'s fresh loom-core');
    assert.equal(outcome.ran, true, 'gate command must have run');
    assert.equal(outcome.exitCode, 0, 'gate command must exit 0');
    assert.equal(outcome.amputated.length, 0, 'no stories amputated');
  });

  // ---- AC2 (fail side) / AC1 / AC3 ------------------------------------

  it('gate fails when dep-link is absent and Node climbs to stale parent (AC2 fail / AC1 / AC3)', async () => {
    // Inject a no-op linkDeps to reproduce the UNPATCHED state: worktree
    // has no local node_modules/@loom-ai/* so resolution climbs to parent.
    const ib = new IntegrationBranch(repo, { linkDeps: () => {} });
    const info = ib.ensure(EPIC, base);

    ib.mergeStory(EPIC, 'story-a', 'Add newMethod to core');
    ib.mergeStory(EPIC, 'story-b', 'Call newMethod from web');

    // AC3 — non-vacuity guard: assert the real defect precondition holds.
    const wtLocalLink = path.join(info.path, 'node_modules', '@loom-ai', 'core');
    assert.equal(
      fs.existsSync(wtLocalLink),
      false,
      'worktree must lack local dep-link — without this the scenario is vacuous',
    );
    const parentStaleLink = path.join(repo, 'node_modules', '@loom-ai', 'core');
    assert.equal(
      fs.existsSync(parentStaleLink),
      true,
      'parent must have stale node_modules so Node.js resolution climbs to it',
    );

    // AC1 / AC2 — the test must produce a real failure, not a vacuous pass.
    const gate = new IntegrationGate({ testCommand: GATE_CMD });
    const outcome = await gate.run({ projectRoot: info.path });

    assert.equal(
      outcome.ok,
      false,
      'gate must fail: Node resolves @loom-ai/core to parent\'s stale packages (no newMethod)',
    );
    assert.equal(outcome.ran, true, 'gate command must have run and produced the error');
    assert.notEqual(outcome.exitCode, 0, 'gate command must exit non-zero on stale dep');
  });

  // ---- AC4 (genuine regression) ----------------------------------------

  it('gate still fails on a genuine cross-package regression even with dep-links (AC4 guardrail integrity)', async () => {
    // story-c calls a symbol that does not exist in loom-core — a real regression.
    // The dep-link is in place (real linkWorkspaceDeps) but must not mask the bug.
    gitc(['checkout', '-q', '-b', 'story/story-c', base], repo);
    fs.writeFileSync(
      path.join(repo, 'packages', 'loom-web', 'src', 'index.js'),
      `'use strict';\nconst core = require('@loom-ai/core');\nexports.run = () => core.definitivelyMissing();\n`,
    );
    gitc(['add', '.'], repo);
    gitc(['commit', '-q', '-m', 'story-c: genuine regression — calls non-existent method'], repo);
    gitc(['checkout', '-q', branch], repo);

    // Use REAL linkWorkspaceDeps — dep-link is in place.
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure(EPIC, base);
    ib.mergeStory(EPIC, 'story-a', 'Add newMethod to core');
    ib.mergeStory(EPIC, 'story-c', 'Genuine regression');

    const gate = new IntegrationGate({ testCommand: GATE_CMD });
    const outcome = await gate.run({ projectRoot: info.path });

    assert.equal(outcome.ran, true, 'gate command must have run — guardrail must not short-circuit');
    assert.equal(
      outcome.ok,
      false,
      'gate must still fail on a genuine regression even when dep-links are correct',
    );
    assert.notEqual(outcome.exitCode, 0, 'gate command must exit non-zero for real regression');
  });

  // ---- AC4 (amputated) ------------------------------------------------

  it('gate fails and reports amputated stories regardless of test-command result (AC4 amputated integrity)', async () => {
    // Merge only story-a (loom-web still calls greet() — command would pass).
    // story-b is NOT merged; we simulate it as conflicted/amputated.
    const ib = new IntegrationBranch(repo);
    const info = ib.ensure(EPIC, base);
    ib.mergeStory(EPIC, 'story-a', 'Add newMethod to core');
    // loom-web in the worktree still calls greet() (initial state, pre-story-b).

    const gate = new IntegrationGate({ testCommand: GATE_CMD });
    // story-b was dropped from the integration (conflict / amputation).
    const outcome = await gate.run({ projectRoot: info.path, conflicted: ['story-b'] });

    // The test command itself must have passed (greet() still works) — the gate
    // must fail solely because of the amputation, not because the command failed.
    assert.equal(outcome.ran, true, 'gate command must have run');
    assert.equal(outcome.exitCode, 0, 'test command must pass so only amputation drives ok:false');
    assert.equal(
      outcome.ok,
      false,
      'gate must fail when a story is amputated, regardless of whether the test command passes',
    );
    assert.deepEqual(outcome.amputated, ['story-b'], 'amputated story must be reported');
    assert.ok(
      outcome.summary.includes('story-b'),
      'summary must name the amputated story for the audit log',
    );
  });
});
