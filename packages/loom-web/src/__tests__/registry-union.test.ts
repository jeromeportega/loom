/**
 * Tests for registry.ts (resolveActiveLoomHome + buildUnifiedRegistry) and the
 * repos route integration via registerRepoRoutes with a pre-seeded unifiedRegistry.
 *
 * Owner: story-085-003 (story-085-004 extends)
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { resolveActiveLoomHome, buildUnifiedRegistry } from '../server/registry.js';
import { registerRepoRoutes } from '../server/routes/repos.js';
import { createApp } from '../server/index.js';
import { createDatabase } from '@loom-ai/core';
import type { ProjectEntry } from '@loom-ai/core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeRegistry(dir: string, entries: ProjectEntry[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify({ projects: entries }, null, 2) + '\n',
  );
}

function writePolicyYaml(loomDir: string, content: string): void {
  fs.mkdirSync(loomDir, { recursive: true });
  fs.writeFileSync(path.join(loomDir, 'policy.yaml'), content);
}

/** Starts a minimal Express app with registerRepoRoutes and returns fetch helpers. */
async function launchRouteApp(unifiedRegistry: Map<string, ProjectEntry>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  registerRepoRoutes(app, { db: null, projectRoot: null, unifiedRegistry });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))
    ),
  };
}

// ─── resolveActiveLoomHome ────────────────────────────────────────────────────

describe('resolveActiveLoomHome', () => {
  let tmpDir: string;
  let prevLoomHome: string | undefined;

  beforeEach(() => {
    prevLoomHome = process.env.LOOM_HOME;
    delete process.env.LOOM_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reg-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = prevLoomHome;
  });

  it('returns LOOM_HOME env value when set, ignoring loomDir', () => {
    process.env.LOOM_HOME = '/from-env';
    const loomDir = path.join(tmpDir, '.loom');
    writePolicyYaml(loomDir, 'loom_home: /from-policy\n');
    assert.equal(resolveActiveLoomHome(loomDir, '/machine-default'), '/from-env');
  });

  it('returns policy.loom_home when LOOM_HOME is unset and policy.yaml has loom_home', () => {
    const loomDir = path.join(tmpDir, '.loom');
    writePolicyYaml(loomDir, 'loom_home: /custom\n');
    assert.equal(resolveActiveLoomHome(loomDir, '/machine-default'), '/custom');
  });

  it('returns machineDefault when LOOM_HOME unset and loomDir is null', () => {
    assert.equal(resolveActiveLoomHome(null, '/machine-default'), '/machine-default');
  });

  it('returns machineDefault when LOOM_HOME unset and loomDir has no policy.yaml', () => {
    const loomDir = path.join(tmpDir, '.loom-empty');
    fs.mkdirSync(loomDir, { recursive: true });
    assert.equal(resolveActiveLoomHome(loomDir, '/machine-default'), '/machine-default');
  });
});

// ─── buildUnifiedRegistry ─────────────────────────────────────────────────────

