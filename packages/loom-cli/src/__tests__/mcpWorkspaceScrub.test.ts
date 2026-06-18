/**
 * Config-assertion tests for story-003-004.
 *
 * Verifies that the mcp workspace was removed from:
 *   1. Root package.json build/test scripts and workspaces.
 *   2. docs/operations/releasing.md publish table and steps.
 *   3. No npm deprecate/unpublish/dist-tag step was added (ADR-006).
 *   4. No GitHub Actions workflow publishes @loom-ai/mcp.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTracked } from './helpers/git.js';

// __dirname = packages/loom-cli/dist/__tests__
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOT_PKG = path.join(REPO_ROOT, 'package.json');
const RELEASING_MD = path.join(REPO_ROOT, 'docs/operations/releasing.md');

describe('mcp workspace scrub (story-003-004)', () => {
  it('REPO_ROOT resolves to the actual repository root (path sanity guard)', () => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, 'package.json')),
      `REPO_ROOT '${REPO_ROOT}' does not contain package.json — path depth is wrong`
    );
  });

  it('root package.json build script does not reference @loom-ai/mcp', () => {
    const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
    assert.ok(
      !pkg.scripts.build.includes('@loom-ai/mcp'),
      `build script still contains @loom-ai/mcp: ${pkg.scripts.build}`
    );
  });

  it('root package.json test script does not reference @loom-ai/mcp', () => {
    const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
    assert.ok(
      !pkg.scripts.test.includes('@loom-ai/mcp'),
      `test script still contains @loom-ai/mcp: ${pkg.scripts.test}`
    );
  });

  it('root package.json build script targets core, web, and loom-ai workspaces', () => {
    const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
    const build: string = pkg.scripts.build;
    assert.ok(build.includes('-w @loom-ai/core'), 'build script must include @loom-ai/core');
    assert.ok(build.includes('-w @loom-ai/web'), 'build script must include @loom-ai/web');
    assert.ok(build.includes('-w loom-ai'), 'build script must include loom-ai');
  });

  it('root package.json workspaces array does not explicitly list loom-mcp', () => {
    const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
    assert.ok(
      !pkg.workspaces.some((w: string) => w.includes('loom-mcp')),
      'loom-mcp still listed in root workspaces array'
    );
  });

  it('packages/loom-mcp is no longer tracked in version control (ADR-3)', () => {
    assert.ok(
      !isTracked(REPO_ROOT, 'packages/loom-mcp'),
      'packages/loom-mcp still has tracked files — workspaces glob "packages/*" would still resolve it'
    );
  });

  it('docs/operations/releasing.md does not list @loom-ai/mcp in the packages table', () => {
    const content = fs.readFileSync(RELEASING_MD, 'utf8');
    assert.ok(
      !content.includes('@loom-ai/mcp'),
      'releasing.md still references @loom-ai/mcp'
    );
  });

  it('docs/operations/releasing.md does not contain npm publish -w @loom-ai/mcp', () => {
    const content = fs.readFileSync(RELEASING_MD, 'utf8');
    assert.ok(
      !content.includes('publish -w @loom-ai/mcp'),
      'releasing.md still has npm publish step for @loom-ai/mcp'
    );
  });

  it('docs/operations/releasing.md does not reference packages/loom-mcp directory', () => {
    const content = fs.readFileSync(RELEASING_MD, 'utf8');
    assert.ok(
      !content.includes('packages/loom-mcp'),
      'releasing.md still references packages/loom-mcp directory path'
    );
  });

  it('ADR-006: releasing.md contains no public deprecation signals (deprecate/unpublish/dist-tag) for mcp', () => {
    const content = fs.readFileSync(RELEASING_MD, 'utf8');
    assert.ok(!content.includes('npm deprecate'), 'releasing.md must not contain npm deprecate (ADR-006)');
    assert.ok(!content.includes('npm unpublish'), 'releasing.md must not contain npm unpublish (ADR-006)');
    assert.ok(!content.includes('npm dist-tag'), 'releasing.md must not contain npm dist-tag (ADR-006)');
  });

  it('no GitHub Actions workflow publishes @loom-ai/mcp', () => {
    const workflowsDir = path.join(REPO_ROOT, '.github', 'workflows');
    if (!fs.existsSync(workflowsDir)) {
      // No CI workflows exist — publishing is manual per releasing.md. Nothing to check.
      return;
    }
    const files = fs.readdirSync(workflowsDir).filter(
      (f: string) => f.endsWith('.yml') || f.endsWith('.yaml')
    );
    for (const file of files) {
      const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
      assert.ok(
        !content.includes('@loom-ai/mcp'),
        `${file} still references @loom-ai/mcp — remove the mcp publish step`
      );
    }
  });
});

describe('isTracked helper (story-008-002)', () => {
  let tmpRepo: string;

  before(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-git-test-'));
    execFileSync('git', ['init'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'test@loom.ai'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpRepo });
  });

  after(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('AC1: returns false for a path that is neither on disk nor tracked', () => {
    assert.equal(isTracked(tmpRepo, 'packages/loom-mcp'), false);
  });

  it('AC2: returns false for an untracked path even when build artifacts exist on disk', () => {
    const distDir = path.join(tmpRepo, 'packages', 'loom-mcp', 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.js'), 'module.exports = {}');
    assert.equal(
      isTracked(tmpRepo, 'packages/loom-mcp'),
      false,
      'untracked build artifacts on disk must not trigger the removal guard'
    );
  });

  it('AC3: returns true when any file under the path is committed to git', () => {
    const pkgDir = path.join(tmpRepo, 'packages', 'loom-mcp');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"@loom-ai/mcp"}');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'track loom-mcp'], { cwd: tmpRepo });
    assert.equal(
      isTracked(tmpRepo, 'packages/loom-mcp'),
      true,
      'a tracked file under packages/loom-mcp must fail the removal guard'
    );
  });
});
