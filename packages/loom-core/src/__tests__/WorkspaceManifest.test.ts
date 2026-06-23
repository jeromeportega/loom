import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  manifestPath,
  readManifest,
  registerRepo,
  WorkspaceManifestSchema,
  type ManifestEntry,
} from '../home/workspaceManifest.js';
import { computeRepoSlug } from '../home/repoSlug.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-manifest-'));
}

// ── manifestPath ──────────────────────────────────────────────────────────────

describe('manifestPath', () => {
  it('returns path.join(loomHome, workspace.yaml)', () => {
    const home = '/some/loom-home';
    assert.equal(manifestPath(home), path.join(home, 'workspace.yaml'));
  });
});

// ── readManifest — absent file ────────────────────────────────────────────────

describe('readManifest — absent file', () => {
  it('returns empty manifest when workspace.yaml does not exist', () => {
    const home = tmpDir();
    try {
      const m = readManifest(home);
      assert.deepEqual(m, { version: 1, repos: [] });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── readManifest — round-trip ─────────────────────────────────────────────────

describe('readManifest — round-trip', () => {
  it('reads back a file that was written via js-yaml', () => {
    const home = tmpDir();
    try {
      const entry: ManifestEntry = {
        slug: 'my-repo-a1b2c3d4',
        path: '/abs/path/to/repo',
        remote_url: 'git@github.com:org/repo.git',
      };
      const manifest = { version: 1 as const, repos: [entry] };
      fs.writeFileSync(manifestPath(home), yaml.dump(manifest), 'utf8');

      const read = readManifest(home);
      assert.deepEqual(read, manifest);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('round-trips remote_url: null without loss', () => {
    const home = tmpDir();
    try {
      const entry: ManifestEntry = {
        slug: 'local-repo-deadbeef',
        path: '/local/path',
        remote_url: null,
      };
      const manifest = { version: 1 as const, repos: [entry] };
      fs.writeFileSync(manifestPath(home), yaml.dump(manifest), 'utf8');

      const read = readManifest(home);
      assert.deepEqual(read, manifest);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── readManifest — validation rejects invalid files ──────────────────────────

describe('readManifest — schema validation', () => {
  it('throws on version: 2 (wrong version literal)', () => {
    const home = tmpDir();
    try {
      fs.writeFileSync(manifestPath(home), yaml.dump({ version: 2, repos: [] }), 'utf8');
      assert.throws(() => readManifest(home), /version/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('throws on entry missing slug', () => {
    const home = tmpDir();
    try {
      const bad = { version: 1, repos: [{ path: '/some/path', remote_url: null }] };
      fs.writeFileSync(manifestPath(home), yaml.dump(bad), 'utf8');
      assert.throws(() => readManifest(home));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('throws on entry missing path', () => {
    const home = tmpDir();
    try {
      const bad = { version: 1, repos: [{ slug: 'some-repo-a1b2c3d4', remote_url: null }] };
      fs.writeFileSync(manifestPath(home), yaml.dump(bad), 'utf8');
      assert.throws(() => readManifest(home));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('throws on non-array repos', () => {
    const home = tmpDir();
    try {
      fs.writeFileSync(manifestPath(home), yaml.dump({ version: 1, repos: 'not-an-array' }), 'utf8');
      assert.throws(() => readManifest(home));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── registerRepo — new entry ──────────────────────────────────────────────────

describe('registerRepo — new entry', () => {
  it('appends exactly one entry with the correct three fields', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      const entry = registerRepo(home, repo);
      const { slug, remoteUrl } = computeRepoSlug(repo);

      assert.equal(entry.slug, slug, 'slug must equal computeRepoSlug().slug');
      assert.equal(entry.path, fs.realpathSync(repo), 'path must be realpathSync(projectRoot)');
      assert.equal(entry.remote_url, remoteUrl, 'remote_url must equal computeRepoSlug().remoteUrl');

      // Exactly three fields — no extras
      const keys = Object.keys(entry).sort();
      assert.deepEqual(keys, ['path', 'remote_url', 'slug'], 'entry must have exactly three fields');

      const m = readManifest(home);
      assert.equal(m.repos.length, 1, 'manifest must contain exactly one entry');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('remote_url is null and entry is valid when repo has no git remote', () => {
    const home = tmpDir();
    const repo = tmpDir(); // not a git repo → no remote
    try {
      const entry = registerRepo(home, repo);
      assert.equal(entry.remote_url, null);
      // The written manifest parses without error
      WorkspaceManifestSchema.parse(readManifest(home));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── IDENTITY-BY-INSPECTION ────────────────────────────────────────────────────

describe('registerRepo — identity by inspection', () => {
  it('workspaceManifest.ts imports computeRepoSlug from repoSlug and uses no second identity scheme', () => {
    // Resolve source file relative to compiled test at dist/__tests__/WorkspaceManifest.test.js.
    // Source files must be present (they are in this repo — not an npm-dist-only environment).
    const srcFile = path.resolve(__dirname, '../../src/home/workspaceManifest.ts');
    assert.ok(
      fs.existsSync(srcFile),
      `Source file not found at ${srcFile}. ` +
      'Expected compiled output to be exactly two directory levels below src/ ' +
      '(dist/__tests__/ → src/home/). Check tsconfig outDir if this path is wrong.',
    );
    const src = fs.readFileSync(srcFile, 'utf8');

    assert.ok(
      src.includes("from './repoSlug.js'") || src.includes('from "./repoSlug.js"'),
      'workspaceManifest.ts must import from repoSlug.js',
    );
    assert.ok(
      !src.includes('function computeRepoSlug'),
      'workspaceManifest.ts must not define computeRepoSlug inline (no second identity scheme)',
    );
    assert.ok(
      !src.includes('createHash'),
      'workspaceManifest.ts must not call createHash directly (no second identity scheme)',
    );
  });
});

// ── registerRepo — idempotent ─────────────────────────────────────────────────

describe('registerRepo — idempotent', () => {
  it('calling twice yields exactly one entry (no duplicate)', () => {
    const home = tmpDir();
    const repo = tmpDir();
    try {
      const first = registerRepo(home, repo);
      const second = registerRepo(home, repo);

      assert.deepEqual(first, second, 'second call must return the existing entry unchanged');
      const m = readManifest(home);
      assert.equal(m.repos.length, 1, 'no duplicate entry must be written');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('idempotent re-registration does not drop other existing entries', () => {
    const home = tmpDir();
    const repo1 = tmpDir();
    const repo2 = tmpDir();
    try {
      registerRepo(home, repo1);
      registerRepo(home, repo2);

      // Re-register repo1 — should be a no-op
      registerRepo(home, repo1);

      const m = readManifest(home);
      assert.equal(m.repos.length, 2, 'both entries must survive after idempotent re-registration');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo1, { recursive: true, force: true });
      fs.rmSync(repo2, { recursive: true, force: true });
    }
  });
});

// ── CONCURRENCY ───────────────────────────────────────────────────────────────

describe('registerRepo — concurrent writes under lock', () => {
  it('N concurrent registerRepo calls for distinct repos all land in the manifest without corruption', async () => {
    const home = tmpDir();
    fs.mkdirSync(home, { recursive: true });
    const N = 8;
    const repos = Array.from({ length: N }, () => tmpDir());

    // Module path resolved relative to compiled test at dist/__tests__/WorkspaceManifest.test.js
    const modulePath = path.resolve(__dirname, '../home/workspaceManifest.js');

    const workerScript = `
      const { workerData, parentPort } = require('worker_threads');
      const { registerRepo } = require(workerData.modulePath);
      try {
        const entry = registerRepo(workerData.loomHome, workerData.projectRoot);
        parentPort.postMessage({ ok: true, slug: entry.slug });
      } catch (err) {
        parentPort.postMessage({ ok: false, error: err.message });
      }
    `;

    const results = await Promise.all(
      repos.map(repo =>
        new Promise<{ ok: boolean; slug?: string; error?: string }>((resolve, reject) => {
          const worker = new Worker(workerScript, {
            eval: true,
            workerData: { modulePath, loomHome: home, projectRoot: repo },
          });
          worker.on('message', resolve);
          worker.on('error', reject);
        }),
      ),
    );

    try {
      for (const r of results) {
        assert.ok(r.ok, `worker failed: ${r.error ?? 'unknown'}`);
      }

      // Final manifest must contain all N entries, parse cleanly, and validate
      const final = readManifest(home);
      WorkspaceManifestSchema.parse(final);
      assert.equal(final.repos.length, N, `manifest must contain all ${N} entries`);

      // No slug duplicates
      const slugs = final.repos.map(r => r.slug);
      const unique = new Set(slugs);
      assert.equal(unique.size, N, 'all slugs must be unique — no entries dropped or duplicated');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      for (const repo of repos) {
        try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  });
});
