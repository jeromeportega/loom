/**
 * Backward-compatibility regression test — NFR-1 / ADR-007 tripwire.
 *
 * Invariant: with an absent or empty loom-home team layer and empty env,
 * resolveEffectiveConfig(opts).policy is structurally identical to
 * PolicySchema.parse(raw ?? {}), where raw is the policy.yaml content.
 *
 * This is the standing guardrail for ADR-007.  The test MUST FAIL if:
 *   - defaults are applied mid-merge instead of once at the end (e.g. the
 *     team layer runs through PolicySchema.parse before merge, injecting
 *     default guard lists like ['main','master'] into a layer that should
 *     be empty — those defaults then union/intersect against the repo layer
 *     and corrupt the result), OR
 *   - a union/intersect is performed against an empty-but-defaulted layer
 *     instead of treating absence as "no opinion".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveEffectiveConfig } from '../../src/config/resolveEffectiveConfig.js';
import { PolicySchema } from '../../src/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestDirs {
  loomdir: string;
  projectRoot: string;
  loomHomeDir: string;
  cleanup: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDirs(): TestDirs {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bc-reg-'));
  // Resolve symlinks (macOS /tmp → /private/tmp) so resolveLoomHomePath's
  // fs.realpathSync and our loomHomeDir computation agree on the same path.
  const realTmpRoot = (() => {
    try { return fs.realpathSync(tmpRoot); }
    catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      return tmpRoot;
    }
  })();
  // projectRoot is a child of realTmpRoot so that resolveLoomHomePath's
  // heuristic (path.dirname(realProjectRoot) + '/loom-home') resolves to
  // realTmpRoot/loom-home — the same directory where writeTeamConfig writes.
  const projectRoot = path.join(realTmpRoot, 'project');
  const loomdir = path.join(projectRoot, '.loom');
  const loomHomeDir = path.join(realTmpRoot, 'loom-home');
  fs.mkdirSync(loomdir, { recursive: true });
  // NOTE: loomHomeDir is NOT created by default — tests that need an absent
  // team layer simply leave it absent.  Tests for an empty team layer must
  // call fs.mkdirSync(loomHomeDir, {recursive:true}) themselves before writing.
  return {
    loomdir,
    projectRoot,
    loomHomeDir,
    cleanup: () => fs.rmSync(realTmpRoot, { recursive: true, force: true }),
  };
}

function writePolicy(loomdir: string, obj: Record<string, unknown>): void {
  fs.writeFileSync(path.join(loomdir, 'policy.yaml'), yaml.dump(obj), 'utf8');
}

function writeTeamConfig(loomHomeDir: string, content: string): void {
  fs.mkdirSync(loomHomeDir, { recursive: true });
  fs.writeFileSync(path.join(loomHomeDir, 'team-config.yaml'), content, 'utf8');
}

/**
 * The single-repo baseline: exactly what the policy engine did before the
 * layered resolver was introduced.  Parsing the raw policy.yaml content once
 * through PolicySchema is the reference behavior.
 */
function singleRepoBaseline(rawPolicyContent: Record<string, unknown> | null): ReturnType<typeof PolicySchema.parse> {
  return PolicySchema.parse(rawPolicyContent ?? {});
}

// ── Single-repo fixtures ───────────────────────────────────────────────────────
//
// Each fixture is a policy.yaml content object representing a real-world
// single-repo configuration.  At least one fixture exercises guard lists so
// that a union/intersect-on-defaults regression is caught immediately.

const FIXTURES: Array<{ name: string; content: Record<string, unknown> | null }> = [
  {
    name: 'absent policy.yaml (all defaults)',
    // null means "do not write policy.yaml" — the resolver must handle absence.
    content: null,
  },
  {
    name: 'agents-only (non-guard scalars)',
    content: {
      agents: { model: 'claude-opus-4-8', max_concurrent: 3 },
    },
  },
  {
    // ADR-007 tripwire: if the team layer were defaulted through PolicySchema,
    // it would carry protected_branches: ['main','master'].  A union of that
    // with ['staging'] gives ['main','master','staging'], not ['staging'].
    // The deepEqual below would fail if that mid-merge defaulting happens.
    name: 'protected_branches guard list (denylist — ADR-007 tripwire)',
    content: {
      git: { protected_branches: ['staging'] },
    },
  },
  {
    // ADR-007 tripwire (boolean guard): if the team layer defaulted
    // agents_must_use_pr to true, the 'and' merge would return true even
    // though the repo explicitly set it to false.
    name: 'agents_must_use_pr false (boolean guard — ADR-007 tripwire)',
    content: {
      git: { agents_must_use_pr: false },
    },
  },
  {
    name: 'allowed_remotes guard allowlist (intersect)',
    content: {
      git: { allowed_remotes: ['origin', 'upstream'] },
    },
  },
  {
    name: 'full config — multiple guard fields and scalars',
    content: {
      git: {
        protected_branches: ['main', 'production'],
        allowed_remotes: ['origin'],
        agents_must_use_pr: true,
        forbidden_flags: ['--force'],
      },
      agents: {
        model: 'claude-sonnet-4-6',
        max_concurrent: 4,
        worktree_isolation: true,
      },
    },
  },
];

