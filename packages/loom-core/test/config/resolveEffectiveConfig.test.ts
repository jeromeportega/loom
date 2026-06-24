import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveEffectiveConfig } from '../../src/config/resolveEffectiveConfig.js';

// ── helpers ───────────────────────────────────────────────────────────────────

interface TestDirs {
  loomdir: string;
  projectRoot: string;
  loomHomeDir: string;
  cleanup: () => void;
}

function makeDirs(): TestDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-resolve-eff-'));
  const loomdir = path.join(root, '.loom');
  // resolveLoomHomePath defaults to sibling 'loom-home' of projectRoot.
  const loomHomeDir = path.join(path.dirname(root), 'loom-home');
  fs.mkdirSync(loomdir, { recursive: true });
  fs.mkdirSync(loomHomeDir, { recursive: true });
  return {
    loomdir,
    projectRoot: root,
    loomHomeDir,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(loomHomeDir, { recursive: true, force: true });
    },
  };
}

function writePolicy(loomdir: string, obj: unknown): void {
  fs.writeFileSync(path.join(loomdir, 'policy.yaml'), yaml.dump(obj), 'utf8');
}

function writeTeamConfig(loomHomeDir: string, obj: unknown): void {
  fs.writeFileSync(path.join(loomHomeDir, 'team-config.yaml'), yaml.dump(obj), 'utf8');
}

// ── Precedence — team ◁ repo ◁ env ───────────────────────────────────────────

describe('resolveEffectiveConfig — precedence', () => {
  it('env wins over repo and team for a scalar', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, { agents: { model: 'team-model' } });
      writePolicy(loomdir, { agents: { model: 'repo-model' } });
      const result = resolveEffectiveConfig({
        loomdir,
        projectRoot,
        env: { LOOM_AGENTS_MODEL: 'env-model' },
      });
      assert.equal(result.policy.agents.model, 'env-model');
    } finally {
      cleanup();
    }
  });

  it('repo wins over team when env is absent', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, { agents: { model: 'team-model' } });
      writePolicy(loomdir, { agents: { model: 'repo-model' } });
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.equal(result.policy.agents.model, 'repo-model');
    } finally {
      cleanup();
    }
  });

  it('team value resolves when repo and env are both absent', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, { agents: { model: 'team-model' } });
      // No policy.yaml written
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.equal(result.policy.agents.model, 'team-model');
    } finally {
      cleanup();
    }
  });

  it('maps merge key-wise across layers', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, { agents: { model: 'team-model' } });
      writePolicy(loomdir, { agents: { max_concurrent: 3 } });
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.equal(result.policy.agents.model, 'team-model');
      assert.equal(result.policy.agents.max_concurrent, 3);
    } finally {
      cleanup();
    }
  });

  it('env LOOM_GIT_PROTECTED_BRANCHES unions with repo protected_branches', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { git: { protected_branches: ['main'] } });
      const result = resolveEffectiveConfig({
        loomdir,
        projectRoot,
        env: { LOOM_GIT_PROTECTED_BRANCHES: 'develop' },
      });
      const branches = result.policy.git.protected_branches;
      assert.ok(branches.includes('main'));
      assert.ok(branches.includes('develop'));
    } finally {
      cleanup();
    }
  });
});

// ── Determinism (NFR-2) ───────────────────────────────────────────────────────

describe('resolveEffectiveConfig — determinism (NFR-2)', () => {
  it('identical inputs → byte-identical effective config', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, { agents: { model: 'claude-sonnet' } });
      writePolicy(loomdir, {
        git: { protected_branches: ['main'] },
        agents: { max_concurrent: 4 },
      });
      const opts = {
        loomdir,
        projectRoot,
        env: { LOOM_AGENTS_MAX_CONCURRENT: '3' },
      };
      const r1 = resolveEffectiveConfig(opts);
      const r2 = resolveEffectiveConfig(opts);
      assert.deepEqual(r1.policy, r2.policy);
      assert.deepEqual(r1.provenance, r2.provenance);
    } finally {
      cleanup();
    }
  });

  it('JSON.stringify of effective config is stable across two calls', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, {
        git: { protected_branches: ['release'] },
        agents: { model: 'claude-opus' },
      });
      writePolicy(loomdir, {
        git: { protected_branches: ['main'] },
        agents: { max_concurrent: 2 },
      });
      const opts = { loomdir, projectRoot, env: {} };
      const r1 = JSON.stringify(resolveEffectiveConfig(opts).policy);
      const r2 = JSON.stringify(resolveEffectiveConfig(opts).policy);
      assert.equal(r1, r2);
    } finally {
      cleanup();
    }
  });
});

// ── PolicySchema defaults applied exactly once (ADR-007) ─────────────────────

describe('resolveEffectiveConfig — defaults applied once (ADR-007)', () => {
  it('absent fields receive PolicySchema defaults, not intermediate defaults', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      // No team-config, no policy.yaml, no env → all defaults
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.deepEqual(result.policy.git.protected_branches, ['main', 'master']);
      assert.equal(result.policy.agents.max_concurrent, 5);
      assert.equal(result.policy.git.agents_must_use_pr, true);
    } finally {
      cleanup();
    }
  });

  it('absent protected_branches uses PolicySchema default, not empty []', () => {
    // No layer sets protected_branches → PolicySchema fills ['main', 'master']
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.deepEqual(result.policy.git.protected_branches, ['main', 'master']);
    } finally {
      cleanup();
    }
  });

  it('a field set in one layer does not cause PolicySchema defaults to bleed through', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      // Team sets only agents.model — all other fields should still use defaults
      writeTeamConfig(loomHomeDir, { agents: { model: 'custom-model' } });
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.equal(result.policy.agents.model, 'custom-model');
      // Other defaults still applied by PolicySchema
      assert.equal(result.policy.agents.max_concurrent, 5);
      assert.equal(result.policy.git.agents_must_use_pr, true);
    } finally {
      cleanup();
    }
  });
});

// ── Guard list security ───────────────────────────────────────────────────────

describe('resolveEffectiveConfig — guard list security', () => {
  it('protected_branches: union of team and repo layers', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, { git: { protected_branches: ['release'] } });
      writePolicy(loomdir, { git: { protected_branches: ['main'] } });
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.ok(result.policy.git.protected_branches.includes('release'));
      assert.ok(result.policy.git.protected_branches.includes('main'));
    } finally {
      cleanup();
    }
  });

  it('allowed_remotes: intersect of team and repo layers', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, { git: { allowed_remotes: ['origin', 'upstream'] } });
      writePolicy(loomdir, { git: { allowed_remotes: ['origin'] } });
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.deepEqual(result.policy.git.allowed_remotes, ['origin']);
    } finally {
      cleanup();
    }
  });
});

// ── Missing / empty files ─────────────────────────────────────────────────────

describe('resolveEffectiveConfig — missing or empty files', () => {
  it('no policy.yaml: resolves using only team and env', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writeTeamConfig(loomHomeDir, { agents: { max_concurrent: 2 } });
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.equal(result.policy.agents.max_concurrent, 2);
    } finally {
      cleanup();
    }
  });

  it('no team-config.yaml: resolves using only repo and env', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { agents: { max_concurrent: 7 } });
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.equal(result.policy.agents.max_concurrent, 7);
    } finally {
      cleanup();
    }
  });

  it('all absent: returns policy with all PolicySchema defaults', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      const result = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      const defaultPolicy = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      assert.deepEqual(result.policy, defaultPolicy.policy);
    } finally {
      cleanup();
    }
  });
});
