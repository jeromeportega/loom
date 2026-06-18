/**
 * Config-assertion tests for story-003-004.
 *
 * Verifies that the mcp workspace was removed from:
 *   1. Root package.json build/test scripts.
 *   2. docs/operations/releasing.md publish table and steps.
 *   3. No npm deprecate or accidental mcp publish step was added (ADR-006).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// __dirname = packages/loom-cli/dist/__tests__
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOT_PKG = path.join(REPO_ROOT, 'package.json');
const RELEASING_MD = path.join(REPO_ROOT, 'docs/operations/releasing.md');

describe('mcp workspace scrub (story-003-004)', () => {
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

  it('docs/operations/releasing.md does not contain loom-mcp package directory reference', () => {
    const content = fs.readFileSync(RELEASING_MD, 'utf8');
    assert.ok(
      !content.includes('loom-mcp'),
      'releasing.md still references packages/loom-mcp'
    );
  });

  it('ADR-006: releasing.md contains no npm deprecate step for @loom-ai/mcp', () => {
    const content = fs.readFileSync(RELEASING_MD, 'utf8');
    assert.ok(
      !content.includes('npm deprecate'),
      'releasing.md must not contain an npm deprecate step (ADR-006: quiet tail, no deprecation notice)'
    );
  });

  it('root package.json build script targets core, web, and loom-ai workspaces', () => {
    const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
    const build: string = pkg.scripts.build;
    assert.ok(build.includes('-w @loom-ai/core'), 'build script must include @loom-ai/core');
    assert.ok(build.includes('-w @loom-ai/web'), 'build script must include @loom-ai/web');
    assert.ok(build.includes('-w loom-ai'), 'build script must include loom-ai');
  });
});