// ── Regression suites ─────────────────────────────────────────────────────────

for (const fixture of FIXTURES) {
  describe(`backward-compat regression — ${fixture.name}`, () => {
    // Case 1: team layer is absent (no loom-home directory, no team-config.yaml)
    it('absent team layer: effective config deepEquals policy.yaml-only parse', () => {
      const { loomdir, projectRoot, cleanup } = makeDirs();
      try {
        if (fixture.content !== null) {
          writePolicy(loomdir, fixture.content);
        }
        // No loomHomeDir created → loadTeamConfigLayer returns { tree: {} }
        const effective = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
        const baseline = singleRepoBaseline(fixture.content);
        assert.deepEqual(
          effective.policy,
          baseline,
          `effective config must match PolicySchema.parse(policy.yaml) — fixture: "${fixture.name}"`,
        );
      } finally {
        cleanup();
      }
    });

    // Case 2: team layer is present but empty (file exists, zero bytes)
    it('empty team-config.yaml: effective config deepEquals policy.yaml-only parse', () => {
      const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
      try {
        if (fixture.content !== null) {
          writePolicy(loomdir, fixture.content);
        }
        // Present but empty file — loadTeamConfigLayer returns { tree: {} }
        writeTeamConfig(loomHomeDir, '');
        const effective = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
        const baseline = singleRepoBaseline(fixture.content);
        assert.deepEqual(
          effective.policy,
          baseline,
          `effective config must match PolicySchema.parse(policy.yaml) — fixture: "${fixture.name}"`,
        );
      } finally {
        cleanup();
      }
    });

    // Case 3: team layer is present but comment-only (yaml.load returns null)
    it('comment-only team-config.yaml: effective config deepEquals policy.yaml-only parse', () => {
      const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
      try {
        if (fixture.content !== null) {
          writePolicy(loomdir, fixture.content);
        }
        // Comment-only file — js-yaml returns null, loadTeamConfigLayer returns { tree: {} }
        writeTeamConfig(loomHomeDir, '# team-config.yaml intentionally empty\n# no team overrides\n');
        const effective = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
        const baseline = singleRepoBaseline(fixture.content);
        assert.deepEqual(
          effective.policy,
          baseline,
          `effective config must match PolicySchema.parse(policy.yaml) — fixture: "${fixture.name}"`,
        );
      } finally {
        cleanup();
      }
    });
  });
}

// ── Explicit ADR-007 tripwire — mid-merge defaulting detection ─────────────────
//
// This suite contains pairs where the bug would produce a visibly different
// result.  If the team layer were run through PolicySchema.parse() before
// merge, the protected_branches default ['main','master'] would union with
// the repo's ['staging'] and produce ['main','master','staging'] — wrong.

describe('ADR-007 tripwire — mid-merge defaulting would corrupt guard lists', () => {
  it('protected_branches: absent team layer produces EXACTLY the repo list, not a union with schema defaults', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { git: { protected_branches: ['staging', 'release'] } });
      const effective = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      // Correct: exactly what the repo set.
      // Wrong (mid-merge default): ['main','master','staging','release']
      assert.deepEqual(effective.policy.git.protected_branches, ['staging', 'release']);
    } finally {
      cleanup();
    }
  });

  it('agents_must_use_pr false: absent team layer preserves the repo false value', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { git: { agents_must_use_pr: false } });
      const effective = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      // Correct: false, as the repo set.
      // Wrong (mid-merge default via 'and' strategy): true (schema default wins)
      assert.equal(effective.policy.git.agents_must_use_pr, false);
    } finally {
      cleanup();
    }
  });

  it('empty team-config.yaml + protected_branches in repo: no union with schema defaults', () => {
    const { loomdir, projectRoot, loomHomeDir, cleanup } = makeDirs();
    try {
      writePolicy(loomdir, { git: { protected_branches: ['staging'] } });
      writeTeamConfig(loomHomeDir, '');
      const effective = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      // Correct: ['staging'] only.
      // Wrong: ['main','master','staging'] if team defaults leaked into merge.
      assert.deepEqual(effective.policy.git.protected_branches, ['staging']);
    } finally {
      cleanup();
    }
  });
});

// ── No LOOM_* env — env layer adds nothing ────────────────────────────────────

describe('env layer adds nothing when env is empty {}', () => {
  it('empty env: effective config equals policy.yaml-only parse for a full config', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      const content: Record<string, unknown> = {
        git: {
          protected_branches: ['main', 'staging'],
          allowed_remotes: ['origin'],
        },
        agents: { model: 'claude-opus-4-8', max_concurrent: 2 },
      };
      writePolicy(loomdir, content);
      const effective = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      const baseline = singleRepoBaseline(content);
      assert.deepEqual(effective.policy, baseline);
    } finally {
      cleanup();
    }
  });

  it('empty env with absent policy.yaml: effective config equals PolicySchema.parse({})', () => {
    const { loomdir, projectRoot, cleanup } = makeDirs();
    try {
      const effective = resolveEffectiveConfig({ loomdir, projectRoot, env: {} });
      const baseline = PolicySchema.parse({});
      assert.deepEqual(effective.policy, baseline);
    } finally {
      cleanup();
    }
  });
});
