import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRepoStatePaths } from '../../src/home/repoState.js';
import { computeRepoSlug } from '../../src/home/repoSlug.js';
import { resolveLoomHomePath } from '../../src/home/resolveLoomHomePath.js';
import { GITIGNORE_CONTENT } from '../../src/home/ensureLoomHome.js';

// ── helpers ────────────────────────────────────────────────────────────────────

const FAKE_PROJECT = '/tmp/loom-test/my-project';
const FAKE_LOOM_HOME = '/tmp/loom-test/loom-home';

function policyWith(loomHome: string): { loom_home: string } {
  return { loom_home: loomHome };
}

// ── AC1/AC2: resolveRepoStatePaths returns correct structure ───────────────────

describe('resolveRepoStatePaths — returns paths rooted at loom-home namespace', () => {
  it('namespaceDir is under <loomHome>/repos/<slug>', () => {
    const policy = policyWith(FAKE_LOOM_HOME);
    const { namespaceDir } = resolveRepoStatePaths(FAKE_PROJECT, policy);
    assert.ok(
      namespaceDir.startsWith(path.join(FAKE_LOOM_HOME, 'repos') + path.sep),
      `namespaceDir must be under <loomHome>/repos/: ${namespaceDir}`,
    );
  });

  it('dbPath === path.join(namespaceDir, "loom.db")', () => {
    const policy = policyWith(FAKE_LOOM_HOME);
    const { namespaceDir, dbPath } = resolveRepoStatePaths(FAKE_PROJECT, policy);
    assert.equal(dbPath, path.join(namespaceDir, 'loom.db'));
  });

  it('planningRoot === path.join(namespaceDir, "planning")', () => {
    const policy = policyWith(FAKE_LOOM_HOME);
    const { namespaceDir, planningRoot } = resolveRepoStatePaths(FAKE_PROJECT, policy);
    assert.equal(planningRoot, path.join(namespaceDir, 'planning'));
  });

  it('namespaceDir ends with the computed slug', () => {
    const policy = policyWith(FAKE_LOOM_HOME);
    const { namespaceDir } = resolveRepoStatePaths(FAKE_PROJECT, policy);
    const { slug } = computeRepoSlug(FAKE_PROJECT);
    assert.equal(path.basename(namespaceDir), slug);
  });

  it('slug has format <sanitized-name>-<8-char-hex>', () => {
    const { slug } = computeRepoSlug(FAKE_PROJECT);
    assert.match(slug, /^[a-z0-9-]+-[0-9a-f]{8}$/, `slug must be <name>-<8hex>: ${slug}`);
  });
});

// ── FR-1: ONE layout — namespaceDir agrees with artifactRouter's namespace ─────

describe('resolveRepoStatePaths — one layout, one resolver (FR-1)', () => {
  it('namespaceDir matches resolveLoomHomePath + computeRepoSlug independently', () => {
    const policy = policyWith(FAKE_LOOM_HOME);
    const { namespaceDir } = resolveRepoStatePaths(FAKE_PROJECT, policy);
    const loomHome = resolveLoomHomePath(FAKE_PROJECT, policy);
    const { slug } = computeRepoSlug(FAKE_PROJECT);
    const expectedNamespaceDir = path.resolve(loomHome, 'repos', slug);
    assert.equal(namespaceDir, expectedNamespaceDir);
  });

  it('artifact dir and dbPath for the same repo share the same parent (namespaceDir)', () => {
    const policy = policyWith(FAKE_LOOM_HOME);
    const { namespaceDir, dbPath } = resolveRepoStatePaths(FAKE_PROJECT, policy);
    // dbPath is <namespaceDir>/loom.db — its parent is namespaceDir
    assert.equal(path.dirname(dbPath), namespaceDir);
    // An artifactRouter artifact dir would be <loomHome>/repos/<slug>/<epicId>
    // which has parent <namespaceDir>. Verify by constructing expected parent:
    const loomHome = resolveLoomHomePath(FAKE_PROJECT, policy);
    const { slug } = computeRepoSlug(FAKE_PROJECT);
    const expectedArtifactParent = path.resolve(loomHome, 'repos', slug);
    assert.equal(namespaceDir, expectedArtifactParent);
  });

  it('artifactRouter.ts source imports computeRepoSlug from repoSlug (no duplicate slug logic)', () => {
    // Walk up from this compiled test to find the source file.
    // Compiled test lives at dist-test/test/home/repoState.test.js:
    //   dist-test/test/home → dist-test/test → dist-test → packages/loom-core → packages → workspace root
    const workspaceRoot = path.resolve(__dirname, '../../../../..');
    const artifactRouterSrc = path.join(
      workspaceRoot,
      'packages/loom-core/src/home/artifactRouter.ts',
    );
    const src = fs.readFileSync(artifactRouterSrc, 'utf8');
    assert.ok(
      src.includes("from './repoSlug.js'") || src.includes('from "./repoSlug.js"'),
      'artifactRouter.ts must import from repoSlug.js',
    );
    assert.ok(
      !src.includes('function computeRepoSlug'),
      'artifactRouter.ts must not define computeRepoSlug inline',
    );
  });
});