describe('buildUnifiedRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reg-build-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('non-overlapping entries: both appear in result', () => {
    const activeHome = path.join(tmpDir, 'active');
    const machineHome = path.join(tmpDir, 'machine');
    // Create actual dirs so they show up as existing in the entries
    const activeRoot = path.join(tmpDir, 'proj-active');
    const machineRoot = path.join(tmpDir, 'proj-machine');
    fs.mkdirSync(activeRoot, { recursive: true });
    fs.mkdirSync(machineRoot, { recursive: true });

    writeRegistry(activeHome, [{ root: activeRoot, registeredAt: '2024-01-01T00:00:00Z' }]);
    writeRegistry(machineHome, [{ root: machineRoot, registeredAt: '2024-01-01T00:00:00Z' }]);

    const { registry } = buildUnifiedRegistry(activeHome, machineHome, null);

    assert.ok(registry.has(activeRoot), 'active entry should be in registry');
    assert.ok(registry.has(machineRoot), 'machine entry should be in registry');
    assert.equal(registry.size, 2);
  });

  it('overlapping path: active-loom_home metadata wins over machine-default', () => {
    const activeHome = path.join(tmpDir, 'active');
    const machineHome = path.join(tmpDir, 'machine');
    const sharedRoot = path.join(tmpDir, 'shared-proj');
    fs.mkdirSync(sharedRoot, { recursive: true });

    writeRegistry(machineHome, [{ root: sharedRoot, registeredAt: '2024-01-01T00:00:00Z' }]);
    writeRegistry(activeHome, [{ root: sharedRoot, registeredAt: '2024-06-01T00:00:00Z' }]);

    const { registry } = buildUnifiedRegistry(activeHome, machineHome, null);

    assert.equal(registry.size, 1);
    const entry = registry.get(sharedRoot);
    assert.ok(entry, 'shared entry should be present');
    assert.equal(entry?.registeredAt, '2024-06-01T00:00:00Z', 'active metadata should win');
  });

  it('currentProject absent from both registries is force-included', () => {
    const activeHome = path.join(tmpDir, 'active');
    const machineHome = path.join(tmpDir, 'machine');
    const projectRoot = path.join(tmpDir, 'my-project');
    const loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(projectRoot, { recursive: true });

    const { registry } = buildUnifiedRegistry(activeHome, machineHome, { projectRoot, loomDir });

    assert.ok(registry.has(projectRoot), 'currentProject should be force-included');
    const entry = registry.get(projectRoot);
    assert.ok(entry, 'force-included entry must be present');
    assert.equal(entry?.root, projectRoot);
  });

  it('currentProject already in active registry is not duplicated', () => {
    const activeHome = path.join(tmpDir, 'active');
    const machineHome = path.join(tmpDir, 'machine');
    const projectRoot = path.join(tmpDir, 'my-project');
    const loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(projectRoot, { recursive: true });

    writeRegistry(activeHome, [{ root: projectRoot, registeredAt: '2024-01-01T00:00:00Z' }]);

    const { registry } = buildUnifiedRegistry(activeHome, machineHome, { projectRoot, loomDir });

    assert.equal(registry.size, 1, 'no duplicate should be added');
    assert.ok(registry.has(projectRoot));
  });

  it('self-heal write succeeds: active projects.json is updated on disk', () => {
    const activeHome = path.join(tmpDir, 'active');
    const machineHome = path.join(tmpDir, 'machine');
    const projectRoot = path.join(tmpDir, 'my-project');
    const loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(projectRoot, { recursive: true });

    const { selfHealOccurred, registry } = buildUnifiedRegistry(
      activeHome, machineHome, { projectRoot, loomDir },
    );

    assert.ok(selfHealOccurred, 'selfHealOccurred should be true');
    assert.ok(registry.has(projectRoot));

    const registryFile = path.join(activeHome, 'projects.json');
    assert.ok(fs.existsSync(registryFile), 'active projects.json should be created');
    const content = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as { projects: ProjectEntry[] };
    assert.ok(content.projects.some(e => e.root === projectRoot), 'projects.json should contain currentProject');
  });

  it('self-heal write fails silently when fs.writeFileSync throws', () => {
    const activeHome = path.join(tmpDir, 'active');
    const machineHome = path.join(tmpDir, 'machine');
    const projectRoot = path.join(tmpDir, 'my-project');
    const loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(activeHome, { recursive: true }); // ensure dir exists so mkdirSync in self-heal passes

    const writeMock = mock.method(fs, 'writeFileSync', (): void => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    try {
      let result: ReturnType<typeof buildUnifiedRegistry>;
      assert.doesNotThrow(() => {
        result = buildUnifiedRegistry(activeHome, machineHome, { projectRoot, loomDir });
      });
      assert.ok(result!.registry.has(projectRoot), 'currentProject must be in registry despite write failure');
      assert.equal(result!.selfHealOccurred, false, 'selfHealOccurred should be false on write failure');

      const registryFile = path.join(activeHome, 'projects.json');
      assert.equal(fs.existsSync(registryFile), false, 'projects.json must not be created on write failure');
    } finally {
      writeMock.mock.restore();
    }
  });

  it('both registry files missing: result is empty (or only currentProject)', () => {
    const activeHome = path.join(tmpDir, 'active-missing');
    const machineHome = path.join(tmpDir, 'machine-missing');

    // No currentProject
    const { registry: emptyResult } = buildUnifiedRegistry(activeHome, machineHome, null);
    assert.equal(emptyResult.size, 0, 'empty map when both registries missing and no currentProject');

    // With currentProject
    const projectRoot = path.join(tmpDir, 'my-project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const { registry: withProject } = buildUnifiedRegistry(
      activeHome, machineHome,
      { projectRoot, loomDir: path.join(projectRoot, '.loom') },
    );
    assert.equal(withProject.size, 1);
    assert.ok(withProject.has(projectRoot));
  });

  // ─── FR-7 test (b): 3-way union with overlap ─────────────────────────────

  it('(b) 3-way union /a /b /c where /b overlaps: size=3, active-loom_home metadata wins', () => {
    const activeHome = path.join(tmpDir, 'active-3way');
    const machineHome = path.join(tmpDir, 'machine-3way');

    // active-loom_home registry: /a and /b (with /b registeredAt = '2024-06-01')
    writeRegistry(activeHome, [
      { root: '/a', registeredAt: '2024-01-01T00:00:00Z' },
      { root: '/b', registeredAt: '2024-06-01T00:00:00Z' },
    ]);
    // machine-default registry: /b and /c (with /b registeredAt = '2024-01-01' — lower priority)
    writeRegistry(machineHome, [
      { root: '/b', registeredAt: '2024-01-01T00:00:00Z' },
      { root: '/c', registeredAt: '2024-02-01T00:00:00Z' },
    ]);

    const { registry } = buildUnifiedRegistry(activeHome, machineHome, null);

    assert.equal(registry.size, 3, 'union must contain /a, /b, /c (3 entries)');
    assert.ok(registry.has('/a'), '/a must be in registry');
    assert.ok(registry.has('/b'), '/b must be in registry');
    assert.ok(registry.has('/c'), '/c must be in registry');
    const bEntry = registry.get('/b');
    assert.ok(bEntry, '/b entry must be present');
    assert.equal(bEntry?.registeredAt, '2024-06-01T00:00:00Z',
      'active-loom_home /b metadata must win over machine-default');
  });

  // ─── FR-7 test (c): force-include with explicit path ─────────────────────

  it('(c) force-include currentProject.projectRoot=/x: /x appears in returned map', () => {
    const activeHome = path.join(tmpDir, 'active-force-x');
    const machineHome = path.join(tmpDir, 'machine-force-x');
    // Both registries intentionally empty (no projects.json files written)

    const { registry } = buildUnifiedRegistry(activeHome, machineHome, {
      projectRoot: '/x',
      loomDir: '/x/.loom',
    });

    assert.ok(registry.has('/x'), '/x must be force-included even when absent from both registries');
    const entry = registry.get('/x');
    assert.equal(entry?.root, '/x', 'force-included entry must have root=/x');
  });
});

