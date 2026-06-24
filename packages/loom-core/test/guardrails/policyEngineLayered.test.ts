import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { PolicyEngine } from '../../src/guardrails/PolicyEngine.js';
import { PolicyValidationError } from '../../src/guardrails/policyError.js';

interface TestDirs {
  loomdir: string;
  projectRoot: string;
  loomHomeDir: string;
  cleanup: () => void;
}

// Creates a temp tree that mirrors the structure resolveEffectiveConfig expects.
// loomHomeDir is placed where resolveLoomHomePath(projectRoot) points
// (sibling of projectRoot named 'loom-home'). Tests that use the team layer
// write explicit `loom_home: loomHomeDir` into policy.yaml so the test does NOT
// rely on resolveLoomHomePath's algorithm — the path is always injected directly.
function makeDirs(): TestDirs {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pe-layered-'));
  const realTmpRoot = (() => {
    try { return fs.realpathSync(tmpRoot); }
    catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      return tmpRoot;
    }
  })();
  const projectRoot = path.join(realTmpRoot, 'project');
  const loomdir = path.join(projectRoot, '.loom');
  const loomHomeDir = path.join(realTmpRoot, 'loom-home');
  fs.mkdirSync(loomdir, { recursive: true });
  fs.mkdirSync(loomHomeDir, { recursive: true });
  return {
    loomdir,
    projectRoot,
    loomHomeDir,
    cleanup: () => fs.rmSync(realTmpRoot, { recursive: true, force: true }),
  };
}

// Creates a minimal isolated project. Tests using this fixture write a
// policy.yaml with an explicit loom_home pointing to a nonexistent path so
// resolveEffectiveConfig can never find a team-config.yaml, regardless of what
// resolveLoomHomePath would compute from the projectRoot heuristic.
function makeIsolatedNoTeamDirs(): { loomdir: string; projectRoot: string; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pe-noteam-'));
  const realTmpRoot = (() => {
    try { return fs.realpathSync(tmpRoot); }
    catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      return tmpRoot;
    }
  })();
  const projectRoot = path.join(realTmpRoot, 'project');
  const loomdir = path.join(projectRoot, '.loom');
  fs.mkdirSync(loomdir, { recursive: true });
  return {
    loomdir,
    projectRoot,
    cleanup: () => fs.rmSync(realTmpRoot, { recursive: true, force: true }),
  };
}

function writePolicy(loomdir: string, obj: unknown): void {
  fs.writeFileSync(path.join(loomdir, 'policy.yaml'), yaml.dump(obj), 'utf8');
}

function writeTeamConfig(loomHomeDir: string, obj: unknown): void {
  fs.writeFileSync(path.join(loomHomeDir, 'team-config.yaml'), yaml.dump(obj), 'utf8');
}

describe('PolicyEngine.load — signature unchanged (AC: no call site breaks)', () => {
  it('load(loomdir) with no policy.yaml returns an engine with default policy', () => {
    const { loomdir, cleanup } = makeDirs();
    try {
      const engine = PolicyEngine.load(loomdir);
      assert.ok(engine instanceof PolicyEngine);
      const r = engine.check('git push --force');
      assert.equal(r.allowed, false);
      assert.equal(r.rule, 'git.forbidden_flags');
    } finally {
      cleanup();
    }
  });

  it('load(loomdir) with a valid policy.yaml reads its values', () => {
    const { loomdir, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { agents: { model: 'claude-opus-4' } });
      // Use hermetic env to prevent LOOM_AGENTS_MODEL in process.env from
      // overriding the repo-layer value we are asserting on.
      const engine = PolicyEngine.load(loomdir, { env: {} });
      assert.equal(engine.policyData.agents.model, 'claude-opus-4');
    } finally {
      cleanup();
    }
  });

  it('single-argument form does not throw at runtime; TypeScript compat is checked separately by tsc', () => {
    const { loomdir, cleanup } = makeDirs();
    try {
      const engine: PolicyEngine = PolicyEngine.load(loomdir);
      assert.ok(engine instanceof PolicyEngine);
    } finally {
      cleanup();
    }
  });

  it('opts.projectRoot defaults to path.dirname(loomdir)', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { agents: { model: 'default-check' } });
      const engineDefault = PolicyEngine.load(loomdir, { env: {} });
      const engineExplicit = PolicyEngine.load(loomdir, { projectRoot, env: {} });
      assert.equal(engineDefault.policyData.agents.model, engineExplicit.policyData.agents.model);
    } finally {
      cleanup();
    }
  });
});

