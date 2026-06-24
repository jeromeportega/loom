import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveActiveRepo } from '../home/resolveActiveRepo.js';
import { readManifest, manifestPath, type ManifestEntry } from '../home/workspaceManifest.js';
import { computeRepoSlug } from '../home/repoSlug.js';
import { prepareRepoState } from '../home/prepareRepoState.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-resolve-active-'));
}

// ── resolve existing entry ────────────────────────────────────────────────────

describe('resolveActiveRepo — resolve existing entry', () => {
  it('returns the existing entry and does NOT create a new entry (manifest length unchanged)', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      // Pre-register the repo so it already exists in the manifest.
      const first = resolveActiveRepo(home, repo);
      const manifestBefore = readManifest(home);
      assert.equal(manifestBefore.repos.length, 1, 'precondition: one entry after first call');

      // Second call: same repo → must return the same entry, no new entry.
      const second = resolveActiveRepo(home, repo);
      const manifestAfter = readManifest(home);

      assert.deepEqual(second, first, 'must return the same entry as the first call');
      assert.equal(manifestAfter.repos.length, 1, 'manifest must still have exactly one entry');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── auto-register absent repo on first use ────────────────────────────────────

describe('resolveActiveRepo — auto-register absent repo', () => {
  it('registers the repo when absent, producing a one-entry manifest, and returns the new entry', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      // Manifest does not exist yet.
      assert.ok(!fs.existsSync(manifestPath(home)), 'precondition: no manifest');

      const entry = resolveActiveRepo(home, repo);

      const { slug, remoteUrl } = computeRepoSlug(repo);
      assert.equal(entry.slug, slug, 'slug must equal computeRepoSlug().slug');
      assert.equal(entry.path, fs.realpathSync(repo), 'path must be realpathSync(projectRoot)');
      assert.equal(entry.remote_url, remoteUrl, 'remote_url must equal computeRepoSlug().remoteUrl');

      const manifest = readManifest(home);
      assert.equal(manifest.repos.length, 1, 'manifest must contain exactly one entry after first use');
      assert.deepEqual(manifest.repos[0], entry);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── idempotent second invocation ──────────────────────────────────────────────

describe('resolveActiveRepo — idempotent second invocation', () => {
  it('second call for a now-registered repo: still one entry, no duplicate, same entry returned', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      // First invocation: auto-registers.
      const entry1 = resolveActiveRepo(home, repo);
      assert.equal(readManifest(home).repos.length, 1, 'one entry after first call');

      // Second invocation: must be idempotent.
      const entry2 = resolveActiveRepo(home, repo);
      assert.deepEqual(entry2, entry1, 'same entry returned on second call');
      assert.equal(readManifest(home).repos.length, 1, 'still one entry after second call');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── MATCH-BY-SLUG-NOT-PATH ────────────────────────────────────────────────────

describe('resolveActiveRepo — match by slug, not by stored path', () => {
  it('resolves to existing entry when slug matches but stored path is stale/different', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      const { slug, remoteUrl } = computeRepoSlug(repo);

      // Pre-seed a manifest entry with a stale/different stored path but matching slug.
      const staleEntry: ManifestEntry = {
        slug,
        path: '/some/stale/path/that/no/longer/exists',
        remote_url: remoteUrl,
      };
      const existingManifest = { version: 1 as const, repos: [staleEntry] };
      fs.writeFileSync(manifestPath(home), yaml.dump(existingManifest), 'utf8');

      // resolveActiveRepo must match by slug (not path) and return the stale entry.
      const resolved = resolveActiveRepo(home, repo);
      assert.equal(resolved.slug, slug, 'resolved entry must have matching slug');
      assert.equal(resolved.path, staleEntry.path, 'must return the stale entry (match by slug, not path)');

      // No duplicate must be appended.
      const manifest = readManifest(home);
      assert.equal(manifest.repos.length, 1, 'no duplicate must be appended when slug matches');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── NEVER-THROWS happy path ───────────────────────────────────────────────────

describe('resolveActiveRepo — never throws on happy path', () => {
  it('returns normally for a normal repo (first use)', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      let returned: ManifestEntry | undefined;
      assert.doesNotThrow(() => {
        returned = resolveActiveRepo(home, repo);
      }, 'resolveActiveRepo must not throw on first use (observe-and-record)');
      assert.ok(returned, 'must return a ManifestEntry');
      assert.ok(typeof returned.slug === 'string' && returned.slug.length > 0, 'slug must be non-empty string');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns normally for a normal repo (second use — already registered)', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      resolveActiveRepo(home, repo); // first use
      assert.doesNotThrow(() => {
        resolveActiveRepo(home, repo); // second use
      }, 'resolveActiveRepo must not throw on subsequent use (observe-and-record)');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── INTEGRATION: prepareRepoState calls resolveActiveRepo ─────────────────────

describe('resolveActiveRepo — integration via prepareRepoState', () => {
  let tmp: string;
  let loomHome: string;
  let projectRoot: string;

  before(() => {
    tmp = tmpDir();
    loomHome = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(path.join(projectRoot, '.loom'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.loom', 'policy.yaml'), '', 'utf8');
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prepareRepoState creates a workspace manifest with exactly one entry for the project', () => {
    const policy = { loom_home: loomHome };
    prepareRepoState(projectRoot, policy);

    assert.ok(fs.existsSync(manifestPath(loomHome)), 'workspace.yaml must exist after prepareRepoState');

    const manifest = readManifest(loomHome);
    assert.equal(manifest.repos.length, 1, 'manifest must contain exactly one entry');

    const { slug } = computeRepoSlug(projectRoot);
    assert.equal(manifest.repos[0].slug, slug, 'entry slug must match computeRepoSlug(projectRoot).slug');
  });

  it('second prepareRepoState call is idempotent: still one entry, no duplicate', () => {
    const policy = { loom_home: loomHome };
    prepareRepoState(projectRoot, policy);
    prepareRepoState(projectRoot, policy);

    const manifest = readManifest(loomHome);
    assert.equal(manifest.repos.length, 1, 'second prepareRepoState must not create a duplicate entry');
  });
});

// ── REGRESSION: single-repo resolution unchanged without manifest ─────────────

describe('resolveActiveRepo — regression: single-repo prepareRepoState behavior unchanged', () => {
  it('prepareRepoState returns identical paths on first (no manifest) and second (manifest exists) call', () => {
    const tmp1 = tmpDir();
    const loomHome = path.join(tmp1, 'loom-home');
    const proj = path.join(tmp1, 'project');

    try {
      fs.mkdirSync(path.join(proj, '.loom'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.loom', 'policy.yaml'), '', 'utf8');

      const policy = { loom_home: loomHome };

      // First call: no workspace.yaml — prepareRepoState creates loomHome and registers.
      const paths1 = prepareRepoState(proj, policy);
      assert.ok(paths1.dbPath.startsWith(loomHome), 'first call: dbPath must be under loom-home');
      assert.ok(paths1.namespaceDir.startsWith(loomHome), 'first call: namespaceDir must be under loom-home');
      assert.ok(fs.existsSync(manifestPath(loomHome)), 'workspace.yaml must exist after first call');

      // Second call: workspace.yaml now exists — paths must be identical (manifest doesn't alter resolution).
      const paths2 = prepareRepoState(proj, policy);
      assert.equal(paths2.dbPath, paths1.dbPath, 'dbPath must be identical on second call (manifest present)');
      assert.equal(paths2.namespaceDir, paths1.namespaceDir, 'namespaceDir must be identical on second call');
    } finally {
      fs.rmSync(tmp1, { recursive: true, force: true });
    }
  });

  it('prepareRepoState does not throw with or without workspace.yaml', () => {
    const tmp1 = tmpDir();
    const loomHome = path.join(tmp1, 'loom-home');
    const proj = path.join(tmp1, 'project');

    try {
      fs.mkdirSync(path.join(proj, '.loom'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.loom', 'policy.yaml'), '', 'utf8');

      const policy = { loom_home: loomHome };

      // First call: no workspace.yaml — must not throw.
      assert.doesNotThrow(
        () => prepareRepoState(proj, policy),
        'prepareRepoState must not throw on first use (workspace.yaml absent)',
      );

      // Second call: workspace.yaml now present — must still not throw.
      assert.doesNotThrow(
        () => prepareRepoState(proj, policy),
        'prepareRepoState must not throw when workspace.yaml is already present',
      );
    } finally {
      fs.rmSync(tmp1, { recursive: true, force: true });
    }
  });
});