// ─── GET /api/repos integration ───────────────────────────────────────────────

describe('GET /api/repos — integration via registerRepoRoutes', () => {
  let serverInfo: Awaited<ReturnType<typeof launchRouteApp>> | undefined;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-repos-int-'));
  });

  afterEach(async () => {
    await serverInfo?.close();
    serverInfo = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 200 { repos: [] } when unifiedRegistry is empty', async () => {
    const unifiedRegistry = new Map<string, ProjectEntry>();
    serverInfo = await launchRouteApp(unifiedRegistry);

    const res = await fetch(`${serverInfo.baseUrl}/api/repos`);
    assert.equal(res.status, 200);
    const body = await res.json() as { repos: unknown[] };
    assert.deepEqual(body.repos, []);
  });

  it('returns both repos when unifiedRegistry contains two entries', async () => {
    const root1 = path.join(tmpDir, 'proj-one');
    const root2 = path.join(tmpDir, 'proj-two');
    fs.mkdirSync(root1, { recursive: true });
    fs.mkdirSync(root2, { recursive: true });

    const unifiedRegistry = new Map<string, ProjectEntry>([
      [root1, { root: root1, registeredAt: '2024-01-01T00:00:00Z' }],
      [root2, { root: root2, registeredAt: '2024-02-01T00:00:00Z' }],
    ]);
    serverInfo = await launchRouteApp(unifiedRegistry);

    const res = await fetch(`${serverInfo.baseUrl}/api/repos`);
    assert.equal(res.status, 200);
    const body = await res.json() as { repos: Array<{ root: string; slug: string }> };
    assert.equal(body.repos.length, 2);
    const roots = body.repos.map(r => r.root);
    assert.ok(roots.includes(root1));
    assert.ok(roots.includes(root2));
  });

  it('(AC path-traversal guard) unknown slug → 404, no file created on disk', async () => {
    // A nonexistent path that should never be touched by the handler
    const phantom = path.join(tmpDir, 'phantom-project');
    const phantomDb = path.join(phantom, '.loom', 'loom.db');
    assert.equal(fs.existsSync(phantom), false, 'phantom dir must not exist before request');

    const unifiedRegistry = new Map<string, ProjectEntry>(); // empty — phantom not registered
    serverInfo = await launchRouteApp(unifiedRegistry);

    const slug = path.basename(phantom); // slug that isn't in registry
    const res = await fetch(`${serverInfo.baseUrl}/api/repos/${slug}/epics`);
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'repo not found');

    // No disk side effects
    assert.equal(fs.existsSync(phantom), false, 'phantom dir must not be created by the handler');
    assert.equal(fs.existsSync(phantomDb), false, 'no DB must be created at phantom path');
  });
});