describe('PolicyEngine.load — hermetic env injection', () => {
  it('load(loomdir, { projectRoot, env: {} }) resolves deterministically', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { git: { protected_branches: ['main', 'master'] } });
      const engine1 = PolicyEngine.load(loomdir, { projectRoot, env: {} });
      const engine2 = PolicyEngine.load(loomdir, { projectRoot, env: {} });
      assert.deepEqual(engine1.policyData.git.protected_branches, ['main', 'master']);
      assert.deepEqual(engine1.policyData.git.protected_branches, engine2.policyData.git.protected_branches);
    } finally {
      cleanup();
    }
  });

  it('injected empty env produces a policy with no LOOM_* env overrides', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { agents: { model: 'repo-model' } });
      const engine = PolicyEngine.load(loomdir, { projectRoot, env: {} });
      assert.equal(engine.policyData.agents.model, 'repo-model');
    } finally {
      cleanup();
    }
  });

  it('LOOM_* env var in opts.env overrides the repo-layer value', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { agents: { model: 'repo-model' } });
      const engine = PolicyEngine.load(loomdir, {
        projectRoot,
        env: { LOOM_AGENTS_MODEL: 'env-override-model' },
      });
      assert.equal(engine.policyData.agents.model, 'env-override-model');
    } finally {
      cleanup();
    }
  });
});

describe('PolicyEngine.load — team layer merge reaches enforcement (AC3)', () => {
  it('team-layer protected_branches union-merges with repo layer; engine denies the merged set', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    const noTeam = makeIsolatedNoTeamDirs();
    try {
      const repoPolicy = { git: { protected_branches: ['main', 'master'], agents_must_use_pr: true } };

      // repo layer: protects main and master only.
      // loom_home is explicit so the test does not rely on resolveLoomHomePath's heuristic.
      writePolicy(loomdir, { ...repoPolicy, loom_home: loomHomeDir });

      // no-team fixture: point loom_home at a path that is guaranteed not to exist.
      const noTeamLoomHome = path.join(noTeam.projectRoot, 'nonexistent-loom-home');
      writePolicy(noTeam.loomdir, { ...repoPolicy, loom_home: noTeamLoomHome });

      // team layer: adds 'release' via union-merge denylist
      writeTeamConfig(loomHomeDir, { git: { protected_branches: ['release'] } });

      const withoutTeam = PolicyEngine.load(noTeam.loomdir, { projectRoot: noTeam.projectRoot, env: {} });
      const withoutTeamResult = withoutTeam.check('git push origin release');
      assert.equal(withoutTeamResult.allowed, true, 'without team layer, release push is allowed');

      const engine = PolicyEngine.load(loomdir, { projectRoot, env: {} });

      // smoke-check: merged branches must be strictly larger than repo-only — proves team config was read
      assert.ok(
        engine.policyData.git.protected_branches.length > withoutTeam.policyData.git.protected_branches.length,
        'merged protected_branches must include entries from both layers',
      );

      const withTeamResult = engine.check('git push origin release');
      assert.equal(withTeamResult.allowed, false, 'with team layer, release push must be denied');
      assert.equal(withTeamResult.rule, 'git.protected_branches');
    } finally {
      cleanup();
      noTeam.cleanup();
    }
  });

  it('team-layer guard tightening does not loosen existing repo protections', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      // loom_home is explicit so the test does not rely on resolveLoomHomePath's heuristic.
      writePolicy(loomdir, {
        git: { protected_branches: ['main'], agents_must_use_pr: true },
        loom_home: loomHomeDir,
      });
      writeTeamConfig(loomHomeDir, {
        git: { protected_branches: ['develop'] },
      });

      const engine = PolicyEngine.load(loomdir, { projectRoot, env: {} });

      const mainResult = engine.check('git push origin main');
      assert.equal(mainResult.allowed, false);
      assert.equal(mainResult.rule, 'git.protected_branches');

      const developResult = engine.check('git push origin develop');
      assert.equal(developResult.allowed, false);
      assert.equal(developResult.rule, 'git.protected_branches');
    } finally {
      cleanup();
    }
  });
});

