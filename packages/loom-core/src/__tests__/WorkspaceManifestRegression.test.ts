/**
 * Cross-cutting regression suite for the workspace manifest epic (epic-054).
 *
 * Invariants verified here:
 *   NFR-3   — workspaceManifest.ts, dirLock.ts, and resolveActiveRepo.ts import NOTHING from guardrails/
 *   POLICY  — PolicyEngine structural checks (forbidden command, protected branch) are untouched
 *   PATHS   — prepareRepoState returns identical RepoStatePaths before and after manifest is present
 *   GUARD   — observe-and-record in prepareRepoState never blocks a command even when the manifest errors
 *
 * Note: __dirname is valid here because loom-core has "type": "commonjs" in package.json.
 * TypeScript emits CJS (module: Node16 + commonjs package type), so __dirname is defined at runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicyEngine } from '../guardrails/PolicyEngine.js';
import { prepareRepoState } from '../home/prepareRepoState.js';
import { manifestPath } from '../home/workspaceManifest.js';

// From dist/__tests__/ the package src is two levels up:
//   dist/__tests__  →  dist  →  <package-root>  →  src
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const LOOM_CORE_SRC = path.join(PACKAGE_ROOT, 'src');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-manifest-regression-'));
}

function makeProjectRoot(parent: string): string {
  const proj = path.join(parent, 'project');
  fs.mkdirSync(path.join(proj, '.loom'), { recursive: true });
  // Write a minimal valid (but empty) policy so any YAML parser sees a valid document.
  fs.writeFileSync(path.join(proj, '.loom', 'policy.yaml'), '{}\n', 'utf8');
  return proj;
}

// ── NFR-3: guardrail import boundary ─────────────────────────────────────────
//
// The manifest modules — workspaceManifest.ts, dirLock.ts, and resolveActiveRepo.ts —
// must NEVER import from the guardrails/ subtree. Guardrails are structural
// policy checks; mixing them into the manifest layer would create a coupling
// that could silently weaken or bypass policy enforcement.

describe('NFR-3 — manifest modules must not import from guardrails/', () => {
  // All three manifest-layer source files are checked. Adding a fourth file
  // here is the only change needed when a new manifest module is introduced.
  const MANIFEST_MODULES = [
    path.join(LOOM_CORE_SRC, 'home', 'workspaceManifest.ts'),
    path.join(LOOM_CORE_SRC, 'home', 'dirLock.ts'),
    path.join(LOOM_CORE_SRC, 'home', 'resolveActiveRepo.ts'),
  ];

  // Matches static ES import, CommonJS require(), and dynamic import() referencing guardrails/.
  const GUARDRAILS_IMPORT_RE = /(?:from|require|import)\s*\(?['"][^'"]*\/guardrails(?:\/|['"])/;

  for (const modPath of MANIFEST_MODULES) {
    const label = path.relative(LOOM_CORE_SRC, modPath);

    it(`${label} contains no imports from guardrails/`, () => {
      assert.ok(fs.existsSync(modPath), `source file must exist: ${modPath}`);

      const lines = fs.readFileSync(modPath, 'utf8').split('\n');
      const violations: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (GUARDRAILS_IMPORT_RE.test(lines[i])) {
          violations.push(`line ${i + 1}: ${lines[i].trim()}`);
        }
      }

      assert.deepEqual(
        violations,
        [],
        `NFR-3 violation — ${label} must not import from guardrails/:\n` +
          violations.map(v => `  ${v}`).join('\n'),
      );
    });
  }
});

// ── PolicyEngine structural checks (NFR-3 / Key Invariants 1 & 2) ────────────
//
// These assertions prove the policy engine's structural checks are untouched by
// the manifest introduction. The checks must remain purely structural (no LLM
// involvement): a forbidden command must always be blocked regardless of what
// the manifest layer does.

describe('PolicyEngine structural checks — unchanged after manifest introduction', () => {
  const engine = new PolicyEngine(PolicyEngine.defaultPolicy());

  it('blocks git push --force (Key Invariant 2: forbidden flag)', () => {
    const r = engine.check('git push --force');
    assert.equal(r.allowed, false, 'must not be allowed');
    assert.equal(r.rule, 'git.forbidden_flags', 'must cite the forbidden-flags rule');
  });

  it('blocks git reset --hard HEAD (Key Invariant 2: forbidden flag)', () => {
    const r = engine.check('git reset --hard HEAD');
    assert.equal(r.allowed, false, 'must not be allowed');
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('blocks git push origin main (Key Invariant 1: protected-branch isolation)', () => {
    const r = engine.check('git push origin main');
    assert.equal(r.allowed, false, 'must not be allowed');
    assert.equal(r.rule, 'git.protected_branches', 'must cite the protected-branches rule');
  });

  it('blocks git push origin master (Key Invariant 1: protected-branch isolation)', () => {
    const r = engine.check('git push origin master');
    assert.equal(r.allowed, false, 'must not be allowed');
    assert.equal(r.rule, 'git.protected_branches');
  });

  it('allows git push origin story/story-054-005 (worker story-branch push is permitted)', () => {
    const r = engine.check('git push origin story/story-054-005');
    assert.equal(r.allowed, true, 'story-branch push must be allowed');
  });

  it('blocks rm -rf ~/.ssh (filesystem protected-path rule)', () => {
    const r = engine.check('rm -rf ~/.ssh');
    assert.equal(r.allowed, false, 'must not be allowed');
    assert.equal(r.rule, 'filesystem.protected_paths');
  });
});

// ── prepareRepoState path invariant ──────────────────────────────────────────
//
// Proves that introducing the workspace manifest (via resolveActiveRepo in
// prepareRepoState) leaves the returned RepoStatePaths byte-identical across
// calls. The manifest is an observe-and-record side-effect; it must not alter
// the paths used for the database or namespace.

describe('prepareRepoState — returned paths unchanged by manifest introduction', () => {
  it('dbPath and namespaceDir are identical before and after workspace.yaml is created', () => {
    const tmp = tmpDir();
    const loomHome = path.join(tmp, 'loom-home');
    const proj = makeProjectRoot(tmp);

    try {
      const policy = { loom_home: loomHome };

      // First call: workspace.yaml does not yet exist.
      assert.ok(!fs.existsSync(manifestPath(loomHome)), 'precondition: no workspace.yaml');
      const paths1 = prepareRepoState(proj, policy);
      assert.ok(fs.existsSync(manifestPath(loomHome)), 'workspace.yaml must be created on first call');

      // Second call: workspace.yaml is now present.
      const paths2 = prepareRepoState(proj, policy);

      assert.ok(paths1.dbPath, 'first call must return a non-empty dbPath');
      assert.ok(paths1.namespaceDir, 'first call must return a non-empty namespaceDir');
      assert.equal(paths2.dbPath, paths1.dbPath, 'dbPath must be unchanged after manifest is present');
      assert.equal(paths2.namespaceDir, paths1.namespaceDir, 'namespaceDir must be unchanged');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dbPath is inside loom-home (not inside projectRoot) — namespace isolation preserved', () => {
    const tmp = tmpDir();
    const loomHome = path.join(tmp, 'loom-home');
    const proj = makeProjectRoot(tmp);

    try {
      const paths = prepareRepoState(proj, { loom_home: loomHome });
      assert.ok(
        paths.dbPath.startsWith(loomHome),
        `dbPath must be under loom-home; got: ${paths.dbPath}`,
      );
      assert.ok(
        paths.namespaceDir.startsWith(loomHome),
        `namespaceDir must be under loom-home; got: ${paths.namespaceDir}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── observe-and-record safety ─────────────────────────────────────────────────
//
// The resolveActiveRepo call inside prepareRepoState is wrapped in try/catch.
// Even if the manifest is corrupted or the home dir is unwriteable, the command
// must complete normally — the manifest failure must never propagate.

describe('prepareRepoState — observe-and-record must not block commands', () => {
  it('does not throw even when loom-home is read-only (manifest write fails)', () => {
    // chmod has no effect when running as root; skip to avoid a vacuous pass.
    if (process.getuid?.() === 0) return;

    const tmp = tmpDir();
    const loomHome = path.join(tmp, 'loom-home');
    const proj = makeProjectRoot(tmp);

    try {
      const policy = { loom_home: loomHome };

      // First call initialises loom-home normally.
      const paths1 = prepareRepoState(proj, policy);

      // Make loom-home read-only so subsequent manifest writes fail.
      fs.chmodSync(loomHome, 0o555);

      try {
        // Second call: manifest write will fail, but prepareRepoState must not throw.
        assert.doesNotThrow(
          () => prepareRepoState(proj, policy),
          'prepareRepoState must not propagate manifest errors to the caller',
        );
      } finally {
        fs.chmodSync(loomHome, 0o755); // Restore so cleanup succeeds.
      }

      // The paths must still be valid.
      const paths2 = prepareRepoState(proj, policy);
      assert.equal(paths2.dbPath, paths1.dbPath, 'dbPath unchanged even after manifest write failure');
    } finally {
      try { fs.chmodSync(loomHome, 0o755); } catch { /* best-effort */ }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