// ─── FR-7 test (a): createApp no-project startup ──────────────────────────────

describe('createApp — no-project startup (FR-7 test a)', () => {
  let baseUrl: string;
  let server: http.Server;
  let prevLoomHome: string | undefined;
  let loomHomeDir: string;

  before(async () => {
    prevLoomHome = process.env.LOOM_HOME;
    loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-noproj-home-'));
    process.env.LOOM_HOME = loomHomeDir;

    const app = createApp({ db: null, projectRoot: null, unifiedRegistry: new Map(), token: 'test' });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))
    );
    fs.rmSync(loomHomeDir, { recursive: true, force: true });
    if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = prevLoomHome;
  });

  it('(a) GET /api/repos returns 200 { repos: [] } when server starts with no current project', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      headers: { 'x-loom-token': 'test' },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { repos: unknown[] };
    assert.deepEqual(body, { repos: [] });
  });
});

// ─── FR-7 test (d): createApp 404 guard, no disk side-effects ─────────────────

describe('createApp — unregistered slug 404 guard (FR-7 test d)', () => {
  let baseUrl: string;
  let server: http.Server;
  let tmpDir: string;
  let prevLoomHome: string | undefined;
  let loomHomeDir: string;

  before(async () => {
    prevLoomHome = process.env.LOOM_HOME;
    loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-404guard-home-'));
    process.env.LOOM_HOME = loomHomeDir;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-404guard-test-'));
    const projectRoot = path.join(tmpDir, 'known-project');
    fs.mkdirSync(path.join(projectRoot, '.loom', 'logs'), { recursive: true });

    // unifiedRegistry contains only the known project; phantom-project is absent
    const knownEntry: ProjectEntry = { root: projectRoot, registeredAt: '2024-01-01T00:00:00Z' };
    const unifiedRegistry = new Map<string, ProjectEntry>([[projectRoot, knownEntry]]);

    const db = createDatabase(':memory:');
    const app = createApp({
      db,
      projectRoot,
      unifiedRegistry,
      token: 'test',
      loomBin: ['true'],
      ssePollMs: 50,
    });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(loomHomeDir, { recursive: true, force: true });
    if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = prevLoomHome;
  });

  it('(d) unregistered slug → 404, no files created under that path', async () => {
    const phantomRoot = path.join(tmpDir, 'phantom-project');
    const phantomDb = path.join(phantomRoot, '.loom', 'loom.db');
    assert.equal(fs.existsSync(phantomRoot), false, 'phantom dir must not exist before request');

    const slug = 'phantom-project'; // slug not present in unifiedRegistry or LOOM_HOME registry
    const res = await fetch(`${baseUrl}/api/repos/${slug}/epics`, {
      headers: { 'x-loom-token': 'test' },
    });

    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'repo not found');

    // No disk side-effects: handler must not create any files under the phantom path
    assert.equal(fs.existsSync(phantomRoot), false, 'phantom dir must not be created by the handler');
    assert.equal(fs.existsSync(phantomDb), false, 'no DB must be created at phantom path');
  });
});
