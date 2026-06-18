import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MAX_ANCESTOR_DEPTH = 12;

// Walk up from __dirname until we find the monorepo root (the directory that
// contains both packages/loom-core and packages/loom-cli). This is explicit
// about what "root" means rather than relying on the doc path coincidentally
// matching at the right ancestor level.
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    if (
      fs.existsSync(path.join(dir, 'packages', 'loom-core')) &&
      fs.existsSync(path.join(dir, 'packages', 'loom-cli'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('could not locate monorepo root (packages/loom-core + packages/loom-cli not found)');
}

function findDoc(relative: string): string {
  return path.join(findRepoRoot(), relative);
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
    // The exact guard-blocked phrase the old runbook used.
    assert.ok(
      !/Commit the bump on `main`|commit .{0,20} directly on `?main`?/i.test(runbook),
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

describe('docs/operations/releasing.md — workspace package parity (story-015-005)', () => {
  let runbook = '';
  let repoRoot = '';

  before(() => {
    repoRoot = findRepoRoot();
    runbook = fs.readFileSync(path.join(repoRoot, 'docs/operations/releasing.md'), 'utf8');
  });

  it('derives the expected package set from the root workspace manifest (no hand-maintained list)', () => {
    // Verify the root manifest declares workspaces, then delegate to resolveWorkspaceNames
    // so there is one code path for resolution — no inline duplication.
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      workspaces?: string[];
    };
    assert.ok(Array.isArray(rootPkg.workspaces), 'root package.json must declare workspaces');

    const expectedNames = resolveWorkspaceNames(repoRoot);
    assert.ok(expectedNames.size > 0, 'at least one workspace package must be found');
  });

  it('package table lists exactly the workspace npm names — no omissions', () => {
    const expectedNames = resolveWorkspaceNames(repoRoot);
    assert.ok(
      expectedNames.size > 0,
      'resolveWorkspaceNames returned an empty set — check workspace glob handling'
    );
    const documentedNames = parseRunbookPackageNames(runbook);
    assert.ok(
      documentedNames.size > 0,
      'parseRunbookPackageNames: no package names found in runbook — check table format'
    );

    const missing = [...expectedNames].filter(n => !documentedNames.has(n));
    assert.deepStrictEqual(
      missing,
      [],
      `Workspace packages absent from the runbook table: ${missing.join(', ')}`
    );
  });

  it('package table lists exactly the workspace npm names — no stale extras', () => {
    const expectedNames = resolveWorkspaceNames(repoRoot);
    assert.ok(
      expectedNames.size > 0,
      'resolveWorkspaceNames returned an empty set — check workspace glob handling'
    );
    const documentedNames = parseRunbookPackageNames(runbook);
    assert.ok(
      documentedNames.size > 0,
      'parseRunbookPackageNames: no package names found in runbook — check table format'
    );

    const phantom = [...documentedNames].filter(n => !expectedNames.has(n));
    assert.deepStrictEqual(
      phantom,
      [],
      `Runbook table entries not in workspace manifest: ${phantom.join(', ')}`
    );
  });
});

/**
 * Resolve npm package names from the root workspace manifest.
 * Handles `<dir>/*` glob patterns by enumerating actual subdirectories,
 * and explicit package paths (no glob) by reading them directly.
 * Asserts the returned set is non-empty to prevent vacuous test passes.
 */
function resolveWorkspaceNames(root: string): Set<string> {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const names = new Set<string>();
  for (const glob of rootPkg.workspaces ?? []) {
    // Handle `<dir>/*` — enumerate all direct subdirectories of <dir>
    const starGlobMatch = /^(.+)\/\*$/.exec(glob);
    if (starGlobMatch) {
      const dir = path.join(root, starGlobMatch[1]);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgJsonPath = path.join(dir, entry.name, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) continue;
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
        if (pkgJson.name) names.add(pkgJson.name);
      }
    } else {
      // Handle explicit package paths (e.g. `packages/loom-core`)
      const pkgJsonPath = path.join(root, glob, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) continue;
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
      if (pkgJson.name) names.add(pkgJson.name);
    }
  }
  assert.ok(
    names.size > 0,
    'resolveWorkspaceNames: no packages found — check workspace glob handling in root package.json'
  );
  return names;
}

/**
 * Parse npm package names from the "Publishable packages" table in releasing.md.
 * Scoped to the section between `## Publishable packages` and the next `##` heading
 * to avoid false matches from other tables in the document.
 * Matches rows where the first column is a backtick-wrapped path and the
 * second column is a backtick-wrapped npm name.
 */
function parseRunbookPackageNames(markdown: string): Set<string> {
  // Slice to the 'Publishable packages' section only, up to the next ## heading or EOF.
  // indexOf is more reliable than a multiline regex lookahead for this boundary.
  const headingIdx = markdown.indexOf('## Publishable packages');
  if (headingIdx === -1) return new Set();
  const afterHeading = markdown.slice(headingIdx);
  const nextHeadingMatch = /\n## /.exec(afterHeading.slice(1));
  const section = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index + 1)
    : afterHeading;

  // Matches: | `packages/...` | `npm-name` | ...
  const rowRe = /^\|\s*`[^`]+`\s*\|\s*`([^`]+)`\s*\|/gm;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(section)) !== null) {
    names.add(m[1]);
  }
  return names;
}

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
