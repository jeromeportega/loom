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
  AuditLog,
  ControlStore,
  SkillUsageStore,
  LeaseStore,
} from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';

/**
 * Spins the Express app on an ephemeral port, returns a `fetch`-ish helper
 * scoped to that base URL. Each test gets its own fresh DB + server.
 */
async function launch(token = 'test-token-123', ssePollMs = 50): Promise<{
  db: Database.Database;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const db = createDatabase(':memory:');
  // loomBin: ['true'] makes the approve handler's spawn a no-op
  // (the GNU/BSD `true` accepts any args and exits 0). Tests assert
  // DB+audit side effects, not the actual supervisor.
  const app = createApp({ db, token, ssePollMs, loomBin: ['true'] });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('server.address() returned unexpected shape');
  }
  return {
    db,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

let db: Database.Database;
let baseUrl: string;
let close: () => Promise<void>;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(async () => {
  // Isolate the machine-level loom home so /api/status federation cannot pick
  // up the developer's real ~/.loom registry. Without this the "fresh DB"
  // status assertions fail on any machine with other loom projects registered
  // (CI's HOME is clean, so the leak only bites locally).
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-web-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  ({ db, baseUrl, close } = await launch());
});
afterEach(async () => {
  await close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

describe('loom-web — auth', () => {
  it('returns 401 for /api/* without the token', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.equal(res.status, 401);
  });

  it('returns 200 for /api/health without a token (health is unauthenticated)', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('accepts the token via the x-loom-token header', async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    assert.equal(res.status, 200);
  });

  it('accepts the token via ?token=', async () => {
    const res = await fetch(`${baseUrl}/api/status?token=test-token-123`);
    assert.equal(res.status, 200);
  });

  it('rejects a wrong token', async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'wrong-token' },
    });
    assert.equal(res.status, 401);
  });
});

describe('loom-web — GET /api/status', () => {
  it('returns an empty epics list when the DB is fresh', async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const body = (await res.json()) as { epics: unknown[] };
    assert.equal(body.epics.length, 0);
  });

  it('returns an EpicStatus per epic with story counts derived from agents', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'Add authentication');
    epics.updateStatus('epic-001', 'in_progress');
    const a1 = agents.create('epic-001', 'story-001-001', 'Login endpoint');
    const a2 = agents.create('epic-001', 'story-001-002', 'JWT signing');
    const a3 = agents.create('epic-001', 'story-001-003', 'Refresh tokens');
    agents.updateStatus(a1.id, 'done');
    agents.updateStatus(a2.id, 'failed');
    agents.updateStatus(a3.id, 'pending');

    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const body = (await res.json()) as {
      epics: Array<{ id: string; status: string; stories: Record<string, number> }>;
    };
    assert.equal(body.epics.length, 1);
    const epic = body.epics[0];
    assert.equal(epic.id, 'epic-001');
    assert.equal(epic.status, 'in_progress');
    assert.equal(epic.stories.total, 3);
    assert.equal(epic.stories.done, 1);
    assert.equal(epic.stories.failed, 1);
    assert.equal(epic.stories.pending, 1);
  });
});