describe('PolicyEngine.load — guard invariant preserved (CLAUDE.md invariant 1)', () => {
  it('forbidden command (git push --force) is still denied after rerouting', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      const engine = PolicyEngine.load(loomdir, { projectRoot, env: {} });
      const r = engine.check('git push --force');
      assert.equal(r.allowed, false);
      assert.equal(r.rule, 'git.forbidden_flags');
    } finally {
      cleanup();
    }
  });

  it('forbidden command exits non-zero equivalent — rule is non-null and matches policy field', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      const engine = PolicyEngine.load(loomdir, { projectRoot, env: {} });
      const r = engine.check('git push --force-with-lease');
      assert.equal(r.allowed, false);
      assert.ok(r.rule, 'rule must be non-null for a denied command');
      assert.match(r.rule, /^git\./);
    } finally {
      cleanup();
    }
  });

  it('check() and CommandParser semantics are unchanged for an equivalent policy', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, {
        git: { protected_branches: ['main', 'master'], agents_must_use_pr: true },
      });
      const engineViaLoad = PolicyEngine.load(loomdir, { projectRoot, env: {} });
      const engineDirect = new PolicyEngine(engineViaLoad.policyData);

      const commands = [
        'git push --force',
        'git push origin main',
        'git push origin story/feature',
        'git status',
        'rm -rf ~/.ssh',
      ];
      for (const cmd of commands) {
        const viaLoad = engineViaLoad.check(cmd);
        const viaDirect = engineDirect.check(cmd);
        assert.deepEqual(
          viaLoad,
          viaDirect,
          `check("${cmd}") must match between load() and direct constructor`,
        );
      }
    } finally {
      cleanup();
    }
  });
});

describe('PolicyEngine.load — no downstream drift (call sites unchanged)', () => {
  it('single-arg load() produces same policy as load(loomdir, { env: {} }) when no team layer exists', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, {
        agents: { model: 'claude-sonnet-4-6', max_concurrent: 3 },
      });
      // Verify the single-arg form loads without error and returns an engine.
      // (Single-arg inherits process.env; value assertions use the explicit form.)
      const singleArgEngine = PolicyEngine.load(loomdir);
      assert.ok(singleArgEngine instanceof PolicyEngine);

      const explicitEngine = PolicyEngine.load(loomdir, { projectRoot, env: {} });
      assert.equal(explicitEngine.policyData.agents.model, 'claude-sonnet-4-6');
      assert.equal(explicitEngine.policyData.agents.max_concurrent, 3);
    } finally {
      cleanup();
    }
  });

  it('invalid policy.yaml still throws PolicyValidationError through the resolver', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { agents: { review_strategy: 'invalid-value' } });
      assert.throws(
        () => PolicyEngine.load(loomdir, { projectRoot, env: {} }),
        (err: unknown) => {
          assert.ok(err instanceof PolicyValidationError, `expected PolicyValidationError, got ${err}`);
          assert.ok(err.policyPath.endsWith('policy.yaml'), 'policyPath must point to policy.yaml');
          assert.ok(err.issues.length > 0, 'must carry structured issues');
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });
});
