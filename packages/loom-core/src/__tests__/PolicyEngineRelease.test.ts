import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PolicyEngine } from '../guardrails/PolicyEngine.js';

// Default policy — same as loom init produces (main and master are protected,
// --force / --force-with-lease are forbidden, agents_must_use_pr is true).
const engine = new PolicyEngine(PolicyEngine.defaultPolicy());

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

  it('[AC3] git push --force origin main is blocked (force + protected branch — flag check fires first)', () => {
    const r = engine.check('git push --force origin main');
    assert.equal(r.allowed, false);
    // PolicyEngine evaluates forbidden_flags before protected_branches; the rule
    // priority is a documented contract (flag checks precede branch checks in
    // checkGit). Pinning it here ensures a refactor does not silently swap the order.
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
  // Resolve from __dirname (CJS; compiled to packages/loom-core/dist/__tests__/).
  // 4 levels up: dist/__tests__ → dist → loom-core → packages → repo root.
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
  const RELEASE_TS = path.join(REPO_ROOT, 'packages', 'loom-cli', 'src', 'commands', 'release.ts');

  let content = '';

  before(() => {
    assert.ok(
      fs.existsSync(RELEASE_TS),
      `release.ts not found at ${RELEASE_TS} — check repo layout`,
    );
    content = fs.readFileSync(RELEASE_TS, 'utf8');
    assert.ok(content.length > 0, 'release.ts must not be empty');
  });

  it('[DOC-AC1] release.ts documents the post-merge git tag step', () => {
    assert.ok(
      /git tag v/.test(content),
      'release.ts must mention "git tag v<version>" for the post-merge tagging step',
    );
  });

  it('[DOC-AC1] release.ts documents that the tag must point at the merged main commit (merge-sha)', () => {
    assert.ok(
      /<merge-sha>/.test(content) || /merge.sha/i.test(content) || /merge commit/i.test(content),
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
