/**
 * Tests for the cross-repo structural access guard (story-057-004).
 *
 * Tests the real PolicyEngine class — not a mock — as required by loom
 * invariant #1.  Every refusal must hold regardless of model-emitted intent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PolicyEngine, type WorktreeContext } from '../../src/guardrails/PolicyEngine.js';
import { PolicySchema } from '../../src/types.js';
import { CROSS_REPO_RULES } from '../../src/retrieval/types.js';
import { registerRepo } from '../../src/home/workspaceManifest.js';
import { gitSafe } from '../../src/orchestrator/git.js';
import type { AuditLog } from '../../src/state/AuditLog.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-guard-${prefix}-`));
  // Resolve symlinks so macOS /var → /private/var doesn't trip comparisons.
  try { return fs.realpathSync(dir); } catch { return dir; }
}

function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed: ${res.output}`);
}

/** Build a PolicyEngine with cross_repo.enabled=true and all other defaults. */
function makeEngine(enabled = true): PolicyEngine {
  return new PolicyEngine(PolicySchema.parse({ cross_repo: { enabled } }));
}

/** Simple audit spy — captures record() calls without a real SQLite DB. */
function makeAuditSpy(): { audit: AuditLog; entries: Parameters<AuditLog['record']>[0][] } {
  const entries: Parameters<AuditLog['record']>[0][] = [];
  const audit = { record: (e: Parameters<AuditLog['record']>[0]) => { entries.push(e); } } as unknown as AuditLog;
  return { audit, entries };
}

// ── Fixture setup ─────────────────────────────────────────────────────────────