// ── policy.loom_home override is honored ──────────────────────────────────────

describe('resolveRepoStatePaths — policy.loom_home override', () => {
  it('custom loom_home re-roots namespaceDir, dbPath, and planningRoot', () => {
    const customHome = '/custom/loom-home';
    const result = resolveRepoStatePaths(FAKE_PROJECT, { loom_home: customHome });
    assert.ok(result.namespaceDir.startsWith(customHome), `namespaceDir must start with custom home: ${result.namespaceDir}`);
    assert.ok(result.dbPath.startsWith(customHome), `dbPath must start with custom home: ${result.dbPath}`);
    assert.ok(result.planningRoot.startsWith(customHome), `planningRoot must start with custom home: ${result.planningRoot}`);
  });

  it('empty policy resolves to sibling loom-home location, not ~/.loom', () => {
    const projectRoot = '/some/repo/my-app';
    const result = resolveRepoStatePaths(projectRoot, {});
    const expectedHome = path.join(path.dirname(projectRoot), 'loom-home');
    assert.ok(
      result.namespaceDir.startsWith(expectedHome),
      `default namespaceDir must start with sibling loom-home (${expectedHome}): ${result.namespaceDir}`,
    );
    assert.ok(
      !result.namespaceDir.startsWith(path.join(process.env.HOME ?? '/root', '.loom')),
      `default namespaceDir must not be under ~/.loom: ${result.namespaceDir}`,
    );
  });
});

// ── FR-9: gitignore patterns ───────────────────────────────────────────────────

