import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PolicyEngine } from '../guardrails/PolicyEngine.js';

// Default policy — same as loom init produces (main and master are protected,
// --force / --force-with-lease are forbidden, agents_must_use_pr is true).
const engine = new PolicyEngine(PolicyEngine.defaultPolicy());

// __dirname is available: loom-core is "type": "commonjs" (package.json).
// Compiled output lands at packages/loom-core/dist/__tests__/; 4 levels up
// reaches the repo root. The REPO_ROOT sanity check below detects if the
// outDir ever changes, making the wrong path immediately obvious.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ─── release flow: tag push and release branch push are guard-permitted ────
//
// Regression: PolicyEngine.check() is unchanged — no new rule was added.
// Tag refs (v<version>) and release/v* branches do not match the
// protected_branches globs ('main', 'master'), so pushes of these refs pass.
//
// See shared contract §10: "story-006-002 adds a regression test asserting all
// four facts; it MUST NOT edit PolicyEngine.ts."

describe('PolicyEngine — release flow guard regression [story-006-002]', () => {
  // ── AC1: tag refs pass the guard ─────────────────────────────────────────

  it('[AC1] git push origin v1.2.3 is permitted (tag ref does not match protected_branches)', () => {
    const r = engine.check('git push origin v1.2.3');
    assert.equal(r.allowed, true);
  });

  it('[AC1] git push origin v0.0.1 is permitted (lowest semver tag)', () => {
    const r = engine.check('git push origin v0.0.1');
    assert.equal(r.allowed, true);
  });

  it('[AC1] git push origin v1.2.3-rc.1 is permitted (pre-release tag)', () => {
    const r = engine.check('git push origin v1.2.3-rc.1');
    assert.equal(r.allowed, true);
  });

  // ── AC1: release/v* branches pass the guard ──────────────────────────────

  it('[AC1] git push origin release/v1.2.3 is permitted (release branch does not match protected_branches)', () => {
    const r = engine.check('git push origin release/v1.2.3');
    assert.equal(r.allowed, true);
  });

  it('[AC1] git push origin release/v0.0.1 is permitted (release branch glob form)', () => {
    const r = engine.check('git push origin release/v0.0.1');
    assert.equal(r.allowed, true);
  });

  it('[AC1] git push -u origin release/v1.2.3 is permitted (upstream-tracking flag is not forbidden)', () => {
    const r = engine.check('git push -u origin release/v1.2.3');
    assert.equal(r.allowed, true);
  });

  // ── AC2: protected-branch guard stays fully in force ─────────────────────

  it('[AC2] git push origin main is blocked — protected-branch guard still in force', () => {
    const r = engine.check('git push origin main');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.protected_branches');
  });

  it('[AC2] git push origin master is blocked — protected-branch guard still in force', () => {
    const r = engine.check('git push origin master');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.protected_branches');
  });

  // ── AC3: force push stays blocked on any ref ─────────────────────────────

  it('[AC3] git push --force origin v1.2.3 is blocked (--force is forbidden)', () => {
    const r = engine.check('git push --force origin v1.2.3');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('[AC3] git push --force origin release/v1.2.3 is blocked (--force is forbidden)', () => {
    const r = engine.check('git push --force origin release/v1.2.3');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('[AC3] git push --force-with-lease origin v1.2.3 is blocked (--force-with-lease is forbidden)', () => {
    const r = engine.check('git push --force-with-lease origin v1.2.3');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('[AC3] git push --force-with-lease origin release/v1.2.3 is blocked (--force-with-lease is forbidden)', () => {
    const r = engine.check('git push --force-with-lease origin release/v1.2.3');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('[AC3] git push --force-with-lease=HEAD origin v1.2.3 is blocked (=value form is normalised)', () => {
    // checkGit normalises --flag=value → --flag before matching forbidden_flags,
    // so --force-with-lease=HEAD is caught the same as --force-with-lease.
    const r = engine.check('git push --force-with-lease=HEAD origin v1.2.3');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('[AC3] git push --force-with-lease=HEAD origin release/v1.2.3 is blocked', () => {
    const r = engine.check('git push --force-with-lease=HEAD origin release/v1.2.3');
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'git.forbidden_flags');
  });

  it('[AC3] git push --force origin main is blocked (both force + protected-branch guards active)', () => {
    const r = engine.check('git push --force origin main');
    assert.equal(r.allowed, false);
    // Both the force-flag guard and the protected-branch guard would independently
    // block this. PolicyEngine evaluates forbidden_flags first (checkGit order),
    // so the rule is 'git.forbidden_flags'. This assertion is an implementation-
    // stability pin per shared contract §10 — if evaluation order is deliberately
    // changed in the future, update this assertion accordingly.
    assert.equal(r.rule, 'git.forbidden_flags');
  });
});

// ─── post-merge operator step documentation check ─────────────────────────
//
// AC1: The post-merge "git tag v<version> <merge-sha> && git push origin
// v<version>" step is documented in the release command. The tag must point
// at the merged main commit, so it is a separate documented step, not part of
// the loom release command itself.
//
// This test reads the release command source to confirm the documentation is
// present. It does NOT execute the release command.

describe('release command — post-merge operator step is documented [DOC-AC1]', () => {
  // REPO_ROOT is declared at module scope above (4 levels up from dist/__tests__/).
  // The before() hook verifies both the REPO_ROOT resolution (package.json check)
  // and the existence of release.ts so test failures give clear diagnostics.
  const RELEASE_TS = path.join(REPO_ROOT, 'packages', 'loom-cli', 'src', 'commands', 'release.ts');

  let content = '';

  before(() => {
    // Sanity-check REPO_ROOT resolution before testing the file path.
    const repoPackageJson = path.join(REPO_ROOT, 'package.json');
    if (!fs.existsSync(repoPackageJson)) {
      throw new Error(
        `REPO_ROOT resolution is wrong — no package.json at ${REPO_ROOT}. ` +
        `Verify __dirname depth (expected dist/__tests__ → dist → loom-core → packages → repo root).`,
      );
    }
    if (!fs.existsSync(RELEASE_TS)) {
      throw new Error(`release.ts not found at ${RELEASE_TS} — check repo layout`);
    }
    content = fs.readFileSync(RELEASE_TS, 'utf8');
    if (content.length === 0) {
      throw new Error('release.ts must not be empty');
    }
  });

  it('[DOC-AC1] release.ts documents the post-merge git tag step', () => {
    assert.ok(
      /git tag v/.test(content),
      'release.ts must mention "git tag v<version>" for the post-merge tagging step',
    );
  });

  it('[DOC-AC1] release.ts documents that the tag must point at the merged main commit (merge-sha)', () => {
    assert.ok(
      /<merge-sha>/.test(content) || /merge[\s_-]sha/i.test(content) || /merge commit/i.test(content),
      'release.ts must document that the tag must point at the merged main commit',
    );
  });

  it('[DOC-AC1] release.ts documents git push origin v<version> as the post-merge tag push', () => {
    assert.ok(
      /git push origin v/.test(content),
      'release.ts must document "git push origin v<version>" as the post-merge tag push',
    );
  });
});
