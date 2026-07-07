/**
 * Integration tests for the /api/repos/* endpoints (story-081-002).
 *
 * Uses the same launch() helper pattern as server.test.ts: in-memory SQLite,
 * ephemeral HTTP server, isolated LOOM_HOME per test.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase,
  EpicStore,
  AgentStore,
  ProjectRegistry,
} from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';

const TOKEN = 'test-token-123';
const AUTH = { 'x-loom-token': TOKEN };

/** Spins the Express app on an ephemeral port, returns fetch helpers. */
async function launch(overrides: {
  projectRoot?: string;
  staticDir?: string;
} = {}): Promise<{
  db: Database.Database;
  projectRoot: string;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const db = createDatabase(':memory:');
  const projectRoot =
    overrides.projectRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'loom-repos-test-'));
  fs.mkdirSync(path.join(projectRoot, '.loom', 'logs'), { recursive: true });
  const app = createApp({
    db,
    token: TOKEN,
    projectRoot,
    loomBin: ['true'],
    ssePollMs: 50,
    ...(overrides.staticDir ? { staticDir: overrides.staticDir } : {}),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('bad addr');
  return {
    db,
    projectRoot,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

let db: Database.Database;
let projectRoot: string;
let baseUrl: string;
let close: () => Promise<void>;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-repos-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  ({ db, projectRoot, baseUrl, close } = await launch());
});

afterEach(async () => {
  await close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── Test case 1 & 2: GET /api/repos ─────────────────────────────────────────

describe('GET /api/repos', () => {
  it('(AC1) returns 200 with { repos: [] } when no repos are registered', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
    const body = (await res.json()) as { repos: unknown[] };
    assert.ok(Array.isArray(body.repos));
    assert.equal(body.repos.length, 0);
  });

  it('(AC1) returns 200 with full RepoSummary shape when a repo is registered', async () => {
    new ProjectRegistry().register(projectRoot);

    const res = await fetch(`${baseUrl}/api/repos`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
    const body = (await res.json()) as {
      repos: Array<{
        slug: string;
        root: string;
        is_current: boolean;
        epic_count: number;
        registered_at: string;
      }>;
    };
    assert.equal(body.repos.length, 1);
    const repo = body.repos[0];
    assert.equal(repo.slug, path.basename(projectRoot));
    assert.equal(repo.root, projectRoot);
    assert.equal(repo.is_current, true);
    assert.equal(typeof repo.epic_count, 'number');
    assert.equal(typeof repo.registered_at, 'string');
  });

  it('(AC2) returns 200 with { repos: [] } on empty registry — not 404 or 500', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { repos: unknown[] };
    assert.deepEqual(body.repos, []);
  });

  it('(AC1) epic_count reflects epics in the project DB', async () => {
    new ProjectRegistry().register(projectRoot);
    new EpicStore(db).create('epic-001', 'First epic');
    new EpicStore(db).create('epic-002', 'Second epic');

    const res = await fetch(`${baseUrl}/api/repos`, { headers: AUTH });
    const body = (await res.json()) as { repos: Array<{ epic_count: number }> };
    assert.equal(body.repos[0].epic_count, 2);
  });
});

// ─── Test case 3 & 4: GET /api/repos/:slug/epics ─────────────────────────────

describe('GET /api/repos/:slug/epics', () => {
  it('(AC3) returns 200 with { epics: EpicStatus[] } for a known slug', async () => {
    new ProjectRegistry().register(projectRoot);
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'First epic');
    const a = agents.create('epic-001', 'story-001-001', 'A story');
    agents.updateStatus(a.id, 'done');

    const slug = path.basename(projectRoot);
    const res = await fetch(`${baseUrl}/api/repos/${slug}/epics`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
    const body = (await res.json()) as {
      epics: Array<{
        id: string;
        title: string;
        status: string;
        stories: { total: number; done: number };
        updated_at: string;
        project_name: string;
        project_root: string;
        is_current_project: boolean;
        archived: boolean;
        intake_verdict: unknown;
      }>;
    };
    assert.ok(Array.isArray(body.epics));
    assert.equal(body.epics.length, 1);
    const epic = body.epics[0];
    assert.equal(epic.id, 'epic-001');
    assert.equal(epic.title, 'First epic');
    assert.equal(typeof epic.status, 'string');
    assert.equal(epic.stories.total, 1);
    assert.equal(epic.stories.done, 1);
    assert.equal(epic.project_root, projectRoot);
    assert.equal(epic.is_current_project, true);
    assert.equal(typeof epic.updated_at, 'string');
    assert.equal(typeof epic.archived, 'boolean');
  });

  it('(AC4) returns 404 { error: "repo not found" } for unknown slug', async () => {
    const res = await fetch(`${baseUrl}/api/repos/no-such-slug/epics`, { headers: AUTH });
    assert.equal(res.status, 404);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'repo not found');
  });
});

// ─── Test case 5, 6, 7: GET /api/repos/:slug/epics/:epicId/stories ───────────

describe('GET /api/repos/:slug/epics/:epicId/stories', () => {
  it('(AC5) returns 200 with { epic_id, stories: AgentSummary[] } for known ids', async () => {
    new ProjectRegistry().register(projectRoot);
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'First epic');
    agents.create('epic-001', 'story-001-001', 'Story one');
    agents.create('epic-001', 'story-001-002', 'Story two');

    const slug = path.basename(projectRoot);
    const res = await fetch(`${baseUrl}/api/repos/${slug}/epics/epic-001/stories`, {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
    const body = (await res.json()) as {
      epic_id: string;
      stories: Array<{
        id: string;
        story_id: string;
        story_title: string | null;
        status: string;
        stall_reason: string | null;
        model: string | null;
      }>;
    };
    assert.equal(body.epic_id, 'epic-001');
    assert.ok(Array.isArray(body.stories));
    assert.equal(body.stories.length, 2);
    assert.ok(body.stories.every((s) => typeof s.id === 'string'));
    assert.ok(body.stories.every((s) => typeof s.story_id === 'string'));
    assert.ok(body.stories.every((s) => typeof s.status === 'string'));
  });

  it('(AC6) returns 404 { error: "epic not found" } for unknown epicId', async () => {
    new ProjectRegistry().register(projectRoot);

    const slug = path.basename(projectRoot);
    const res = await fetch(`${baseUrl}/api/repos/${slug}/epics/epic-nope/stories`, {
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'epic not found');
  });

  it('(AC7) returns 404 { error: "repo not found" } for unknown slug — slug check fires first', async () => {
    const res = await fetch(`${baseUrl}/api/repos/unknown-slug/epics/epic-001/stories`, {
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'repo not found');
  });
});

// ─── Test case 8 & 9: GET /api/repos/:slug/epics/:epicId/stories/:storyId ─────

describe('GET /api/repos/:slug/epics/:epicId/stories/:storyId', () => {
  it('(AC8) returns 200 with AgentDetail shape for all known ids', async () => {
    new ProjectRegistry().register(projectRoot);
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'First epic');
    const a = agents.create('epic-001', 'story-001-001', 'My story');
    agents.updateStatus(a.id, 'done', { pr_url: 'https://example.com/pr/1' });

    const slug = path.basename(projectRoot);
    const res = await fetch(
      `${baseUrl}/api/repos/${slug}/epics/epic-001/stories/story-001-001`,
      { headers: AUTH }
    );
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
    const body = (await res.json()) as {
      id: string;
      story_id: string;
      story_title: string | null;
      status: string;
      epic_id: string;
      log_tail: string | null;
      worker_pid: number | null;
      worktree_path: string | null;
      branch_name: string | null;
      pr_url: string | null;
    };
    assert.equal(body.story_id, 'story-001-001');
    assert.equal(body.epic_id, 'epic-001');
    assert.equal(body.status, 'done');
    assert.equal(body.pr_url, 'https://example.com/pr/1');
    assert.ok('log_tail' in body);
    assert.ok('worker_pid' in body);
    assert.ok('worktree_path' in body);
    assert.ok('branch_name' in body);
  });

  it('(AC9) returns 404 { error: "story not found" } for unknown storyId', async () => {
    new ProjectRegistry().register(projectRoot);
    new EpicStore(db).create('epic-001', 'First epic');

    const slug = path.basename(projectRoot);
    const res = await fetch(
      `${baseUrl}/api/repos/${slug}/epics/epic-001/stories/story-nope`,
      { headers: AUTH }
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'story not found');
  });

  it('epic not found returned when epicId is invalid', async () => {
    new ProjectRegistry().register(projectRoot);

    const slug = path.basename(projectRoot);
    const res = await fetch(
      `${baseUrl}/api/repos/${slug}/epics/epic-nope/stories/story-001-001`,
      { headers: AUTH }
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'epic not found');
  });
});

// ─── Test case 10: SPA catch-all boundary ─────────────────────────────────────

describe('SPA catch-all boundary', () => {
  it('(AC10) GET /some-client-path returns HTML and /api/does-not-exist returns JSON 404', async () => {
    // Spin a fresh server with a real staticDir so the SPA catch-all is active.
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<html><body>SPA</body></html>');
    await close(); // tear down the default server

    const altProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-spa-test-'));
    fs.mkdirSync(path.join(altProjectRoot, '.loom', 'logs'), { recursive: true });
    const result = await launch({ projectRoot: altProjectRoot, staticDir });
    close = result.close;
    const altBaseUrl = result.baseUrl;

    try {
      // Client route → HTML
      const spaRes = await fetch(`${altBaseUrl}/some-client-path`);
      assert.equal(spaRes.status, 200);
      assert.ok(
        spaRes.headers.get('content-type')?.includes('text/html'),
        'SPA route should return text/html'
      );

      // Unknown API route → JSON 404 (not index.html)
      const apiRes = await fetch(`${altBaseUrl}/api/does-not-exist`, { headers: AUTH });
      assert.equal(apiRes.status, 404);
      assert.ok(
        apiRes.headers.get('content-type')?.includes('application/json'),
        `content-type should be application/json, got: ${apiRes.headers.get('content-type')}`
      );
      const apiBody = (await apiRes.json()) as { error: string };
      assert.ok(typeof apiBody.error === 'string', 'error field must be a string');
    } finally {
      fs.rmSync(staticDir, { recursive: true, force: true });
      fs.rmSync(altProjectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Test case 11: Slug collision ─────────────────────────────────────────────

describe('Slug collision edge case', () => {
  it('(AC11) two repos with same basename — returns first match, not a 500', async () => {
    // Two temp dirs under different parents, both named the same thing.
    const parent1 = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-parent1-'));
    const parent2 = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-parent2-'));
    const shared = 'sameslug';
    const root1 = path.join(parent1, shared);
    const root2 = path.join(parent2, shared);
    fs.mkdirSync(root1, { recursive: true });
    fs.mkdirSync(root2, { recursive: true });

    try {
      const reg = new ProjectRegistry();
      reg.register(root1);
      reg.register(root2);

      // The current server is launched with projectRoot=projectRoot (different
      // from root1/root2). Hit the slug that matches both registrations.
      const res = await fetch(`${baseUrl}/api/repos/${shared}/epics`, { headers: AUTH });
      // Must NOT be 500. Either 200 (if the peer DB is accessible/empty) or 404
      // if the first matched root has no DB file. Both are acceptable; 500 is not.
      assert.notEqual(res.status, 500, 'slug collision must not cause a 500');
      // Body must be JSON regardless.
      assert.ok(
        res.headers.get('content-type')?.includes('application/json'),
        'response must be JSON'
      );
    } finally {
      fs.rmSync(parent1, { recursive: true, force: true });
      fs.rmSync(parent2, { recursive: true, force: true });
    }
  });
});

// ─── Test case 12: GET-only surface ──────────────────────────────────────────

describe('GET-only endpoints', () => {
  it('(AC12) POST to /api/repos returns 404 or 405 — no mutation surface', async () => {
    new ProjectRegistry().register(projectRoot);
    const slug = path.basename(projectRoot);

    for (const url of [
      `${baseUrl}/api/repos`,
      `${baseUrl}/api/repos/${slug}/epics`,
      `${baseUrl}/api/repos/${slug}/epics/epic-001/stories`,
      `${baseUrl}/api/repos/${slug}/epics/epic-001/stories/story-001-001`,
    ]) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.ok(
        res.status === 404 || res.status === 405,
        `POST to ${url} should return 404 or 405, got ${res.status}`
      );
    }
  });
});