describe('ensureLoomHome GITIGNORE_CONTENT — narrow gitignore patterns (FR-9)', () => {
  it('contains repos/*/loom.db', () => {
    assert.ok(
      GITIGNORE_CONTENT.includes('repos/*/loom.db'),
      `GITIGNORE_CONTENT must include repos/*/loom.db`,
    );
  });

  it('contains repos/*/loom.db-*', () => {
    assert.ok(
      GITIGNORE_CONTENT.includes('repos/*/loom.db-*'),
      `GITIGNORE_CONTENT must include repos/*/loom.db-*`,
    );
  });

  it('contains repos/*/planning/', () => {
    assert.ok(
      GITIGNORE_CONTENT.includes('repos/*/planning/'),
      `GITIGNORE_CONTENT must include repos/*/planning/`,
    );
  });

  it('does NOT contain broad repos/*/ or repos/* that would untrack artifact dirs', () => {
    const lines = GITIGNORE_CONTENT.split('\n').map(l => l.trim()).filter(Boolean);
    const broadPatterns = lines.filter(l => l === 'repos/*/' || l === 'repos/*');
    assert.equal(
      broadPatterns.length,
      0,
      `GITIGNORE_CONTENT must not contain broad repos/*/ or repos/*; found: ${broadPatterns}`,
    );
  });

  it('loom.db is matched by repos/*/loom.db pattern', () => {
    // Verify the pattern logic: repos/<slug>/loom.db matches repos/*/loom.db
    const slug = 'my-project-a1b2c3d4';
    const dbRelPath = `repos/${slug}/loom.db`;
    const pattern = 'repos/*/loom.db';
    // Simple glob check: * matches any single path segment
    const regex = new RegExp(`^${pattern.replace('*', '[^/]+')}$`);
    assert.ok(regex.test(dbRelPath), `${dbRelPath} must match ${pattern}`);
  });

  it('loom.db-wal sidecar is matched by repos/*/loom.db-* pattern', () => {
    const slug = 'my-project-a1b2c3d4';
    const walRelPath = `repos/${slug}/loom.db-wal`;
    const shmRelPath = `repos/${slug}/loom.db-shm`;
    const pattern = 'repos/*/loom.db-*';
    const regex = new RegExp(`^${pattern.replace('*', '[^/]+').replace('*', '.+')}$`);
    assert.ok(regex.test(walRelPath), `${walRelPath} must match ${pattern}`);
    assert.ok(regex.test(shmRelPath), `${shmRelPath} must match ${pattern}`);
  });

  it('artifact dir (epicId/) is NOT matched by the narrow patterns', () => {
    const slug = 'my-project-a1b2c3d4';
    const epicDir = `repos/${slug}/epic-001`;
    const narrowPatterns = ['repos/*/loom.db', 'repos/*/loom.db-*', 'repos/*/planning/'];
    for (const pattern of narrowPatterns) {
      // Build a simple regex for the pattern
      const regexStr = `^${pattern.replace(/\./g, '\\.').replace(/\*/g, '[^/]+')}$`;
      const regex = new RegExp(regexStr);
      assert.ok(
        !regex.test(epicDir),
        `Artifact dir "${epicDir}" must NOT be matched by pattern "${pattern}"`,
      );
    }
  });
});

// ── Path-traversal guard ──────────────────────────────────────────────────────

describe('resolveRepoStatePaths — path-traversal guard', () => {
  it('normal projectRoot produces namespaceDir inside loomHome', () => {
    const policy = policyWith(FAKE_LOOM_HOME);
    const { namespaceDir } = resolveRepoStatePaths(FAKE_PROJECT, policy);
    assert.ok(
      namespaceDir.startsWith(FAKE_LOOM_HOME + path.sep),
      `namespaceDir must stay inside loomHome: ${namespaceDir}`,
    );
  });

  it('crafted basename (all special chars) falls back to "repo" slug prefix and stays inside loomHome', () => {
    const craftedRoot = path.join(FAKE_LOOM_HOME, '..', '..', '___');
    // Even if the basename is all underscores, sanitizeName returns 'repo'
    const policy = policyWith(FAKE_LOOM_HOME);
    const result = resolveRepoStatePaths(craftedRoot, policy);
    assert.ok(
      result.namespaceDir.startsWith(path.resolve(FAKE_LOOM_HOME) + path.sep),
      `namespaceDir must stay inside loomHome for crafted input: ${result.namespaceDir}`,
    );
  });
});

// ── AC4: fresh-install location (not in projectRoot/.loom/) ──────────────────

describe('resolveRepoStatePaths — fresh-install location (AC4)', () => {
  it('dbPath is not under projectRoot/.loom/', () => {
    const projectRoot = '/home/user/my-project';
    const policy = policyWith('/home/user/loom-home');
    const { dbPath } = resolveRepoStatePaths(projectRoot, policy);
    const inRepoLoom = path.join(projectRoot, '.loom', 'loom.db');
    assert.notEqual(dbPath, inRepoLoom, 'dbPath must not point at <projectRoot>/.loom/loom.db');
    assert.ok(
      !dbPath.startsWith(path.join(projectRoot, '.loom')),
      `dbPath must not be under projectRoot/.loom/: ${dbPath}`,
    );
  });

  it('planningRoot is not under projectRoot/', () => {
    const projectRoot = '/home/user/my-project';
    const policy = policyWith('/home/user/loom-home');
    const { planningRoot } = resolveRepoStatePaths(projectRoot, policy);
    assert.ok(
      !planningRoot.startsWith(projectRoot + path.sep),
      `planningRoot must not be inside projectRoot: ${planningRoot}`,
    );
  });
});
