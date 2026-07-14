/**
 * story-058-007: Per-repo structural guardrail enforcement and worker confinement.
 *
 * Exercises the REAL PolicyEngine.checkCrossRepoAccess guard — no mocks.
 * Every acceptance criterion is verified here:
 *   AC1: each repo's guardrails apply to its worktree/PR, unchanged.
 *   AC2: a worker attempting to write outside its own story's repo worktree is
 *        prevented structurally.
 *   AC3: this test proves AC2.
 *   AC4: no guardrail is relaxed for any repo by cross-repo coordination.
 *
 * Test plan coverage:
 *   (1) Confinement proof — worker in repo A denied git commit/cp/rm against
 *       repo B's worktree with cross_repo.read_only; same ops in own worktree allowed.
 *   (2) Sibling read-only, not invisible — non-raw-read against repo B is allowed;
 *       write is denied (READ_ONLY vs OUT_OF_WORKSPACE rule distinction).
 *   (3) Per-repo policy — each worktree loads its own repo's effective config;
 *       allowed_remotes do NOT bleed across repos.
 *   (4) Protected-branch and remote guardrails fire per-repo, unchanged.
 *   (5) Structural-not-cooperative — no writable_repos field; denial needs no
 *       agent signal.
 *   (+) assertConfinedWrite helper — throws for out-of-worktree, passes in-worktree.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { PolicyEngine, type WorktreeContext } from '../../src/guardrails/PolicyEngine.js';
import { assertConfinedWrite, ConfinementViolation } from '../../src/guardrails/repoConfinement.js';
import { PolicySchema } from '../../src/types.js';
import { CROSS_REPO_RULES } from '../../src/retrieval/types.js';
import { registerRepo } from '../../src/home/workspaceManifest.js';
import { gitSafe } from '../../src/orchestrator/git.js';
import type { AuditLog } from '../../src/state/AuditLog.js';
import type { WorkerAssignment } from '../../src/orchestrator/WorkerRunner.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-confine-${prefix}-`));
  try { return fs.realpathSync(dir); } catch { return dir; }
}

function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed in ${dir}: ${res.output}`);
}

function makeAuditSpy(): { audit: AuditLog; entries: Parameters<AuditLog['record']>[0][] } {
  const entries: Parameters<AuditLog['record']>[0][] = [];
  const audit = {
    record: (e: Parameters<AuditLog['record']>[0]) => { entries.push(e); },
  } as unknown as AuditLog;
  return { audit, entries };
}

function makeEngine(enabled = true): PolicyEngine {
  return new PolicyEngine(PolicySchema.parse({ cross_repo: { enabled } }));
}

function writePolicyYaml(loomdir: string, obj: unknown): void {
  fs.mkdirSync(loomdir, { recursive: true });
  fs.writeFileSync(path.join(loomdir, 'policy.yaml'), yaml.dump(obj), 'utf8');
}

// ── Fixture ───────────────────────────────────────────────────────────────────

describe('story-058-007: per-repo confinement (structural, real guard)', () => {
  // Shared workspace — one manifest for all repos.
  let loomHome: string;

  // Repo A — the "producing" repo; worker is dispatched here.
  let repoARoot: string;
  // Simulated worktree inside repo A (as WorktreeManager would create one).
  let repoAWorktree: string;

  // Repo B — a sibling; the worker must NOT be able to write here.
  let repoBRoot: string;
  // Simulated worktree inside repo B (target for confinement escapes).
  let repoBWorktree: string;

  let ctx: WorktreeContext;     // worker-A context, cross_repo.enabled=true
  let engine: PolicyEngine;     // engine with cross_repo.enabled=true
  let spy: ReturnType<typeof makeAuditSpy>;

  before(() => {
    loomHome   = makeTmp('home');
    repoARoot  = makeTmp('repoA');
    repoBRoot  = makeTmp('repoB');

    gitInit(repoARoot);
    gitInit(repoBRoot);

    // Register both repos in the shared workspace manifest.
    registerRepo(loomHome, repoARoot);
    registerRepo(loomHome, repoBRoot);

    // Worker A's worktree lives inside repo A (mirrors WorktreeManager layout).
    repoAWorktree = path.join(repoARoot, '.loom', 'worktrees', 'story-058-007');
    fs.mkdirSync(repoAWorktree, { recursive: true });

    // Repo B's worktree (used as a target for escape attempts).
    repoBWorktree = path.join(repoBRoot, '.loom', 'worktrees', 'story-058-007');
    fs.mkdirSync(repoBWorktree, { recursive: true });

    spy    = makeAuditSpy();
    engine = makeEngine(true);
    ctx    = { worktreeRoot: repoAWorktree, loomHome, audit: spy.audit };
  });

  after(() => {
    for (const d of [loomHome, repoARoot, repoBRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // ── (1) Confinement proof ──────────────────────────────────────────────────

  describe('(1) Confinement proof — worker-A writes to repo B are denied', () => {
    it('git commit -C repoBRoot is denied with cross_repo.read_only', () => {
      spy.entries.length = 0;
      const r = engine.check(`git -C ${repoBRoot} commit -m "escape"`, ctx);
      assert.equal(r.allowed, false, 'git commit into sibling must be denied');
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY,
        'rule must be cross_repo.read_only for git write into sibling');
      assert.equal(spy.entries.length, 1, 'one audit entry per refusal');
      assert.equal(spy.entries[0].policy_rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('git commit -C repoBWorktree is denied with cross_repo.read_only', () => {
      const r = engine.check(`git -C ${repoBWorktree} commit -m "escape"`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('cp from own worktree into repoBRoot is denied with cross_repo.read_only', () => {
      spy.entries.length = 0;
      const src = path.join(repoAWorktree, 'src.ts');
      const dst = path.join(repoBRoot, 'src.ts');
      const r = engine.check(`cp ${src} ${dst}`, ctx);
      assert.equal(r.allowed, false, 'cp into sibling must be denied');
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('cp into repoBWorktree is denied with cross_repo.read_only', () => {
      const src = path.join(repoAWorktree, 'x.ts');
      const dst = path.join(repoBWorktree, 'x.ts');
      const r = engine.check(`cp ${src} ${dst}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('rm targeting repoBRoot path is denied (structural write refusal)', () => {
      // checkRm() or checkCrossRepoAccess() — either way, the write is denied
      // structurally. See crossRepoAccess.test.ts for the same note.
      const r = engine.check(`rm ${path.join(repoBRoot, 'file.ts')}`, ctx);
      assert.equal(r.allowed, false, 'rm into sibling must be denied');
    });

    it('rm targeting repoBWorktree path is denied', () => {
      const r = engine.check(`rm ${path.join(repoBWorktree, 'file.ts')}`, ctx);
      assert.equal(r.allowed, false);
    });

    // Control cases — same operations INSIDE own worktree must be allowed.
    it('git commit with no -C arg (stays in own worktree) is allowed', () => {
      const r = engine.check('git commit -m "fix: confined"', ctx);
      assert.equal(r.allowed, true, 'git commit inside own worktree must be allowed');
    });

    it('cp within own worktree is allowed', () => {
      const src = path.join(repoAWorktree, 'a.ts');
      const dst = path.join(repoAWorktree, 'b.ts');
      const r = engine.check(`cp ${src} ${dst}`, ctx);
      assert.equal(r.allowed, true, 'cp within own worktree must be allowed');
    });

    it('denial happens without any agent-provided signal — WorktreeContext has no writable_repos', () => {
      // Verify confinement is structural: ctx carries only worktreeRoot + loomHome + audit.
      // There is no writable_repos field. Denial is automatic from WorktreeContext alone.
      assert.ok(!('writable_repos' in ctx), 'WorktreeContext must have no writable_repos field (ADR-005)');
      const r = engine.check(`git -C ${repoBRoot} commit -m "escape"`, ctx);
      assert.equal(r.allowed, false, 'denied without any agent-provided allowlist');
    });
  });

  // ── (2) Siblings read-only, not invisible ─────────────────────────────────

  describe('(2) Sibling repos are read-only, not invisible', () => {
    it('ls on repoBRoot is allowed (not a write, not a raw-read program)', () => {
      // 'ls' is not in RAW_READ_PROGRAMS and not a write op; the guard permits it.
      // This demonstrates that siblings are accessible (not invisible), just write-blocked.
      const r = engine.check(`ls ${repoBRoot}`, ctx);
      assert.equal(r.allowed, true, 'ls on a sibling root must be allowed');
    });

    it('cat on repoBRoot is denied with USE_RETRIEVAL (raw read into sibling)', () => {
      // Raw reads into registered siblings are denied by Rule 1 (USE_RETRIEVAL).
      const r = engine.check(`cat ${path.join(repoBRoot, 'README.md')}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.USE_RETRIEVAL,
        'raw read into sibling must be denied with USE_RETRIEVAL, not READ_ONLY');
    });

    it('touch on repoBRoot is denied with READ_ONLY (write into sibling)', () => {
      const r = engine.check(`touch ${path.join(repoBRoot, 'new.ts')}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY,
        'write into sibling must be denied with READ_ONLY, not OUT_OF_WORKSPACE');
    });

    it('path inside sibling is IN workspace (Rule 2 does not fire)', () => {
      // A path under repoBRoot is in the workspace — OUT_OF_WORKSPACE must not fire.
      // The denial (if any) must be USE_RETRIEVAL or READ_ONLY, not OUT_OF_WORKSPACE.
      const r = engine.check(`cat ${path.join(repoBRoot, 'src', 'index.ts')}`, ctx);
      assert.equal(r.allowed, false);
      assert.notEqual(r.rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE,
        'path inside a registered sibling must not trigger OUT_OF_WORKSPACE');
    });
  });

  // ── (3) Per-repo policy — allowed_remotes isolation ──────────────────────

  describe('(3) Per-repo policy — resolveEffectiveConfig loads each repo\'s own policy', () => {
    let repoALoomDir: string;
    let repoBLoomDir: string;
    let engineA: PolicyEngine;
    let engineB: PolicyEngine;

    before(() => {
      repoALoomDir = path.join(repoARoot, '.loom');
      repoBLoomDir = path.join(repoBRoot, '.loom');

      // Repo A allows pushes only to its own origin; repo B allows only its own.
      writePolicyYaml(repoALoomDir, {
        git: { allowed_remotes: ['https://github.com/org/repoA.git'] },
        // Point loom_home to loomHome so resolveEffectiveConfig finds no team config.
        loom_home: loomHome,
      });
      writePolicyYaml(repoBLoomDir, {
        git: { allowed_remotes: ['https://github.com/org/repoB.git'] },
        loom_home: loomHome,
      });

      // Load each engine with its own repo's policy — hermetic env (env:{}) so no
      // process.env bleeds in and makes test non-deterministic.
      engineA = PolicyEngine.load(repoALoomDir, { projectRoot: repoARoot, env: {} });
      engineB = PolicyEngine.load(repoBLoomDir, { projectRoot: repoBRoot, env: {} });
    });

    it('repo A engine has only repo A allowed_remotes', () => {
      const { allowed_remotes } = engineA.policyData.git;
      assert.deepEqual(allowed_remotes, ['https://github.com/org/repoA.git'],
        'repo A policy must not include repo B allowed_remotes');
    });

    it('repo B engine has only repo B allowed_remotes', () => {
      const { allowed_remotes } = engineB.policyData.git;
      assert.deepEqual(allowed_remotes, ['https://github.com/org/repoB.git'],
        'repo B policy must not include repo A allowed_remotes');
    });

    it("repo A's allowed_remote is denied by repo B's engine (no cross-repo loosening)", () => {
      // Use a non-default-protected branch so protected_branches check doesn't interfere.
      const r = engineB.check('git push https://github.com/org/repoA.git HEAD:feat/x');
      assert.equal(r.allowed, false,
        'repo A remote must be blocked by repo B engine — no cross-repo allowlist bleed');
      assert.equal(r.rule, 'git.allowed_remotes');
    });

    it("repo B's allowed_remote is denied by repo A's engine (no cross-repo loosening)", () => {
      const r = engineA.check('git push https://github.com/org/repoB.git HEAD:feat/x');
      assert.equal(r.allowed, false,
        'repo B remote must be blocked by repo A engine — no cross-repo allowlist bleed');
      assert.equal(r.rule, 'git.allowed_remotes');
    });

    it("repo A's engine allows push to its own remote (non-protected branch)", () => {
      // Use a non-default-protected branch so the protected_branches guard doesn't fire.
      const r = engineA.check('git push https://github.com/org/repoA.git HEAD:feat/x');
      assert.equal(r.allowed, true, 'repo A engine must allow push to its own remote');
    });

    it("repo B's engine allows push to its own remote (non-protected branch)", () => {
      const r = engineB.check('git push https://github.com/org/repoB.git HEAD:feat/x');
      assert.equal(r.allowed, true, 'repo B engine must allow push to its own remote');
    });
  });

  // ── (4) Protected-branch guardrails fire per-repo ─────────────────────────

  describe('(4) Protected-branch guardrails fire per repo, unchanged', () => {
    let repoALoomDir2: string;
    let repoBLoomDir2: string;
    let engineA2: PolicyEngine;
    let engineB2: PolicyEngine;

    before(() => {
      repoALoomDir2 = path.join(repoARoot, '.loom');
      repoBLoomDir2 = path.join(repoBRoot, '.loom');

      // Repo A protects 'main'; repo B protects 'release' (different branches).
      writePolicyYaml(repoALoomDir2, {
        git: {
          protected_branches: ['main'],
          agents_must_use_pr: true,
          allowed_remotes: ['https://github.com/org/repoA.git'],
        },
        loom_home: loomHome,
      });
      writePolicyYaml(repoBLoomDir2, {
        git: {
          protected_branches: ['release'],
          agents_must_use_pr: true,
          allowed_remotes: ['https://github.com/org/repoB.git'],
        },
        loom_home: loomHome,
      });

      engineA2 = PolicyEngine.load(repoALoomDir2, { projectRoot: repoARoot, env: {} });
      engineB2 = PolicyEngine.load(repoBLoomDir2, { projectRoot: repoBRoot, env: {} });
    });

    it("repo A engine blocks push to 'main' (its protected branch)", () => {
      const r = engineA2.check(
        'git push https://github.com/org/repoA.git HEAD:main',
      );
      assert.equal(r.allowed, false);
      assert.equal(r.rule, 'git.protected_branches');
    });

    it("repo A engine allows push to 'release' (not protected by repo A)", () => {
      const r = engineA2.check(
        'git push https://github.com/org/repoA.git HEAD:release',
      );
      assert.equal(r.allowed, true,
        "'release' is not a protected branch in repo A — push must be allowed");
    });

    it("repo B engine blocks push to 'release' (its protected branch)", () => {
      const r = engineB2.check(
        'git push https://github.com/org/repoB.git HEAD:release',
      );
      assert.equal(r.allowed, false);
      assert.equal(r.rule, 'git.protected_branches');
    });

    it("repo B engine allows push to 'main' (not protected by repo B)", () => {
      const r = engineB2.check(
        'git push https://github.com/org/repoB.git HEAD:main',
      );
      assert.equal(r.allowed, true,
        "'main' is not a protected branch in repo B — push must be allowed");
    });

    it("repo A's protected_branches do NOT apply to repo B's engine (no cross-repo tightening)", () => {
      // This confirms policy isolation: repo B doesn't inherit repo A's protected_branches.
      const { protected_branches } = engineB2.policyData.git;
      assert.ok(!protected_branches.includes('main'),
        "repo B engine must not include repo A's protected branch 'main'");
    });

    it("repo B's protected_branches do NOT apply to repo A's engine", () => {
      const { protected_branches } = engineA2.policyData.git;
      assert.ok(!protected_branches.includes('release'),
        "repo A engine must not include repo B's protected branch 'release'");
    });

    it('denylists (protected_branches) UNION across team + repo layers within one repo', () => {
      // Simulate: team-config adds 'develop'; repo-layer adds 'main'.
      // The effective protected_branches must be ['develop', 'main'] (union).
      const repoWithTeamLoom = makeTmp('denylist-union');
      const repoWithTeamRoot = makeTmp('denylist-root');
      const loomdir = path.join(repoWithTeamRoot, '.loom');
      try {
        gitInit(repoWithTeamRoot);

        // team-config.yaml in the loom home adds 'develop' to protected_branches.
        fs.writeFileSync(
          path.join(repoWithTeamLoom, 'team-config.yaml'),
          yaml.dump({ git: { protected_branches: ['develop'] } }),
          'utf8',
        );

        // policy.yaml adds 'main' and points loom_home at the team loom home.
        writePolicyYaml(loomdir, {
          git: { protected_branches: ['main'] },
          loom_home: repoWithTeamLoom,
        });

        const unionEngine = PolicyEngine.load(loomdir, { projectRoot: repoWithTeamRoot, env: {} });
        const branches = unionEngine.policyData.git.protected_branches;
        assert.ok(branches.includes('develop'), 'team-layer branch must be in union');
        assert.ok(branches.includes('main'), 'repo-layer branch must be in union');
      } finally {
        try { fs.rmSync(repoWithTeamLoom, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { fs.rmSync(repoWithTeamRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });
  });

  // ── (5) Structural — no writable_repos field (ADR-005) ───────────────────

  describe('(5) Structural confinement — no writable_repos allowlist (ADR-005)', () => {
    it('WorktreeContext has no writable_repos field', () => {
      // Type-level: WorktreeContext is { worktreeRoot, loomHome, audit }.
      // Runtime check: our ctx instance carries no writable_repos property.
      assert.ok(!('writable_repos' in ctx),
        'WorktreeContext must not have a writable_repos field — ADR-005');
    });

    it('WorkerAssignment.worktreeContext has no writable_repos field', () => {
      // Construct a minimal WorkerAssignment.worktreeContext to verify shape.
      const wc: WorkerAssignment['worktreeContext'] = {
        repoSlug: 'repoA',
        worktreePath: repoAWorktree,
      };
      assert.ok(!('writable_repos' in wc),
        'WorkerAssignment.worktreeContext must not have writable_repos — ADR-005');
    });

    it('confinement denial requires no agent-provided signal — ctx alone is sufficient', () => {
      // The guard fires purely from ctx.worktreeRoot vs sibling roots.
      // No writable_repos, no agent flag, no model output involved.
      const r = engine.check(`cp ${repoAWorktree}/a.ts ${repoBRoot}/a.ts`, ctx);
      assert.equal(r.allowed, false, 'structural denial must fire from context alone');
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

  });

  // ── assertConfinedWrite helper ─────────────────────────────────────────────

  describe('assertConfinedWrite helper (assertion seam)', () => {
    it('throws ConfinementViolation for a path outside own worktree', () => {
      const outside = path.join(repoBRoot, 'src', 'index.ts');
      assert.throws(
        () => assertConfinedWrite(outside, repoAWorktree),
        (err: unknown) => err instanceof ConfinementViolation,
        'must throw ConfinementViolation for a path outside own worktree',
      );
    });

    it('throws for a path in a sibling repo root', () => {
      assert.throws(
        () => assertConfinedWrite(repoBRoot, repoAWorktree),
        (err: unknown) => err instanceof ConfinementViolation,
      );
    });

    it('throws for a path traversing out of own worktree', () => {
      // Absolute path that is the repo A root (parent of the worktree) — still outside.
      assert.throws(
        () => assertConfinedWrite(repoARoot, repoAWorktree),
        (err: unknown) => err instanceof ConfinementViolation,
        'parent of own worktree must still be treated as outside',
      );
    });

    it('does NOT throw for a path inside own worktree', () => {
      const inside = path.join(repoAWorktree, 'src', 'main.ts');
      assert.doesNotThrow(
        () => assertConfinedWrite(inside, repoAWorktree),
        'path inside own worktree must not throw',
      );
    });

    it('does NOT throw for own worktree root itself', () => {
      assert.doesNotThrow(
        () => assertConfinedWrite(repoAWorktree, repoAWorktree),
        'own worktree root must not throw',
      );
    });

    it('ConfinementViolation carries targetPath and ownWorktree', () => {
      const outside = path.join(repoBRoot, 'file.ts');
      let caught: ConfinementViolation | null = null;
      try {
        assertConfinedWrite(outside, repoAWorktree);
      } catch (e) {
        if (e instanceof ConfinementViolation) caught = e;
      }
      assert.ok(caught !== null, 'ConfinementViolation must be thrown');
      assert.ok(caught.targetPath.endsWith('file.ts') || caught.targetPath === outside);
      assert.ok(
        caught.ownWorktree === repoAWorktree ||
        caught.ownWorktree === fs.realpathSync(repoAWorktree),
      );
    });
  });
});