describe('PolicyEngine — checkCrossRepoAccess (story-057-004)', () => {
  let loomHome: string;
  let siblingDir: string;     // registered sibling repo root
  let ownWorktree: string;    // agent's own worktree (not registered)
  let outsideDir: string;     // unregistered dir outside workspace (not in protected_paths)
  let innerFile: string;      // a path inside sibling (doesn't need to exist)
  let outsideFile: string;    // a path in outsideDir (not in any protected path)
  let ctx: WorktreeContext;
  let spy: ReturnType<typeof makeAuditSpy>;
  let engine: PolicyEngine;

  before(() => {
    loomHome = makeTmp('home');
    siblingDir = makeTmp('sibling');
    ownWorktree = makeTmp('own');
    outsideDir = makeTmp('outside');

    fs.mkdirSync(loomHome, { recursive: true });
    gitInit(siblingDir);
    registerRepo(loomHome, siblingDir);

    innerFile = path.join(siblingDir, 'src', 'foo.ts');
    // A file in an unregistered directory — not in protected_paths, not in workspace.
    // Using a temp dir prevents the existing filesystem.protected_paths guard from
    // firing before checkCrossRepoAccess gets a chance to apply the OUT_OF_WORKSPACE rule.
    outsideFile = path.join(outsideDir, 'secret.txt');

    spy = makeAuditSpy();
    engine = makeEngine(true);
    ctx = { worktreeRoot: ownWorktree, loomHome, audit: spy.audit };
  });

  after(() => {
    fs.rmSync(loomHome, { recursive: true, force: true });
    fs.rmSync(siblingDir, { recursive: true, force: true });
    fs.rmSync(ownWorktree, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  // ── disabled guard ─────────────────────────────────────────────────────────

  describe('disabled guard (cross_repo.enabled = false)', () => {
    it('returns allowed when enabled=false, even for a raw read into a sibling', () => {
      const disabledEngine = makeEngine(false);
      const r = disabledEngine.check(`cat ${innerFile}`, ctx);
      assert.equal(r.allowed, true, 'disabled guard must not block any command');
    });

    it('returns allowed for out-of-workspace path when disabled', () => {
      const disabledEngine = makeEngine(false);
      // Use an unregistered temp path — not in protected_paths — so the existing
      // filesystem guard doesn't fire and we verify cross-repo guard is skipped.
      const r = disabledEngine.check(`cat ${outsideFile}`, ctx);
      assert.equal(r.allowed, true);
    });
  });

  // ── Rule 1: USE_RETRIEVAL — raw read into sibling ─────────────────────────

  describe('Rule 1 — USE_RETRIEVAL: raw read into sibling root', () => {
    // 'Read' (capital R) is a Claude Code tool name, not a shell program —
    // it is intentionally absent from RAW_READ_PROGRAMS and from this list.
    const readVerbs = ['cat', 'head', 'tail', 'less', 'grep', 'find'];

    for (const verb of readVerbs) {
      it(`"${verb}" targeting a file inside a sibling root is denied`, () => {
        spy.entries.length = 0;
        const cmd = verb === 'grep'
          ? `grep pattern ${innerFile}`
          : `${verb} ${innerFile}`;
        const r = engine.check(cmd, ctx);
        assert.equal(r.allowed, false, `${verb} into sibling must be denied`);
        assert.equal(r.rule, CROSS_REPO_RULES.USE_RETRIEVAL,
          `rule must be ${CROSS_REPO_RULES.USE_RETRIEVAL}`);
      });
    }

    it('denies read of the sibling ROOT directory itself', () => {
      const r = engine.check(`cat ${siblingDir}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.USE_RETRIEVAL);
    });

    it('deny verdict is the same regardless of benign surrounding args (AC-4 structural independence)', () => {
      const plain = engine.check(`cat ${innerFile}`, ctx);
      const withExtra = engine.check(`cat ${innerFile} --this-looks-fine`, ctx);
      assert.equal(plain.allowed, false);
      assert.equal(withExtra.allowed, false);
      assert.equal(plain.rule, withExtra.rule,
        'rule must be identical regardless of extra args — verdict depends only on resolved path');
    });

    it('read of a file inside own worktree is allowed', () => {
      const ownFile = path.join(ownWorktree, 'src', 'main.ts');
      const r = engine.check(`cat ${ownFile}`, ctx);
      assert.equal(r.allowed, true, 'reads within own worktree must be permitted');
    });

    it('loom retrieve invocation is allowed (sanctioned cross-repo route)', () => {
      const r = engine.check('loom retrieve search --repo myrepo --query foo', ctx);
      assert.equal(r.allowed, true, 'loom retrieve must not be blocked by the guard');
    });
  });

  // ── Rule 2: OUT_OF_WORKSPACE — path outside workspace ─────────────────────

  describe('Rule 2 — OUT_OF_WORKSPACE: path outside [worktree ∪ registered repos]', () => {
    it('absolute path outside workspace is denied', () => {
      spy.entries.length = 0;
      // Use outsideFile (unregistered temp dir) so the existing filesystem.protected_paths
      // guard does not fire first — we are asserting the cross-repo rule.
      const r = engine.check(`cat ${outsideFile}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE,
        `rule must be ${CROSS_REPO_RULES.OUT_OF_WORKSPACE}`);
    });

    it('../ traversal resolving outside workspace is denied', () => {
      // From ownWorktree, ../../ goes above the tmpdir parent, outside workspace.
      const r = engine.check('cat ../../etc/passwd', { ...ctx, worktreeRoot: ownWorktree });
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE);
    });

    it('absolute path two levels above own worktree is denied', () => {
      // go up two levels from a nested own-worktree subdirectory
      const nestedCtx = { ...ctx, worktreeRoot: path.join(ownWorktree, 'a', 'b') };
      const r = engine.check(`cat ${path.resolve(ownWorktree, '..', '..', 'etc', 'passwd')}`, nestedCtx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE);
    });

    it('cat with literal ".." resolving outside workspace is denied', () => {
      // Literal ".." from own worktree resolves to the parent directory, which
      // is outside [ownWorktree ∪ siblings] in a temp-dir-based fixture.
      // This exercises the extractArgPaths path for relative tokens that happen
      // to be the bare token "..".
      const r = engine.check('cat ..', { ...ctx, worktreeRoot: ownWorktree });
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE);
    });

    it('cat with "./../../outside" traversal is denied (blocker: ./ prefix was previously missed)', () => {
      // A token like "./../../outside/secret.txt" previously started with "./"
      // and was silently skipped by extractArgPaths, bypassing all three rules.
      const traversal = `./../../${path.basename(outsideDir)}/secret.txt`;
      // Resolve to verify it lands outside the workspace (sanity-check fixture).
      const r = engine.check(`cat ${traversal}`, { ...ctx, worktreeRoot: ownWorktree });
      assert.equal(r.allowed, false,
        './../../ traversal into outside dir must be denied');
    });

    it('cat with "subdir/../../sibling/" traversal is denied (blocker: non-dotdot prefix was previously missed)', () => {
      // A token like "src/../../sibling/secret.ts" starts with "src/" and was
      // silently skipped by the old prefix filter, letting an agent bypass the
      // USE_RETRIEVAL rule by prepending an intermediate directory component.
      const traversal = `src/../../${path.basename(siblingDir)}/secret.ts`;
      const r = engine.check(`cat ${traversal}`, { ...ctx, worktreeRoot: ownWorktree });
      assert.equal(r.allowed, false,
        'relative traversal into a sibling root must be denied');
      assert.equal(r.rule, CROSS_REPO_RULES.USE_RETRIEVAL,
        'traversal into a sibling must trigger USE_RETRIEVAL, not OUT_OF_WORKSPACE');
    });

    it('unregistered absolute path is denied', () => {
      const unregistered = makeTmp('unregistered');
      try {
        const r = engine.check(`cat ${path.join(unregistered, 'file.txt')}`, ctx);
        assert.equal(r.allowed, false);
        assert.equal(r.rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE);
      } finally {
        fs.rmSync(unregistered, { recursive: true, force: true });
      }
    });

    it('path inside sibling root passes OUT_OF_WORKSPACE check (denied by USE_RETRIEVAL instead)', () => {
      // Sibling root IS in workspace — Rule 2 should not fire; Rule 1 fires.
      const r = engine.check(`cat ${innerFile}`, ctx);
      // Denied, but by USE_RETRIEVAL not OUT_OF_WORKSPACE.
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.USE_RETRIEVAL,
        'sibling reads must be denied by USE_RETRIEVAL, not OUT_OF_WORKSPACE');
    });

    it('path resolution canonicalizes symlinks before the check', () => {
      // Create a symlink inside ownWorktree that points outside the workspace.
      const link = path.join(ownWorktree, 'evil-link');
      try {
        // Link to sibling — resolves to sibling root (workspace, but not own worktree)
        fs.symlinkSync(siblingDir, link);
        // cat of a symlink that resolves to a sibling → USE_RETRIEVAL (Rule 1)
        const r = engine.check(`cat ${link}`, ctx);
        assert.equal(r.allowed, false,
          'symlink resolving into a sibling root must be denied');
        // Rule 1 fires because the resolved path is inside a sibling
        assert.equal(r.rule, CROSS_REPO_RULES.USE_RETRIEVAL);
      } finally {
        try { fs.unlinkSync(link); } catch { /* already gone */ }
      }
    });
  });

  // ── Rule 3: READ_ONLY — write outside own worktree ────────────────────────

  describe('Rule 3 — READ_ONLY: write outside own worktree', () => {
    it('cp with destination in a sibling root is denied', () => {
      spy.entries.length = 0;
      const dst = path.join(siblingDir, 'dst.ts');
      const r = engine.check(`cp ${path.join(ownWorktree, 'src.ts')} ${dst}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY,
        `rule must be ${CROSS_REPO_RULES.READ_ONLY}`);
    });

    it('touch targeting a sibling path is denied', () => {
      const r = engine.check(`touch ${path.join(siblingDir, 'newfile.ts')}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('tee targeting a sibling path is denied', () => {
      const r = engine.check(`tee ${path.join(siblingDir, 'output.txt')}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('git commit with -C pointing to sibling is denied', () => {
      // `git -C /sibling commit` — parser puts /sibling in args before 'commit'
      const r = engine.check(`git -C ${siblingDir} commit -m "msg"`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY,
        'git commit targeting a sibling via -C must be denied');
    });

    it('git push targeting a sibling via -C is denied', () => {
      const r = engine.check(`git -C ${siblingDir} push origin main`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('write to an unregistered absolute path outside workspace is denied', () => {
      const unregistered = makeTmp('unregistered-wr');
      try {
        const r = engine.check(`touch ${path.join(unregistered, 'file.ts')}`, ctx);
        // Rule 2 fires first (out of workspace) — also a refusal
        assert.equal(r.allowed, false);
        assert.ok(
          r.rule === CROSS_REPO_RULES.OUT_OF_WORKSPACE || r.rule === CROSS_REPO_RULES.READ_ONLY,
          `expected OUT_OF_WORKSPACE or READ_ONLY, got ${r.rule}`,
        );
      } finally {
        fs.rmSync(unregistered, { recursive: true, force: true });
      }
    });

    it('writes confined to own worktree are permitted', () => {
      const ownFile = path.join(ownWorktree, 'src', 'out.ts');
      const r = engine.check(`touch ${ownFile}`, ctx);
      assert.equal(r.allowed, true, 'writes within own worktree must be allowed');
    });

    it('git commit with no explicit path args in own worktree is permitted', () => {
      // git commit without -C or explicit path args stays in own worktree
      const r = engine.check('git commit -m "fix: something"', ctx);
      assert.equal(r.allowed, true, 'git commit inside own worktree must be allowed');
    });

    it('write outside own worktree verdict is identical regardless of extra benign args (AC-4)', () => {
      const dst = path.join(siblingDir, 'dst.ts');
      const plain = engine.check(`touch ${dst}`, ctx);
      const withExtra = engine.check(`touch ${dst} --verbose`, ctx);
      assert.equal(plain.allowed, false);
      assert.equal(withExtra.allowed, false);
      assert.equal(plain.rule, withExtra.rule);
    });

    it('rm targeting a sibling path is denied', () => {
      // checkRm() fires before checkCrossRepoAccess() so the rule may be
      // filesystem.allowed_write_root rather than cross_repo.read_only; both
      // constitute a structural denial of the write.
      const r = engine.check(`rm ${path.join(siblingDir, 'file.ts')}`, ctx);
      assert.equal(r.allowed, false);
    });

    it('mkdir targeting a sibling path is denied', () => {
      const r = engine.check(`mkdir ${path.join(siblingDir, 'newdir')}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('chmod targeting a sibling path is denied', () => {
      const r = engine.check(`chmod 644 ${path.join(siblingDir, 'file.ts')}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('chown targeting a sibling path is denied', () => {
      const r = engine.check(`chown user:group ${path.join(siblingDir, 'file.ts')}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.READ_ONLY);
    });
  });

  // ── Secret exclusion (AC-3) ───────────────────────────────────────────────

  describe('AC-3 — secret exclusion via structural guard', () => {
    it('cat of .env in a sibling is denied by USE_RETRIEVAL (not raw access)', () => {
      const envFile = path.join(siblingDir, '.env');
      const r = engine.check(`cat ${envFile}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.USE_RETRIEVAL,
        'raw access to .env in a sibling must be denied by USE_RETRIEVAL');
    });

    it('grep of a config fixture in a sibling is denied by USE_RETRIEVAL', () => {
      const secretFile = path.join(siblingDir, 'secrets', 'creds.key');
      const r = engine.check(`grep password ${secretFile}`, ctx);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, CROSS_REPO_RULES.USE_RETRIEVAL);
    });

    it('loom retrieve (sanctioned route) is allowed by the guard (carries its own secret filter)', () => {
      const r = engine.check('loom retrieve read --repo sibling --path .env', ctx);
      assert.equal(r.allowed, true,
        'loom retrieve is the sanctioned route and must not be blocked by the guard');
    });
  });

  // ── Audit logging invariant #5 ────────────────────────────────────────────

  describe('Audit logging — invariant #5', () => {
    it('every USE_RETRIEVAL refusal calls audit.record() before returning', () => {
      const localSpy = makeAuditSpy();
      const localCtx = { ...ctx, audit: localSpy.audit };
      assert.equal(localSpy.entries.length, 0);
      const r = engine.check(`cat ${innerFile}`, localCtx);
      assert.equal(r.allowed, false);
      assert.equal(localSpy.entries.length, 1,
        'exactly one audit entry must be recorded for the refusal');
      const entry = localSpy.entries[0];
      assert.equal(entry.allowed, false);
      assert.equal(entry.policy_rule, CROSS_REPO_RULES.USE_RETRIEVAL);
    });

    it('every OUT_OF_WORKSPACE refusal calls audit.record() before returning', () => {
      const localSpy = makeAuditSpy();
      const localCtx = { ...ctx, audit: localSpy.audit };
      // Use outsideFile so the existing filesystem guard doesn't intercept first.
      const r = engine.check(`cat ${outsideFile}`, localCtx);
      assert.equal(r.allowed, false);
      assert.equal(localSpy.entries.length, 1);
      assert.equal(localSpy.entries[0].policy_rule, CROSS_REPO_RULES.OUT_OF_WORKSPACE);
    });

    it('every READ_ONLY refusal calls audit.record() before returning', () => {
      const localSpy = makeAuditSpy();
      const localCtx = { ...ctx, audit: localSpy.audit };
      const dst = path.join(siblingDir, 'dst.ts');
      const r = engine.check(`touch ${dst}`, localCtx);
      assert.equal(r.allowed, false);
      assert.equal(localSpy.entries.length, 1);
      assert.equal(localSpy.entries[0].policy_rule, CROSS_REPO_RULES.READ_ONLY);
    });

    it('allowed commands do NOT add an audit entry', () => {
      const localSpy = makeAuditSpy();
      const localCtx = { ...ctx, audit: localSpy.audit };
      const ownFile = path.join(ownWorktree, 'src', 'main.ts');
      const r = engine.check(`cat ${ownFile}`, localCtx);
      assert.equal(r.allowed, true);
      assert.equal(localSpy.entries.length, 0, 'allowed commands must not generate audit entries');
    });
  });

  // ── Schema validation ─────────────────────────────────────────────────────

  describe('cross_repo schema validation', () => {
    it('cross_repo.enabled defaults to false when section is omitted', () => {
      const policy = PolicySchema.parse({});
      assert.equal(policy.cross_repo.enabled, false);
    });

    it('cross_repo section with enabled: true is accepted', () => {
      const policy = PolicySchema.parse({ cross_repo: { enabled: true } });
      assert.equal(policy.cross_repo.enabled, true);
    });

    it('cross_repo bounds default to conservative values', () => {
      const policy = PolicySchema.parse({});
      assert.equal(policy.cross_repo.bounds.max_line_window, 200);
      assert.equal(policy.cross_repo.bounds.max_file_bytes, 262144);
      assert.equal(policy.cross_repo.bounds.max_files, 20);
      assert.equal(policy.cross_repo.bounds.max_matches_per_file, 10);
    });

    it('cross_repo.secret_globs default includes expected patterns', () => {
      const policy = PolicySchema.parse({});
      const globs = policy.cross_repo.secret_globs;
      assert.ok(globs.includes('**/.env'), 'secret_globs must include **/.env');
      assert.ok(globs.includes('**/*.key'), 'secret_globs must include **/*.key');
      assert.ok(globs.includes('**/*.tfstate'), 'secret_globs must include **/*.tfstate');
    });

    it('invalid type for cross_repo.enabled is rejected by PolicySchema', () => {
      const result = PolicySchema.safeParse({ cross_repo: { enabled: 'yes' } });
      assert.equal(result.success, false, 'string for enabled must be rejected');
    });

    it('invalid bounds type is rejected by PolicySchema', () => {
      const result = PolicySchema.safeParse({
        cross_repo: { enabled: true, bounds: { max_line_window: 'many' } },
      });
      assert.equal(result.success, false, 'string for max_line_window must be rejected');
    });
  });

  // ── Allowed baseline — guard must not over-block ───────────────────────────

  describe('Allowed baseline — guard must not over-block normal operations', () => {
    it('read of a file inside own worktree is allowed', () => {
      const r = engine.check(`cat ${path.join(ownWorktree, 'src', 'main.ts')}`, ctx);
      assert.equal(r.allowed, true);
    });

    it('write to a path inside own worktree is allowed', () => {
      const r = engine.check(`touch ${path.join(ownWorktree, 'output.ts')}`, ctx);
      assert.equal(r.allowed, true);
    });

    it('git status with no path args is allowed', () => {
      const r = engine.check('git status', ctx);
      assert.equal(r.allowed, true);
    });

    it('git add of a relative path (no absolute path candidate) is allowed', () => {
      const r = engine.check('git add src/foo.ts', ctx);
      assert.equal(r.allowed, true);
    });

    it('check() without ctx (no workspace context) does not apply cross-repo rules', () => {
      // Backwards-compat: existing callers without ctx must not be affected.
      const plainEngine = makeEngine(true);
      // This would be denied with ctx, but without ctx the cross-repo guard is skipped.
      const r = plainEngine.check(`cat ${innerFile}`);
      // The existing filesystem check may or may not allow this; the cross-repo check
      // must not apply (because ctx is undefined).  We just verify it doesn't error.
      assert.ok(typeof r.allowed === 'boolean');
    });

    it('loom retrieve is allowed regardless of sibling registered paths', () => {
      const r = engine.check('loom retrieve search --repo sibling --query "SomeClass"', ctx);
      assert.equal(r.allowed, true);
    });
  });
});
