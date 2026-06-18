import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 12 levels is enough to reach the monorepo root from any nested test dir
const MAX_ANCESTOR_DEPTH = 12;

function findDoc(relative: string): string {
  let dir = __dirname;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate ${relative}`);
}

describe('docs/operations/releasing.md — guard-compatible release flow', () => {
  let runbook = '';

  before(() => {
    const p = findDoc('docs/operations/releasing.md');
    runbook = fs.readFileSync(p, 'utf8');
  });

  it('loads docs/operations/releasing.md', () => {
    assert.ok(runbook.length > 0, 'releasing.md must not be empty');
  });

  it('documents the loom release command', () => {
    assert.ok(
      runbook.includes('loom release'),
      'must mention "loom release" command'
    );
  });

  it('documents the release/v* branch shape', () => {
    assert.ok(
      /release\/v/i.test(runbook),
      'must mention the release/v<version> branch pattern'
    );
  });

  it('documents the post-merge tag step', () => {
    assert.ok(
      /git tag v/.test(runbook),
      'must document the "git tag v<version>" post-merge step'
    );
    assert.ok(
      /git push origin v/.test(runbook),
      'must document the "git push origin v<version>" step'
    );
  });

  it('does NOT instruct committing the bump directly on main', () => {
    // The old guard-blocked path was: "Commit the bump on `main`"
    assert.ok(
      !/commit.{0,40}on.{0,10}`?main`?/i.test(runbook),
      'must not instruct committing the version bump directly on main'
    );
  });

  it('does NOT instruct pushing directly to main', () => {
    // The old guard-blocked path was a code block containing `git push origin main`.
    // A code-fence line starting with "git push origin main" would be instructional.
    assert.ok(
      !/^git push origin main/m.test(runbook),
      'must not contain an instructional "git push origin main" line (guard-blocked path)'
    );
  });

  it('explains the guard-compatibility of the flow', () => {
    assert.ok(
      /guard/i.test(runbook),
      'must mention guard compatibility'
    );
  });
});

describe('docs/capabilities.md — loom release row', () => {
  let caps = '';

  before(() => {
    const p = findDoc('docs/capabilities.md');
    caps = fs.readFileSync(p, 'utf8');
  });

  it('loads docs/capabilities.md', () => {
    assert.ok(caps.length > 0, 'capabilities.md must not be empty');
  });

  it('contains a loom release row', () => {
    assert.ok(
      /loom release/.test(caps),
      'capabilities.md must contain a "loom release" row'
    );
  });

  it('documents loom release as guard-compatible', () => {
    const idx = caps.indexOf('loom release');
    assert.ok(idx !== -1, '"loom release" must be present');
    const surrounding = caps.slice(Math.max(0, idx - 100), idx + 500);
    assert.ok(
      /guard/i.test(surrounding) || /release\/v/.test(surrounding),
      '"loom release" entry must mention guard-compatibility or the release/v* branch'
    );
  });
});
