import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { registerRepo, readManifest } from '../../src/home/workspaceManifest.js';
import { computeRepoSlug } from '../../src/home/repoSlug.js';
import { gitSafe } from '../../src/orchestrator/git.js';
import { resolveRegisteredRepo, listWorkspaceRoots } from '../../src/retrieval/ManifestResolver.js';
import { RetrievalRefused, CROSS_REPO_RULES, ResolvedRepo, RetrievalMatch,
         SearchResult, ReadResult, RetrievalRequest, SliceBounds } from '../../src/retrieval/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loom-resolver-${prefix}-`));
}

/** Init a git repo so computeRepoSlug can derive a proper slug. */
function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed: ${res.output}`);
}

/** Add a fake remote so the slug is derived from the URL, not just the path. */
function gitAddRemote(dir: string, url: string): void {
  gitSafe(dir, ['remote', 'add', 'origin', url]);
}

// ── AC-1: Happy path — registered repo resolves to correct ResolvedRepo ──────

describe('resolveRegisteredRepo — AC-1: happy path', () => {
  let loomHome: string;
  let repoDir: string;
  let entry: ReturnType<typeof registerRepo>;
  let result: ResolvedRepo;

  before(() => {
    loomHome = makeTmp('home');
    repoDir = makeTmp('repo');
    fs.mkdirSync(loomHome, { recursive: true });
    gitInit(repoDir);
    entry = registerRepo(loomHome, repoDir);
    result = resolveRegisteredRepo(loomHome, entry.slug);
  });

  after(() => {
    fs.rmSync(loomHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns a ResolvedRepo with root equal to realpathSync(entry.path)', () => {
    const expected = fs.realpathSync(entry.path);
    assert.equal(result.root, expected);
  });

  it('returns a ResolvedRepo with slug matching the registered slug', () => {
    assert.equal(result.slug, entry.slug);
  });

  it('root is a directory that exists on disk', () => {
    assert.ok(fs.statSync(result.root).isDirectory());
  });

  it('resolution does not read file content from the repo (root contains no file content in result)', () => {
    // ResolvedRepo carries only { slug, root } — no content from the repo.
    assert.deepEqual(Object.keys(result).sort(), ['root', 'slug']);
  });
});

// ── AC-2: Unregistered slug — refused before any filesystem access ───────────

describe('resolveRegisteredRepo — AC-2: unregistered slug', () => {
  let loomHome: string;

  before(() => {
    loomHome = makeTmp('home2');
    fs.mkdirSync(loomHome, { recursive: true });
    // No repos registered — empty manifest.
  });

  after(() => fs.rmSync(loomHome, { recursive: true, force: true }));

  it('throws RetrievalRefused', () => {
    assert.throws(
      () => resolveRegisteredRepo(loomHome, 'some-unregistered-repo-abc12345'),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused, `expected RetrievalRefused, got ${err}`);
        return true;
      },
    );
  });

  it('rule is cross_repo.unregistered', () => {
    assert.throws(
      () => resolveRegisteredRepo(loomHome, 'some-unregistered-repo-abc12345'),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.UNREGISTERED);
        return true;
      },
    );
  });

  it('refuses even if a directory with the slug name exists somewhere', () => {
    // A directory that is NOT registered should not be resolved.
    const unrelatedDir = makeTmp('unrelated');
    try {
      gitInit(unrelatedDir);
      const { slug } = computeRepoSlug(unrelatedDir);
      // slug is derived from unrelatedDir but NOT registered in this loomHome.
      assert.throws(
        () => resolveRegisteredRepo(loomHome, slug),
        (err: unknown) => {
          assert.ok(err instanceof RetrievalRefused);
          assert.equal(err.rule, CROSS_REPO_RULES.UNREGISTERED);
          return true;
        },
      );
    } finally {
      fs.rmSync(unrelatedDir, { recursive: true, force: true });
    }
  });
});

// ── AC-3 / FR-8: Stale path — deleted ────────────────────────────────────────

describe('resolveRegisteredRepo — AC-3: stale path (repo deleted)', () => {
  let loomHome: string;
  let repoDir: string;
  let slug: string;

  before(() => {
    loomHome = makeTmp('home3');
    repoDir = makeTmp('stale');
    fs.mkdirSync(loomHome, { recursive: true });
    gitInit(repoDir);
    const entry = registerRepo(loomHome, repoDir);
    slug = entry.slug;
    // Now delete the repo directory to simulate a moved/deleted repo.
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  after(() => fs.rmSync(loomHome, { recursive: true, force: true }));

  it('throws RetrievalRefused when path no longer exists', () => {
    assert.throws(
      () => resolveRegisteredRepo(loomHome, slug),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        return true;
      },
    );
  });

  it('rule is cross_repo.stale_path', () => {
    assert.throws(
      () => resolveRegisteredRepo(loomHome, slug),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.STALE_PATH);
        return true;
      },
    );
  });

  it('does not fall back to a broader search — throws immediately', () => {
    // Verify the thrown error is RetrievalRefused (not ENOENT or a raw fs error).
    assert.throws(
      () => resolveRegisteredRepo(loomHome, slug),
      RetrievalRefused,
    );
  });
});

// ── AC-3 / FR-8 / T6: Stale path — TOCTOU: different repo at same path ──────

describe('resolveRegisteredRepo — AC-3/T6: stale path (path swapped with different repo)', () => {
  let loomHome: string;
  let repoDir: string;
  let slug: string;

  before(() => {
    loomHome = makeTmp('home4');
    repoDir = makeTmp('toctou');
    fs.mkdirSync(loomHome, { recursive: true });
    gitInit(repoDir);
    // Use a fake remote so the slug is derived from the remote URL (not just the path).
    // After we remove this repo and put a plain directory at the same path, the slug
    // derived from the new contents will differ (no remote → hashes the path).
    gitAddRemote(repoDir, 'https://github.com/test/original-repo.git');
    const entry = registerRepo(loomHome, repoDir);
    slug = entry.slug;
    // Simulate path swap: remove the original repo, put an unrelated directory in place.
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir);  // plain directory, no git, no remote
  });

  after(() => {
    fs.rmSync(loomHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('throws RetrievalRefused when a different repo occupies the registered path', () => {
    assert.throws(
      () => resolveRegisteredRepo(loomHome, slug),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        return true;
      },
    );
  });

  it('rule is cross_repo.stale_path — not unregistered', () => {
    assert.throws(
      () => resolveRegisteredRepo(loomHome, slug),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.STALE_PATH);
        return true;
      },
    );
  });

  it('never falls back to a broader search', () => {
    assert.throws(
      () => resolveRegisteredRepo(loomHome, slug),
      RetrievalRefused,
    );
  });
});

// ── Fail closed: path is a file, not a directory ─────────────────────────────

describe('resolveRegisteredRepo — fail closed: path resolves to a file', () => {
  let loomHome: string;
  let filePath: string;
  let slug: string;

  before(() => {
    loomHome = makeTmp('home5');
    fs.mkdirSync(loomHome, { recursive: true });

    // Register a real repo, then replace the directory with a regular file.
    const repoDir = makeTmp('file-repo');
    gitInit(repoDir);
    const entry = registerRepo(loomHome, repoDir);
    slug = entry.slug;
    filePath = entry.path;

    // Remove the directory and put a file at the same path.
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.writeFileSync(filePath, 'I am a file, not a directory\n', 'utf8');
  });

  after(() => {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    fs.rmSync(loomHome, { recursive: true, force: true });
  });

  it('throws RetrievalRefused with stale_path when path is a file', () => {
    assert.throws(
      () => resolveRegisteredRepo(loomHome, slug),
      (err: unknown) => {
        assert.ok(err instanceof RetrievalRefused);
        assert.equal(err.rule, CROSS_REPO_RULES.STALE_PATH);
        return true;
      },
    );
  });
});

// ── Symlink: entry.path is a symlink → root is the canonical realpath ─────────

describe('resolveRegisteredRepo — symlink: entry.path is a symlink', () => {
  let loomHome: string;
  let realDir: string;
  let symlinkPath: string;
  let expectedSlug: string;
  let result: ResolvedRepo;

  before(() => {
    loomHome = makeTmp('home6');
    realDir = makeTmp('real-repo');
    fs.mkdirSync(loomHome, { recursive: true });
    gitInit(realDir);

    // Derive the slug from the real directory (as resolveRegisteredRepo will).
    const realpath = fs.realpathSync(realDir);
    expectedSlug = computeRepoSlug(realpath).slug;

    // Create a symlink pointing to the real directory.
    symlinkPath = path.join(os.tmpdir(), `loom-resolver-symlink-${process.pid}`);
    try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
    fs.symlinkSync(realpath, symlinkPath);

    // Write manifest manually with the SYMLINK path as entry.path.
    // This simulates a hand-edited or legacy manifest where canonicalization wasn't applied.
    const manifestContent = yaml.dump({
      version: 1,
      repos: [{ slug: expectedSlug, path: symlinkPath, remote_url: null }],
    });
    fs.writeFileSync(path.join(loomHome, 'workspace.yaml'), manifestContent, 'utf8');

    result = resolveRegisteredRepo(loomHome, expectedSlug);
  });

  after(() => {
    try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(loomHome, { recursive: true, force: true });
  });

  it('returns the canonical realpath as root, not the symlink path', () => {
    const expected = fs.realpathSync(realDir);
    assert.equal(result.root, expected);
    assert.notEqual(result.root, symlinkPath);
  });

  it('slug is correct', () => {
    assert.equal(result.slug, expectedSlug);
  });
});

// ── AC-4: Manifest consumption — reads via readManifest only, no mutation ────

describe('resolveRegisteredRepo — AC-4: manifest consumption', () => {
  let loomHome: string;
  let repoDir: string;
  let slug: string;
  let manifestBefore: string;
  let manifestAfter: string;

  before(() => {
    loomHome = makeTmp('home7');
    repoDir = makeTmp('repo7');
    fs.mkdirSync(loomHome, { recursive: true });
    gitInit(repoDir);
    const entry = registerRepo(loomHome, repoDir);
    slug = entry.slug;

    manifestBefore = fs.readFileSync(path.join(loomHome, 'workspace.yaml'), 'utf8');
    resolveRegisteredRepo(loomHome, slug);
    manifestAfter = fs.readFileSync(path.join(loomHome, 'workspace.yaml'), 'utf8');
  });

  after(() => {
    fs.rmSync(loomHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('does not mutate the manifest file on a successful resolve', () => {
    assert.equal(manifestAfter, manifestBefore);
  });

  it('manifest entry fields match ManifestEntry schema (slug, path, remote_url only)', () => {
    const manifest = readManifest(loomHome);
    const entry = manifest.repos.find(r => r.slug === slug);
    assert.ok(entry);
    // No extra fields should have been added by the resolver (ADR-002).
    assert.deepEqual(Object.keys(entry).sort(), ['path', 'remote_url', 'slug']);
  });

  it('readManifest returns a WorkspaceManifest with version 1', () => {
    const manifest = readManifest(loomHome);
    assert.equal(manifest.version, 1);
  });
});

// ── listWorkspaceRoots ────────────────────────────────────────────────────────

describe('listWorkspaceRoots — returns verified roots of all registered repos', () => {
  let loomHome: string;
  let repoA: string;
  let repoB: string;

  before(() => {
    loomHome = makeTmp('home8');
    repoA = makeTmp('repoA');
    repoB = makeTmp('repoB');
    fs.mkdirSync(loomHome, { recursive: true });
    gitInit(repoA);
    gitInit(repoB);
    registerRepo(loomHome, repoA);
    registerRepo(loomHome, repoB);
  });

  after(() => {
    fs.rmSync(loomHome, { recursive: true, force: true });
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  });

  it('returns one root per registered repo', () => {
    const roots = listWorkspaceRoots(loomHome);
    assert.equal(roots.length, 2);
  });

  it('each root is the realpathSync of the registered path', () => {
    const roots = listWorkspaceRoots(loomHome);
    const realA = fs.realpathSync(repoA);
    const realB = fs.realpathSync(repoB);
    assert.ok(roots.includes(realA), `roots must include realpath of repoA: ${realA}`);
    assert.ok(roots.includes(realB), `roots must include realpath of repoB: ${realB}`);
  });
});

describe('listWorkspaceRoots — excludes stale/deleted paths silently', () => {
  let loomHome: string;
  let goodRepo: string;
  let staleRepo: string;

  before(() => {
    loomHome = makeTmp('home9');
    goodRepo = makeTmp('good');
    staleRepo = makeTmp('stale2');
    fs.mkdirSync(loomHome, { recursive: true });
    gitInit(goodRepo);
    gitInit(staleRepo);
    registerRepo(loomHome, goodRepo);
    registerRepo(loomHome, staleRepo);
    // Delete the stale repo to simulate a moved/deleted path.
    fs.rmSync(staleRepo, { recursive: true, force: true });
  });

  after(() => {
    fs.rmSync(loomHome, { recursive: true, force: true });
    fs.rmSync(goodRepo, { recursive: true, force: true });
  });

  it('returns only the surviving repo root', () => {
    const roots = listWorkspaceRoots(loomHome);
    assert.equal(roots.length, 1);
    assert.equal(roots[0], fs.realpathSync(goodRepo));
  });

  it('does not throw for stale entries', () => {
    assert.doesNotThrow(() => listWorkspaceRoots(loomHome));
  });
});

describe('listWorkspaceRoots — empty manifest returns empty array', () => {
  let loomHome: string;

  before(() => {
    loomHome = makeTmp('home10');
    fs.mkdirSync(loomHome, { recursive: true });
  });

  after(() => fs.rmSync(loomHome, { recursive: true, force: true }));

  it('returns [] for an empty manifest', () => {
    assert.deepEqual(listWorkspaceRoots(loomHome), []);
  });
});

// ── types.ts: exported contracts ──────────────────────────────────────────────

describe('types.ts — exported shared contracts', () => {
  it('RetrievalRefused is an Error subclass with rule and reason', () => {
    const err = new RetrievalRefused('cross_repo.unregistered', 'test reason');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof RetrievalRefused);
    assert.equal(err.rule, 'cross_repo.unregistered');
    assert.equal(err.reason, 'test reason');
    assert.equal(err.message, 'test reason');
  });

  it('CROSS_REPO_RULES contains all required rule strings', () => {
    assert.equal(CROSS_REPO_RULES.UNREGISTERED,     'cross_repo.unregistered');
    assert.equal(CROSS_REPO_RULES.STALE_PATH,       'cross_repo.stale_path');
    assert.equal(CROSS_REPO_RULES.USE_RETRIEVAL,    'cross_repo.use_retrieval');
    assert.equal(CROSS_REPO_RULES.OUT_OF_WORKSPACE, 'cross_repo.out_of_workspace');
    assert.equal(CROSS_REPO_RULES.READ_ONLY,        'cross_repo.read_only');
    assert.equal(CROSS_REPO_RULES.FILE_TOO_LARGE,   'cross_repo.file_too_large');
    assert.equal(CROSS_REPO_RULES.TOO_MANY_FILES,   'cross_repo.too_many_files');
    assert.equal(CROSS_REPO_RULES.SECRET_EXCLUDED,  'cross_repo.secret_excluded');
  });

  it('type exports are accessible (compile-time check via instantiation)', () => {
    // Verify the interfaces are usable as types — if these assignments compile,
    // the exports are correct.
    const resolved: ResolvedRepo = { slug: 'test-slug', root: '/some/path' };
    assert.equal(resolved.slug, 'test-slug');

    const bounds: SliceBounds = {
      maxLineWindow: 200, maxFileBytes: 262144, maxFiles: 20, maxMatchesPerFile: 10,
    };
    assert.equal(bounds.maxLineWindow, 200);

    const match: RetrievalMatch = { path: 'src/foo.ts', line: 1, excerpt: 'code' };
    assert.equal(match.line, 1);

    const search: SearchResult = { slug: 'test', matches: [match], truncated: false };
    assert.equal(search.truncated, false);

    const read: ReadResult = {
      slug: 'test', path: 'src/foo.ts', content: 'code',
      window: [1, 10], truncated: false,
    };
    assert.equal(read.window[0], 1);

    const req: RetrievalRequest = { kind: 'read', slug: 'test', path: 'src/foo.ts' };
    assert.equal(req.kind, 'read');
  });
});