describe('loom-web — GET /api/epics/:id', () => {
  it('returns 404 for an unknown epic id', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-999`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    assert.equal(res.status, 404);
  });

  it('returns EpicDetail with the agent list', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'Add health endpoint');
    const a1 = agents.create('epic-001', 'story-001-001', 'Add /health route');
    agents.setUsage(a1.id, {
      tokens_input: 100,
      tokens_output: 200,
      cost_usd: 0.05,
      request_count: 3,
    });
    agents.setReview(a1.id, 'passed', 'no findings');
    agents.updateStatus(a1.id, 'done', { pr_url: 'https://example.com/pr/1' });

    const res = await fetch(`${baseUrl}/api/epics/epic-001`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      agents: Array<{
        story_id: string;
        status: string;
        tokens_total: number | null;
        cost_usd: number | null;
        request_count: number | null;
        review_status: string | null;
        pr_url: string | null;
      }>;
    };
    assert.equal(body.id, 'epic-001');
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].story_id, 'story-001-001');
    assert.equal(body.agents[0].status, 'done');
    assert.equal(body.agents[0].tokens_total, 300);
    assert.equal(body.agents[0].cost_usd, 0.05);
    assert.equal(body.agents[0].request_count, 3);
    assert.equal(body.agents[0].review_status, 'passed');
    assert.equal(body.agents[0].pr_url, 'https://example.com/pr/1');
  });

  it('collapses retry attempts to one row per story_id (v0.5.0)', async () => {
    // The bug pre-v0.5.0: `/api/epics/:id` listed every agent row, so a
    // retried-blocked-then-done story showed twice — once as `blocked`
    // (old attempt) and once as `done` (new attempt). Lock the regression
    // by seeding two agents for the same story_id and asserting one row
    // with the newer attempt's status.
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'Retry dedup test');
    const older = agents.create('epic-001', 'story-001-001', 'pick a name');
    agents.updateStatus(older.id, 'blocked');
    await new Promise((r) => setTimeout(r, 5));
    const newer = agents.create('epic-001', 'story-001-001', 'pick a name');
    agents.updateStatus(newer.id, 'done');

    const res = await fetch(`${baseUrl}/api/epics/epic-001`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      agents: Array<{ id: string; story_id: string; status: string }>;
      stories: { total: number; done: number; blocked: number };
    };
    assert.equal(body.agents.length, 1, 'one row per story_id');
    assert.equal(body.agents[0].id, newer.id, 'the latest attempt is returned');
    assert.equal(body.agents[0].status, 'done');
    // countByStatus is downstream of the same dedup, so the epic card
    // count must agree: one done, zero blocked.
    assert.equal(body.stories.done, 1);
    assert.equal(body.stories.blocked, 0);
  });
});

describe('loom-web — planning-state visibility', () => {
  it('GET /api/status surfaces planning epics with their current phase', async () => {
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-001', 'Build a /health endpoint that returns 200');
    epics.updatePlanningPhase('epic-001', 'pm');

    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const body = (await res.json()) as {
      epics: Array<{ id: string; status: string; planning_phase: string | null }>;
    };
    assert.equal(body.epics.length, 1);
    assert.equal(body.epics[0].status, 'planning');
    assert.equal(body.epics[0].planning_phase, 'pm');
  });

  it('GET /api/epics/:id surfaces user_brief on the detail response', async () => {
    const epics = new EpicStore(db);
    const userBrief = 'Add a /health endpoint that returns 200 with build info';
    epics.beginPlanning('epic-001', userBrief);

    const res = await fetch(`${baseUrl}/api/epics/epic-001`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const body = (await res.json()) as {
      user_brief: string;
      planning_phase: string | null;
      status: string;
    };
    assert.equal(body.user_brief, userBrief);
    assert.equal(body.status, 'planning');
    assert.equal(body.planning_phase, 'analyst');
  });

  it('completePlanning flips status to planned and clears the phase', async () => {
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-001', 'rough brief');
    epics.completePlanning('epic-001', 'Add /health endpoint');

    const res = await fetch(`${baseUrl}/api/epics/epic-001`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const body = (await res.json()) as { status: string; title: string; planning_phase: string | null };
    assert.equal(body.status, 'planned');
    assert.equal(body.title, 'Add /health endpoint');
    assert.equal(body.planning_phase, null);
  });
});

describe('loom-web — cross-repo federation of /api/status', () => {
  it('aggregates epics from every registered project, attributes each row', async () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const { createDatabase, EpicStore, ProjectRegistry } = require('@loom-ai/core') as typeof import('@loom-ai/core');

    // Two fake projects on disk, each with its own .loom/loom.db. The web
    // server is launched in projectA; projectB shows up as a peer via the
    // ProjectRegistry redirected to a temp HOME.
    const loomHomeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-home-'));
    const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-projA-'));
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-projB-'));
    fs.mkdirSync(path.join(projectA, '.loom'), { recursive: true });
    fs.mkdirSync(path.join(projectB, '.loom'), { recursive: true });

    const prevLoomHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = loomHomeTmp;
    try {
      new ProjectRegistry().register(projectA);
      new ProjectRegistry().register(projectB);

      // Use createDatabase (non-singleton) for both fixtures so they live
      // as separate connections — openDatabase() is a process-wide singleton
      // and would alias the two DBs together.
      const dbA = createDatabase(path.join(projectA, '.loom', 'loom.db'));
      new EpicStore(dbA).create('epic-A1', 'In project A');

      const dbB = createDatabase(path.join(projectB, '.loom', 'loom.db'));
      new EpicStore(dbB).create('epic-B1', 'In project B');
      dbB.close();

      // Tear down the default beforeEach() server; bring up a new one
      // rooted at projectA so the federation pass picks projectB as a peer.
      await close();
      const app = createApp({
        db: dbA,
        token: 'test-token-123',
        projectRoot: projectA,
        loomBin: ['true'],
        ssePollMs: 50,
      });
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('bad addr');
      const url = `http://127.0.0.1:${addr.port}`;
      close = () =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );

      const res = await fetch(`${url}/api/status`, {
        headers: { 'x-loom-token': 'test-token-123' },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        epics: Array<{
          id: string;
          project_name: string;
          project_root: string;
          is_current_project: boolean;
        }>;
      };
      const ids = body.epics.map((e) => e.id).sort();
      assert.deepEqual(ids, ['epic-A1', 'epic-B1']);
      const a = body.epics.find((e) => e.id === 'epic-A1')!;
      const b = body.epics.find((e) => e.id === 'epic-B1')!;
      assert.equal(a.project_root, projectA);
      assert.equal(a.is_current_project, true);
      assert.equal(b.project_root, projectB);
      assert.equal(b.is_current_project, false);
      assert.equal(a.project_name, path.basename(projectA));
      assert.equal(b.project_name, path.basename(projectB));

      dbA.close();
    } finally {
      if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = prevLoomHome;
      fs.rmSync(loomHomeTmp, { recursive: true, force: true });
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('rejects ?project=<unregistered> with 400 on the detail endpoint', async () => {
    const res = await fetch(
      `${baseUrl}/api/epics/epic-001?project=${encodeURIComponent('/not/a/registered/root')}`,
      {
        headers: { 'x-loom-token': 'test-token-123' },
      },
    );
    assert.equal(res.status, 400);
  });
});

describe('loom-web — GET /api/epics/:id/planning-artifacts', () => {
  it('returns 404 when the epic does not exist', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-nope/planning-artifacts`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    assert.equal(res.status, 404);
  });

  it('returns null bodies + null paths when nothing has been planned yet', async () => {
    const epics = new EpicStore(db);
    epics.create('epic-001', 'Untouched epic');

    const res = await fetch(`${baseUrl}/api/epics/epic-001/planning-artifacts`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      epic_id: string;
      brief: string | null;
      prd: string | null;
      architecture: string | null;
      epic_yaml: string | null;
    };
    assert.equal(body.epic_id, 'epic-001');
    assert.equal(body.brief, null);
    assert.equal(body.prd, null);
    assert.equal(body.architecture, null);
    // create() seeds yaml_path; that file isn't on disk in this fixture, so
    // the body is null — but the path is still reported.
    assert.equal(body.epic_yaml, null);
  });

  it('reads the four documents from disk and architecture next to the brief', async () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-web-art-'));
    try {
      // Re-launch with this temp dir as projectRoot so readMaybe resolves to
      // it. The default beforeEach() launch has projectRoot=process.cwd().
      await close();
      const freshDb = createDatabase(':memory:');
      const app = createApp({
        db: freshDb,
        token: 'test-token-123',
        projectRoot: root,
        loomBin: ['true'],
        ssePollMs: 50,
      });
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('bad addr');
      const url = `http://127.0.0.1:${addr.port}`;
      // Re-point the module-level close() so afterEach() tears down THIS
      // server instead of the one we replaced.
      close = () =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );

      fs.mkdirSync(path.join(root, 'epics', 'epic-001'), { recursive: true });
      fs.writeFileSync(path.join(root, 'epics', 'epic-001', 'brief.md'), 'BRIEF body');
      fs.writeFileSync(path.join(root, 'epics', 'epic-001', 'prd.md'), 'PRD body');
      fs.writeFileSync(path.join(root, 'epics', 'epic-001', 'architecture.md'), 'ARCH body');
      fs.writeFileSync(path.join(root, 'epics', 'epic-001', 'epic.yaml'), 'YAML body');

      const epics = new EpicStore(freshDb);
      epics.create('epic-001', 'With docs');
      epics.updatePaths('epic-001', {
        brief_path: 'epics/epic-001/brief.md',
        prd_path: 'epics/epic-001/prd.md',
        yaml_path: 'epics/epic-001/epic.yaml',
      });

      const res = await fetch(`${url}/api/epics/epic-001/planning-artifacts`, {
        headers: { 'x-loom-token': 'test-token-123' },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        brief: string | null;
        prd: string | null;
        architecture: string | null;
        epic_yaml: string | null;
        paths: { architecture: string | null };
      };
      assert.equal(body.brief, 'BRIEF body');
      assert.equal(body.prd, 'PRD body');
      assert.equal(body.architecture, 'ARCH body');
      assert.equal(body.epic_yaml, 'YAML body');
      assert.equal(body.paths.architecture, 'epics/epic-001/architecture.md');

      freshDb.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('loom-web — GET /api/agents/:id and /audit', () => {
  it('returns 404 for an unknown agent', async () => {
    const res = await fetch(`${baseUrl}/api/agents/nope`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    assert.equal(res.status, 404);
  });

  it('returns AgentDetail and the audit log entries', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    epics.create('epic-001', 'Add health endpoint');
    const a = agents.create('epic-001', 'story-001-001', 'Add /health route');
    agents.updateStatus(a.id, 'done', { log_tail: 'final worker tail' });
    audit.record({ agent_id: a.id, action: 'completion', command: 'story-001-001' });
    audit.record({ agent_id: a.id, action: 'code_review_pass', command: 'story-001-001' });

    const detailRes = await fetch(`${baseUrl}/api/agents/${a.id}`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const detail = (await detailRes.json()) as { id: string; log_tail: string };
    assert.equal(detail.id, a.id);
    assert.equal(detail.log_tail, 'final worker tail');

    const auditRes = await fetch(`${baseUrl}/api/agents/${a.id}/audit`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const auditBody = (await auditRes.json()) as { entries: Array<{ action: string }> };
    assert.equal(auditBody.entries.length, 2);
    assert.ok(auditBody.entries.some((e) => e.action === 'code_review_pass'));
  });
});

describe('loom-web — GET /api/cost', () => {
  it('returns per-epic cost rollup with totals', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'JWT auth');
    epics.updateTokens(
      'epic-001',
      { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, requestCount: 4 },
      5000
    );
    const a1 = agents.create('epic-001', 'story-001-001', 'Login');
    // cursor-cli-shaped usage: zero USD cost, but a real request count — the
    // pre-fix report rolled this up to $0.00 with no request dimension at all.
    agents.setUsage(a1.id, {
      tokens_input: 10, tokens_output: 20, tokens_cached: 30, tokens_cache_creation: 40, cost_usd: 0.5,
      request_count: 2,
    });
    agents.updateStatus(a1.id, 'done', { pr_url: 'https://example.com/pr/1' });

    const res = await fetch(`${baseUrl}/api/cost`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const report = (await res.json()) as {
      epics: Array<{
        epic_id: string;
        worker_tokens: number;
        worker_cost_usd: number;
        worker_requests: number;
        planner_requests: number;
        prs: number;
      }>;
      totals: { worker_tokens: number; worker_cost_usd: number; worker_requests: number; planner_requests: number; prs: number };
    };
    assert.equal(report.epics.length, 1);
    assert.equal(report.epics[0].worker_tokens, 100); // 10+20+30+40
    assert.equal(report.epics[0].worker_cost_usd, 0.5);
    assert.equal(report.epics[0].worker_requests, 2);
    assert.equal(report.epics[0].planner_requests, 4);
    assert.equal(report.epics[0].prs, 1);
    assert.equal(report.totals.prs, 1);
    assert.equal(report.totals.worker_requests, 2);
    assert.equal(report.totals.planner_requests, 4);
  });
});

describe('loom-web — GET /api/projects (multi-repo first slice, #15)', () => {
  it('returns the empty list when no projects are registered', async () => {
    // The default constructor reads ~/.loom/projects.json. Tests inherit
    // whatever the dev machine has. The shape check (array, has expected
    // keys when populated) is what's load-bearing.
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      projects: Array<{
        name: string;
        root: string;
        registered_at: string;
        is_current: boolean;
        epic_count: number;
        latest_epic?: { id: string; title: string; status: string };
      }>;
    };
    assert.ok(Array.isArray(body.projects));
    for (const p of body.projects) {
      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.root, 'string');
      assert.equal(typeof p.epic_count, 'number');
      assert.equal(typeof p.is_current, 'boolean');
    }
  });
});

describe('loom-web — GET /api/skills/:name/history', () => {
  it('returns a chronological timeline merging audit log and injections', async () => {
    const usage = new SkillUsageStore(db);
    const audit = new AuditLog(db);

    audit.record({
      action: 'skill_generated',
      command: 'jwt-auth',
      detail: { story_id: 'story-001-001', lifecycle: 'candidate' },
    });
    usage.recordInjection('jwt-auth', 'agent-1', 'story-001-002');
    usage.recordOutcome('agent-1', 'done');
    audit.record({
      action: 'skill_lifecycle_change',
      command: 'jwt-auth',
      detail: { from: 'candidate', to: 'active', reason: 'good track record' },
    });

    const res = await fetch(`${baseUrl}/api/skills/jwt-auth/history`, {
      headers: { 'x-loom-token': 'test-token-123' },
    });
    const body = (await res.json()) as { rows: Array<{ kind: string; text: string }> };
    assert.equal(body.rows.length, 3);
    // SQLite's DATETIME default has 1-second precision; same-second rows can
    // tie, so we don't assert the order — only presence of all three kinds.
    const kinds = body.rows.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['generated', 'injected', 'lifecycle']);
    const lifecycleRow = body.rows.find((r) => r.kind === 'lifecycle');
    assert.match(lifecycleRow!.text, /candidate -> active/);
  });
});

describe('loom-web — write endpoints', () => {
  const headers = { 'x-loom-token': 'test-token-123', 'Content-Type': 'application/json' };

  it('POST /api/epics/:id/approve flips a planned epic to approved + audits', async () => {
    const epics = new EpicStore(db);
    epics.create('epic-001', 'Add health endpoint');

    const res = await fetch(`${baseUrl}/api/epics/epic-001/approve`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; epic_id: string; dispatch_pid?: number };
    // mutations router returns 'dispatching' (first-registered-wins, ADR-003)
    assert.equal(body.status, 'dispatching');
    assert.equal(body.epic_id, 'epic-001');
    // Approve spawns the supervisor; tests use loomBin: ['true'],
    // so a dispatch_pid should be returned but the child does nothing.
    assert.equal(typeof body.dispatch_pid, 'number');

    assert.equal(epics.get('epic-001')!.status, 'approved');
    const rows = new AuditLog(db).getByCommand('epic-001', ['epic_approved']);
    assert.equal(rows.length, 1);
  });

  it('POST /api/epics/:id/approve returns 404 for unknown epic', async () => {
    const res = await fetch(`${baseUrl}/api/epics/nope/approve`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 404);
  });

  it('POST /api/epics/:id/approve returns 409 when the epic is not planned', async () => {
    const epics = new EpicStore(db);
    epics.create('epic-001', 'Already approved');
    epics.updateStatus('epic-001', 'approved');

    const res = await fetch(`${baseUrl}/api/epics/epic-001/approve`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 409);
  });

  it('POST /api/epics/:id/reject stores the reason in the audit log', async () => {
    const epics = new EpicStore(db);
    epics.create('epic-001', 'Scope too big');

    const res = await fetch(`${baseUrl}/api/epics/epic-001/reject`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'split into two epics first' }),
    });
    assert.equal(res.status, 200);
    assert.equal(epics.get('epic-001')!.status, 'rejected');
    const rows = new AuditLog(db).getByCommand('epic-001', ['epic_rejected']);
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail ?? '', /split into two epics/);
  });

  it('POST /api/agents/:id/kill returns 404 for unknown agent', async () => {
    const res = await fetch(`${baseUrl}/api/agents/nope/kill`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 404);
  });

  it('POST /api/agents/:id/kill returns 409 when worker_pid is null', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'Add health endpoint');
    const a = agents.create('epic-001', 'story-001-001', 'Add /health');

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/kill`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 409);
  });

  it('POST /api/stop sets the ControlStore state to stopping', async () => {
    const res = await fetch(`${baseUrl}/api/stop`, { method: 'POST', headers });
    assert.equal(res.status, 200);
    const state = new ControlStore(db).getState();
    assert.equal(state, 'stopping');
  });

  it('POST /api/stories/:id/retry returns 404 when no agent exists', async () => {
    const res = await fetch(`${baseUrl}/api/stories/story-001-001/retry`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 404);
  });

  it('POST /api/stories/:id/retry returns 409 for a still-running story', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'Add health endpoint');
    const a = agents.create('epic-001', 'story-001-001', 'Add /health');
    agents.updateStatus(a.id, 'running');

    const res = await fetch(`${baseUrl}/api/stories/story-001-001/retry`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 409);
  });

  it('POST /api/stories/:id/retry resume-retries a failed story + re-dispatches', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'Add health endpoint');
    epics.updateStatus('epic-001', 'in_progress');
    const a = agents.create('epic-001', 'story-001-001', 'Add /health');
    agents.updateStatus(a.id, 'failed');

    const res = await fetch(`${baseUrl}/api/stories/story-001-001/retry`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      will_resume: boolean;
      epic_id: string;
      dispatch_pid?: number;
    };
    assert.equal(body.status, 'dispatching');
    assert.equal(body.will_resume, true);
    assert.equal(body.epic_id, 'epic-001');
    // loomBin: ['true'] → a real pid is returned, the child is a no-op.
    assert.equal(typeof body.dispatch_pid, 'number');
    // The retry was audited.
    const rows = new AuditLog(db).getByCommand('story-001-001', ['story_retry_via_web']);
    assert.equal(rows.length, 1);
  });

  it('POST /api/stories/:id/retry returns 409 when a live run holds the epic lease', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'Add health endpoint');
    const a = agents.create('epic-001', 'story-001-001', 'Add /health');
    agents.updateStatus(a.id, 'failed');
    // Simulate a live supervisor holding the dispatch lease for this epic.
    const lease = new LeaseStore(db, { owner: 'live-run', pid: process.pid, isAlive: () => true });
    assert.ok(lease.acquire('epic-001'));

    const res = await fetch(`${baseUrl}/api/stories/story-001-001/retry`, {
      method: 'POST',
      headers,
    });
    assert.equal(res.status, 409);
  });
});

describe('loom-web — route mounting (story-004-001)', () => {
  const headers = { 'x-loom-token': 'test-token-123', 'Content-Type': 'application/json' };

  it('GET /api/inbox returns 200 — NOT 404 (regression guard: inbox router mounted in createApp)', async () => {
    const res = await fetch(`${baseUrl}/api/inbox`, { headers });
    assert.notEqual(res.status, 404, 'inbox router must be mounted in createApp');
    assert.equal(res.status, 200);
    // Empty inbox — no epics in the fresh DB.
    const body = (await res.json()) as unknown[];
    assert.ok(Array.isArray(body));
  });

  it('POST /api/epics/:id/approve returns {status:"dispatching"} — mutations router is authoritative (ADR-003)', async () => {
    new EpicStore(db).create('epic-mount-001', 'Router ordering check');
    const res = await fetch(`${baseUrl}/api/epics/epic-mount-001/approve`, {
      method: 'POST', headers,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'dispatching', 'mutations router (first-registered) wins over any inline duplicate');
  });

  it('POST /api/epics/:id/resume is served — NOT 404 (new route, previously unserved)', async () => {
    new EpicStore(db).create('epic-resume-001', 'Resume route check');
    const res = await fetch(`${baseUrl}/api/epics/epic-resume-001/resume`, {
      method: 'POST', headers,
    });
    // Epic is 'planned' and not paused → 409. The key assertion is NOT 404.
    assert.notEqual(res.status, 404, 'resume route is now mounted in createApp');
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not paused/);
  });

  it('POST /api/epics/:id/archive (inline handler retained) still archives an epic', async () => {
    new EpicStore(db).create('epic-arch-001', 'Archive me');
    const res = await fetch(`${baseUrl}/api/epics/epic-arch-001/archive`, {
      method: 'POST', headers,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; archived: boolean };
    assert.equal(body.status, 'archived');
    assert.equal(body.archived, true);
    assert.ok(new EpicStore(db).get('epic-arch-001')?.archived_at != null, 'epic.archived_at set');
  });

  it('POST /api/epics/:id/reject returns {status:"rejected"} — mutations router behavior', async () => {
    new EpicStore(db).create('epic-rej-001', 'Reject this');
    const res = await fetch(`${baseUrl}/api/epics/epic-rej-001/reject`, {
      method: 'POST', headers, body: JSON.stringify({ reason: 'too big' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'rejected');
  });

  it('POST /api/stop returns {status:"stopping"} — mutations router behavior', async () => {
    const res = await fetch(`${baseUrl}/api/stop`, { method: 'POST', headers });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'stopping');
  });

  it('POST /api/agents/:id/kill returns 409 for null worker_pid — mutations router behavior', async () => {
    new EpicStore(db).create('epic-kill-001', 'Kill test');
    const a = new AgentStore(db).create('epic-kill-001', 'story-001-001', 'story');
    const res = await fetch(`${baseUrl}/api/agents/${a.id}/kill`, { method: 'POST', headers });
    assert.equal(res.status, 409);
  });
});

/**
 * Reads SSE events from a Response body and resolves with the first event
 * matching the predicate. Parses the basic `event: <type>\ndata: <json>\n\n`
 * envelope; ignores comments and unknown shapes.
 */
async function readUntilEvent(
  body: ReadableStream<Uint8Array>,
  predicate: (event: string, data: unknown) => boolean,
  timeoutMs = 3000
): Promise<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() ?? '';
    for (const block of blocks) {
      let event = '';
      let dataStr = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataStr += line.slice(6);
      }
      if (!event) continue;
      let data: unknown;
      try { data = JSON.parse(dataStr); } catch { continue; }
      if (predicate(event, data)) {
        try { await reader.cancel(); } catch {}
        return { event, data };
      }
    }
  }
  try { await reader.cancel(); } catch {}
  throw new Error(`SSE event not seen within ${timeoutMs}ms`);
}

describe('loom-web — GET /api/events SSE', () => {
  it("requires the token (401 without it)", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    assert.equal(res.status, 401);
  });

  it('emits a `hello` event immediately on connect', async () => {
    const res = await fetch(`${baseUrl}/api/events?token=test-token-123`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const { data } = await readUntilEvent(res.body!, (ev) => ev === 'hello');
    assert.ok((data as { epoch: string }).epoch.length > 0);
  });

  it('emits an `epic` event when a new epic is created', async () => {
    const res = await fetch(`${baseUrl}/api/events?token=test-token-123`);
    // Plant an epic AFTER opening the stream so we observe the diff.
    setTimeout(() => {
      new EpicStore(db).beginPlanning('epic-001', 'Build /health endpoint');
    }, 30);
    const { data } = await readUntilEvent(
      res.body!,
      (ev, d) => ev === 'epic' && (d as { id: string }).id === 'epic-001'
    );
    assert.equal((data as { status: string }).status, 'planning');
    assert.equal((data as { planning_phase: string }).planning_phase, 'analyst');
  });

  it('emits an `output` event when an agent log_tail grows', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-001', 'Add /health');
    const a = agents.create('epic-001', 'story-001-001', 'Add /health');

    const res = await fetch(`${baseUrl}/api/events?token=test-token-123`);
    setTimeout(() => {
      agents.updateLogTail(a.id, 'thinking about it…\nwriting the code\n');
    }, 30);
    const { data } = await readUntilEvent(
      res.body!,
      (ev, d) => ev === 'output' && (d as { agent_id: string }).agent_id === a.id
    );
    assert.match((data as { chunk: string }).chunk, /thinking about it/);
  });
});
