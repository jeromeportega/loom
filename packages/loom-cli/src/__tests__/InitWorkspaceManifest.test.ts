import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveLoomHomePath } from '@loom-ai/core';

// __dirname = packages/loom-cli/dist/__tests__
const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;
let projectDir: string;
let loomHomeDir: string;

/**
 * Run `loom init` in projectDir with LOOM_HOME redirected so the machine-level
 * ProjectRegistry stays out of the developer's real ~/.loom.
 */
function runInit(): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node "${LOOM_CLI}" init`, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LOOM_HOME: path.join(tmpDir, 'machine-loom') },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

interface ManifestEntry {
  slug: string;
  path: string;
  remote_url: string | null;
}
interface WorkspaceManifest {
  version: number;
  repos: ManifestEntry[];
}

function readManifest(): WorkspaceManifest {
  const p = path.join(loomHomeDir, 'workspace.yaml');
  return yaml.load(fs.readFileSync(p, 'utf8')) as WorkspaceManifest;
}

before(() => {
  // project/ is inside tmpDir so loom-home (a sibling in the real path) stays
  // within the same isolation directory and is cleaned up automatically.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-manifest-init-'));
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  execSync('git init -q', { cwd: projectDir });

  // Use resolveLoomHomePath directly instead of replicating its algorithm, so
  // the test always looks in the same place loom init writes to.
  loomHomeDir = resolveLoomHomePath(projectDir, {});

  // Run loom init once for all tests. Asserting exit 0 here avoids an implicit
  // ordering dependency on the first it() block.
  const result = runInit();
  assert.equal(result.status, 0, `loom init failed: ${result.stderr}`);
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loom init — workspace manifest (story-054-003)', () => {
  it('workspace.yaml exists in loom-home after loom init', () => {
    assert.ok(
      fs.existsSync(path.join(loomHomeDir, 'workspace.yaml')),
      `workspace.yaml missing at ${loomHomeDir}`
    );
  });

  it('manifest contains exactly one entry after loom init', () => {
    const m = readManifest();
    assert.equal(m.version, 1);
    assert.equal(m.repos.length, 1, 'manifest must contain exactly one repo entry');
  });

  it('manifest entry has correct path (realpathSync of projectDir)', () => {
    const m = readManifest();
    const entry = m.repos[0];
    const expectedPath = (() => {
      try { return fs.realpathSync(projectDir); } catch { return projectDir; }
    })();
    assert.equal(entry.path, expectedPath, 'entry.path must equal realpathSync(projectDir)');
  });

  it('manifest entry has null remote_url for a repo with no remote', () => {
    const m = readManifest();
    const entry = m.repos[0];
    assert.equal(entry.remote_url, null, 'entry.remote_url must be null when no remote is configured');
  });

  it('manifest entry has a non-empty slug containing the project dir basename', () => {
    const m = readManifest();
    const entry = m.repos[0];
    assert.ok(typeof entry.slug === 'string' && entry.slug.length > 0, 'slug must be a non-empty string');
    assert.ok(entry.slug.includes('project'), `slug must contain "project" (the repo basename); got: ${entry.slug}`);
  });

  it('re-running loom init is idempotent — still exactly one entry, same slug', () => {
    const before = readManifest();
    const slugBefore = before.repos[0].slug;

    runInit();

    const after = readManifest();
    assert.equal(after.repos.length, 1, 'idempotent re-init must not create a duplicate entry');
    assert.equal(after.repos[0].slug, slugBefore, 'slug must be unchanged after re-init');
  });

  it('machine-local ProjectRegistry and workspace manifest are written independently', () => {
    // Both registries must be written. The machine registry is at LOOM_HOME;
    // the manifest is in the project-level loom-home. Verify both exist.
    const machineLoom = path.join(tmpDir, 'machine-loom');
    assert.ok(fs.existsSync(machineLoom), 'machine-level ~/.loom (LOOM_HOME redirect) must exist');
    assert.ok(
      fs.existsSync(path.join(loomHomeDir, 'workspace.yaml')),
      'workspace.yaml must exist independently of the machine registry'
    );
  });
});
