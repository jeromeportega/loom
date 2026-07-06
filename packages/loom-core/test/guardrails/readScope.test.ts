/**
 * Tests for the read-scope path resolution matcher (story-067-002).
 *
 * Covers checkReadScope and checkReadScopeCommand in PolicyEngine.
 * All tests use real temp directories so fs.realpathSync has real inodes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PolicyEngine, type ReadScopeContext } from '../../src/guardrails/PolicyEngine.js';
import { PolicySchema } from '../../src/types.js';
import type { AuditLog } from '../../src/state/AuditLog.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rs-${prefix}-`));
  try { return fs.realpathSync(dir); } catch { return dir; }
}

function makeAuditSpy(): { audit: AuditLog; entries: Parameters<AuditLog['record']>[0][] } {
  const entries: Parameters<AuditLog['record']>[0][] = [];
  const audit = {
    record: (e: Parameters<AuditLog['record']>[0]) => { entries.push(e); },
  } as unknown as AuditLog;
  return { audit, entries };
}

function makeEngine(): PolicyEngine {
  return new PolicyEngine(PolicySchema.parse({}));
}

// ── Fixture layout ─────────────────────────────────────────────────────────────
//
//   /tmp/loom-rs-parent-XXX/
//     worktree/          ← worktreeRoot (agent's worktree)
//       src/
//         file.ts        ← in-scope file
//       link-out         ← symlink → /tmp/loom-rs-out-XXX/secret.txt
//     reporoot/          ← readRoot  (repo root; distinct subtree)
//       shared.ts        ← in-scope via readRoot
//     outsider/          ← completely out of scope
//       secret.txt

describe('PolicyEngine — checkReadScope (story-067-002)', () => {
  let parentDir: string;
  let worktreeRoot: string;
  let readRoot: string;
  let outsideDir: string;
  let spy: ReturnType<typeof makeAuditSpy>;
  let engine: PolicyEngine;
  let ctx: ReadScopeContext;

  before(() => {
    parentDir = makeTmp('parent');
    worktreeRoot = path.join(parentDir, 'worktree');
    readRoot = path.join(parentDir, 'reporoot');
    outsideDir = makeTmp('out');

    fs.mkdirSync(path.join(worktreeRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, 'src', 'file.ts'), '');
    fs.mkdirSync(readRoot, { recursive: true });
    fs.writeFileSync(path.join(readRoot, 'shared.ts'), '');

    // symlink inside worktree pointing to outsideDir/secret.txt
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), '');
    fs.symlinkSync(
      path.join(outsideDir, 'secret.txt'),
      path.join(worktreeRoot, 'link-out'),
    );

    spy = makeAuditSpy();
    engine = makeEngine();
    ctx = { worktreeRoot, readRoot, audit: spy.audit, agentId: 'test-agent' };
  });

  after(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  // (1) In-scope absolute path under worktreeRoot → allowed
  it('(1) in-scope path under worktreeRoot is allowed', () => {
    const target = path.join(worktreeRoot, 'src', 'file.ts');
    spy.entries.length = 0;
    const result = engine.checkReadScope(target, ctx);
    assert.equal(result.allowed, true);
    assert.equal(spy.entries.length, 0, 'no audit entry on allow');
  });

  // (2) In-scope absolute path under readRoot → allowed (two-root union)
  it('(2) in-scope path under readRoot (repo root) is allowed', () => {
    const target = path.join(readRoot, 'shared.ts');
    spy.entries.length = 0;
    const result = engine.checkReadScope(target, ctx);
    assert.equal(result.allowed, true);
    assert.equal(spy.entries.length, 0, 'no audit entry on allow');
  });

  // (3) Out-of-scope absolute path → denied with correct rule
  it('(3) out-of-scope absolute path is denied', () => {
    const target = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    const result = engine.checkReadScope(target, ctx);
    assert.equal(result.allowed, false);
    assert.equal(result.rule, 'filesystem.allowed_read_root');
    assert.equal(spy.entries.length, 1, 'audit entry recorded for denial');
    assert.equal(spy.entries[0].action, 'read_scope_denied');
    assert.equal(spy.entries[0].policy_rule, 'filesystem.allowed_read_root');
    assert.equal(spy.entries[0].allowed, false);
    assert.equal(spy.entries[0].agent_id, 'test-agent');
  });

  // (4) Common PARENT of worktreeRoot and readRoot → denied
  //   Proves it admits the union, never the lowest common ancestor
  it('(4) common parent directory of worktreeRoot and readRoot is denied', () => {
    spy.entries.length = 0;
    const result = engine.checkReadScope(parentDir, ctx);
    assert.equal(result.allowed, false,
      'common parent must not be admitted — only the explicit two-root union');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });

  // (5) ../- escaping relative path that resolves outside scope → denied
  it('(5) ../-escaping path that resolves outside scope is denied', () => {
    // From worktreeRoot: ../../outsideDir/secret.txt
    const relEscape = path.join('..', '..', path.basename(outsideDir), 'secret.txt');
    // We pass this as the targetPath; resolveArg resolves it against worktreeRoot
    spy.entries.length = 0;
    const result = engine.checkReadScope(relEscape, ctx);
    assert.equal(result.allowed, false, '../-escaping path outside scope must be denied');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });

  // (6) ../- escaping path that resolves back INTO scope → allowed
  //   Confirms it is genuinely resolving, not string-matching ".."
  it('(6) ../-escaping path that resolves back into scope is allowed', () => {
    // From worktreeRoot/src: ../src/file.ts → still under worktreeRoot
    const relIn = path.join('src', '..', 'src', 'file.ts');
    spy.entries.length = 0;
    const result = engine.checkReadScope(relIn, ctx);
    assert.equal(result.allowed, true,
      'relative path that resolves inside scope must be allowed');
  });

  // (7) Symlink inside worktree pointing OUT of scope → denied
  //   Proves fs.realpathSync canonicalizes the target before compare
  it('(7) symlink inside worktree pointing outside scope is denied', () => {
    const linkPath = path.join(worktreeRoot, 'link-out');
    spy.entries.length = 0;
    const result = engine.checkReadScope(linkPath, ctx);
    assert.equal(result.allowed, false,
      'symlink target outside scope must be denied (realpathSync follows the link)');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });

  // (8) Not-yet-existing in-scope path → allowed via path.resolve fallback
  //   Note: realpathSync only follows existing paths; non-existent paths fall back
  //   to path.resolve (lexical normalization). Acceptable for a read control.
  it('(8) not-yet-existing in-scope path is allowed via path.resolve fallback', () => {
    const nonExistent = path.join(worktreeRoot, 'does-not-exist', 'new-file.ts');
    spy.entries.length = 0;
    const result = engine.checkReadScope(nonExistent, ctx);
    assert.equal(result.allowed, true,
      'non-existent path inside scope must be allowed via lexical fallback');
  });

  // (9) Empty path → treated as cwd (worktreeRoot), in-scope, allowed
  it('(9) empty path is treated as worktreeRoot and allowed', () => {
    spy.entries.length = 0;
    const result = engine.checkReadScope('', ctx);
    assert.equal(result.allowed, true, 'empty path maps to worktreeRoot and is in-scope');
  });

  // Trailing slash on ctx roots — isUnder must still work correctly
  it('trailing slash on worktreeRoot/readRoot in ctx does not break in-scope check', () => {
    const trailingCtx: ReadScopeContext = {
      ...ctx,
      worktreeRoot: worktreeRoot + '/',
      readRoot: readRoot + '/',
    };
    const inFile = path.join(worktreeRoot, 'src', 'file.ts');
    spy.entries.length = 0;
    assert.equal(engine.checkReadScope(inFile, trailingCtx).allowed, true,
      'trailing slash on worktreeRoot must not cause false denials');

    const sharedFile = path.join(readRoot, 'shared.ts');
    spy.entries.length = 0;
    assert.equal(engine.checkReadScope(sharedFile, trailingCtx).allowed, true,
      'trailing slash on readRoot must not cause false denials');
  });
});

// ── checkReadScopeCommand ──────────────────────────────────────────────────────

describe('PolicyEngine — checkReadScopeCommand (story-067-002)', () => {
  let worktreeRoot: string;
  let readRoot: string;
  let outsideDir: string;
  let spy: ReturnType<typeof makeAuditSpy>;
  let engine: PolicyEngine;
  let ctx: ReadScopeContext;

  before(() => {
    worktreeRoot = makeTmp('cmd-wt');
    readRoot = makeTmp('cmd-rr');
    outsideDir = makeTmp('cmd-out');

    fs.writeFileSync(path.join(worktreeRoot, 'in.ts'), '');
    fs.writeFileSync(path.join(readRoot, 'shared.ts'), '');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), '');

    // symlink inside worktree pointing to outsideDir/secret.txt
    fs.symlinkSync(
      path.join(outsideDir, 'secret.txt'),
      path.join(worktreeRoot, 'link-out'),
    );

    spy = makeAuditSpy();
    engine = makeEngine();
    ctx = { worktreeRoot, readRoot, audit: spy.audit };
  });

  after(() => {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    fs.rmSync(readRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const readers = ['grep', 'rg', 'find', 'cat', 'ls'];

  for (const tool of readers) {
    it(`"${tool}" with out-of-scope path arg is denied`, () => {
      const outFile = path.join(outsideDir, 'secret.txt');
      // grep and rg require a pattern before file args; other tools take paths directly.
      const cmd = (tool === 'grep' || tool === 'rg') ? `${tool} pattern ${outFile}` : `${tool} ${outFile}`;
      spy.entries.length = 0;
      const result = engine.checkReadScopeCommand(cmd, ctx);
      assert.equal(result.allowed, false, `${tool} with out-of-scope path must be denied`);
      assert.equal(result.rule, 'filesystem.allowed_read_root');
      assert.equal(spy.entries.length, 1, 'audit entry recorded');
      assert.equal(spy.entries[0].action, 'read_scope_denied');
    });

    it(`"${tool}" with in-scope path arg (worktreeRoot) is allowed`, () => {
      const inFile = path.join(worktreeRoot, 'in.ts');
      const cmd = (tool === 'grep' || tool === 'rg') ? `${tool} pattern ${inFile}` : `${tool} ${inFile}`;
      spy.entries.length = 0;
      const result = engine.checkReadScopeCommand(cmd, ctx);
      assert.equal(result.allowed, true, `${tool} with in-scope path must be allowed`);
    });

    it(`"${tool}" with in-scope path arg (readRoot) is allowed`, () => {
      const sharedFile = path.join(readRoot, 'shared.ts');
      const cmd = (tool === 'grep' || tool === 'rg') ? `${tool} pattern ${sharedFile}` : `${tool} ${sharedFile}`;
      spy.entries.length = 0;
      const result = engine.checkReadScopeCommand(cmd, ctx);
      assert.equal(result.allowed, true, `${tool} with readRoot path must be allowed`);
    });
  }

  it('command with multiple path args returns first denial', () => {
    const inFile = path.join(worktreeRoot, 'in.ts');
    const outFile = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    // in-scope first, then out-of-scope
    const result = engine.checkReadScopeCommand(`cat ${inFile} ${outFile}`, ctx);
    assert.equal(result.allowed, false, 'must deny when any arg is out-of-scope');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
    // only one audit entry — stopped at first denial
    assert.equal(spy.entries.length, 1);
  });

  it('non-reader command is allowed regardless of path', () => {
    const outFile = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`cp ${outFile} /tmp/x`, ctx);
    assert.equal(result.allowed, true, 'non-reader command is not subject to read-scope check');
  });

  // grep/rg: first positional arg is pattern, not a file — must not be denied
  // even when the pattern text looks like an absolute out-of-scope path.
  it('grep with an absolute-path-shaped pattern and in-scope file is allowed', () => {
    const inFile = path.join(worktreeRoot, 'in.ts');
    // Pattern "/usr/local/lib/node_modules" looks like an out-of-scope path
    // but is just a regex pattern — the actual file being read is in scope.
    const cmd = `grep /usr/local/lib/node_modules ${inFile}`;
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(cmd, ctx);
    assert.equal(result.allowed, true,
      'grep pattern must not be checked as a file path — only file args matter');
  });

  it('rg with an absolute-path-shaped pattern and in-scope file is allowed', () => {
    const inFile = path.join(worktreeRoot, 'in.ts');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`rg /etc/passwd ${inFile}`, ctx);
    assert.equal(result.allowed, true,
      'rg pattern must not be checked as a file path');
  });

  // grep with out-of-scope FILE (after the pattern) must still be denied
  it('grep with in-scope pattern but out-of-scope file arg is denied', () => {
    const outFile = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`grep somepattern ${outFile}`, ctx);
    assert.equal(result.allowed, false,
      'grep out-of-scope file arg must be denied even when pattern is innocuous');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });

  // Symlink inside worktree pointing outside scope — command path must be denied
  it('symlink arg inside worktree pointing outside scope is denied via checkReadScopeCommand', () => {
    const linkPath = path.join(worktreeRoot, 'link-out');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`cat ${linkPath}`, ctx);
    assert.equal(result.allowed, false,
      'symlink target outside scope must be denied (resolveArg follows the link)');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });

  // Extended READ_TOOLS: head, tail (no script-prefix arg)
  for (const tool of ['head', 'tail']) {
    it(`"${tool}" with out-of-scope path is denied`, () => {
      const outFile = path.join(outsideDir, 'secret.txt');
      spy.entries.length = 0;
      const result = engine.checkReadScopeCommand(`${tool} ${outFile}`, ctx);
      assert.equal(result.allowed, false, `${tool} out-of-scope path must be denied`);
      assert.equal(result.rule, 'filesystem.allowed_read_root');
    });

    it(`"${tool}" with in-scope path is allowed`, () => {
      const inFile = path.join(worktreeRoot, 'in.ts');
      spy.entries.length = 0;
      const result = engine.checkReadScopeCommand(`${tool} ${inFile}`, ctx);
      assert.equal(result.allowed, true, `${tool} in-scope path must be allowed`);
    });
  }

  // awk/sed: first positional is a script/expression, second is the file.
  // The script may look like an absolute path — must not cause false denials.
  it('awk with out-of-scope file arg (after script) is denied', () => {
    const outFile = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`awk '{print}' ${outFile}`, ctx);
    assert.equal(result.allowed, false, 'awk with out-of-scope file must be denied');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });

  it('awk with in-scope file arg (after script) is allowed', () => {
    const inFile = path.join(worktreeRoot, 'in.ts');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`awk '{print}' ${inFile}`, ctx);
    assert.equal(result.allowed, true, 'awk with in-scope file must be allowed');
  });

  it('awk with absolute-path-shaped script expression and in-scope file is allowed', () => {
    const inFile = path.join(worktreeRoot, 'in.ts');
    spy.entries.length = 0;
    // Script "/usr/bin/" looks like an out-of-scope path but is an awk program —
    // must not be checked as a file path.
    const result = engine.checkReadScopeCommand(`awk /usr/bin/ ${inFile}`, ctx);
    assert.equal(result.allowed, true,
      'awk script expression must not be checked as a file path');
  });

  it('sed with out-of-scope file arg (after expression) is denied', () => {
    const outFile = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`sed 's/x/y/' ${outFile}`, ctx);
    assert.equal(result.allowed, false, 'sed with out-of-scope file must be denied');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });

  it('sed with absolute-path-shaped expression and in-scope file is allowed', () => {
    const inFile = path.join(worktreeRoot, 'in.ts');
    spy.entries.length = 0;
    // Expression "/usr/local/d" looks like an out-of-scope path but is a sed command.
    const result = engine.checkReadScopeCommand(`sed /usr/local/d ${inFile}`, ctx);
    assert.equal(result.allowed, true,
      'sed expression must not be checked as a file path');
  });

  // tee is a WRITE tool — it must not be subject to the read-scope check.
  it('tee with out-of-scope path is NOT denied (tee is a write tool, not a read tool)', () => {
    const outFile = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`tee ${outFile}`, ctx);
    assert.equal(result.allowed, true,
      'tee writes to its path args; read-scope check must not block it');
  });

  // Trailing slash on ctx roots — isUnder must still work correctly
  it('trailing slash on worktreeRoot in ctx does not break in-scope check', () => {
    const trailingCtx: ReadScopeContext = {
      ...ctx,
      worktreeRoot: worktreeRoot + '/',
      readRoot: readRoot + '/',
    };
    const inFile = path.join(worktreeRoot, 'in.ts');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`cat ${inFile}`, trailingCtx);
    assert.equal(result.allowed, true,
      'trailing slash on ctx roots must not cause false denials');
  });
});

// ── cross_repo.enabled decoupling ─────────────────────────────────────────────

describe('PolicyEngine — read scope active when cross_repo.enabled is false', () => {
  let worktreeRoot: string;
  let readRoot: string;
  let outsideDir: string;
  let spy: ReturnType<typeof makeAuditSpy>;
  let engine: PolicyEngine;
  let ctx: ReadScopeContext;

  before(() => {
    worktreeRoot = makeTmp('decoupled-wt');
    readRoot = makeTmp('decoupled-rr');
    outsideDir = makeTmp('decoupled-out');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), '');

    spy = makeAuditSpy();
    // Explicitly set cross_repo.enabled: false
    engine = new PolicyEngine(PolicySchema.parse({ cross_repo: { enabled: false } }));
    ctx = { worktreeRoot, readRoot, audit: spy.audit };
  });

  after(() => {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    fs.rmSync(readRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('checkReadScope denies out-of-scope path even when cross_repo.enabled is false', () => {
    const outFile = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    const result = engine.checkReadScope(outFile, ctx);
    assert.equal(result.allowed, false,
      'read scope must be enforced regardless of cross_repo.enabled');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });

  it('checkReadScopeCommand denies out-of-scope path even when cross_repo.enabled is false', () => {
    const outFile = path.join(outsideDir, 'secret.txt');
    spy.entries.length = 0;
    const result = engine.checkReadScopeCommand(`cat ${outFile}`, ctx);
    assert.equal(result.allowed, false,
      'read scope command check must be enforced regardless of cross_repo.enabled');
    assert.equal(result.rule, 'filesystem.allowed_read_root');
  });
});
