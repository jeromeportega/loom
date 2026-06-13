/**
 * Access-guard and enumerated-route tests for story-003-006.
 *
 * The heart of this suite is the enumerated-route test: it walks the actual
 * Express route table so every future route is covered by construction — no
 * hardcoded subset. This is the load-bearing check that prevents a
 * misclassified future route (wrong verb → wrong auth policy) from going
 * unnoticed.
 *
 * CLASSIFICATION INVARIANT NOTE: the test asserts that:
 *   - Every GET/HEAD route serves without a token in read-only mode.
 *   - Every mutation (non-GET/HEAD) route returns 403 without a token.
 * This invariant holds ONLY when mutations use non-GET verbs. If someone adds
 * a GET that mutates, the test will pass the tokenless assertion but the
 * mutation will be publicly accessible in read-only mode. Keep all mutations
 * on non-GET verbs — that classification is load-bearing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createDatabase } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

interface Launched {
  app: Express;
  db: Database.Database;
  baseUrl: string;
  close: () => Promise<void>;
}

async function launch(token = 'test-token-ro', readOnly = false): Promise<Launched> {
  const db = createDatabase(':memory:');
  const app = createApp({ db, token, ssePollMs: 50, loomBin: ['true'], readOnly });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    app,
    db,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

/**
 * Walks app._router.stack and returns every /api/* route as { method, path }.
 * This is the mechanism that makes the enumerated test cover all future routes
 * automatically.
 */
function extractApiRoutes(
  app: Express
): { method: string; path: string }[] {
  const routes: { method: string; path: string }[] = [];
  const stack: unknown[] = (app as unknown as { _router?: { stack: unknown[] } })._router?.stack ?? [];
  for (const layer of stack) {
    const l = layer as {
      route?: {
        path: string | RegExp;
        methods: Record<string, boolean>;
      };
    };
    if (!l.route) continue;
    const routePath = l.route.path;
    if (typeof routePath !== 'string') continue;
    if (!routePath.startsWith('/api/')) continue;
    const methods = Object.keys(l.route.methods).filter(
      (m) => l.route!.methods[m] && m !== '_all'
    );
    for (const m of methods) {
      routes.push({ method: m.toUpperCase(), path: routePath });
    }
  }
  return routes;
}

/**
 * Replaces Express path parameters (:id, :storyId, etc.) with a sentinel
 * value that is valid as a URL segment. Most lookups will return 404 (not
 * found), which still proves the auth guard did NOT block the request.
 */
function materializePath(routePath: string): string {
  return routePath.replace(/:[\w]+/g, 'test-id-000');
}

// ─── Default mode: byte-compatible with requireToken ────────────────────────

describe('accessGuard — default mode (readOnly=false)', () => {
  let srv: Launched;
  before(async () => { srv = await launch('tok-default', false); });
  after(async () => { await srv.close(); });

  it('returns 401 for GET /api/status without token', async () => {
    const res = await fetch(`${srv.baseUrl}/api/status`);
    assert.equal(res.status, 401);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, 'unauthorized');
  });

  it('returns 401 for POST /api/epics/x/approve without token', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/test-id/approve`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('returns 200 for GET /api/health without token (always unauthenticated)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(res.status, 200);
  });

  it('returns 200 for GET /api/status with valid token', async () => {
    const res = await fetch(`${srv.baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'tok-default' },
    });
    assert.equal(res.status, 200);
  });

  it('returns 401 for a wrong token (not 403 — default mode uses 401)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'wrong' },
    });
    assert.equal(res.status, 401);
  });
});

// ─── Enumerated-route test (the load-bearing proof) ─────────────────────────

describe('accessGuard — enumerated routes (readOnly=true)', () => {
  let srv: Launched;
  let apiRoutes: { method: string; path: string }[];

  before(async () => {
    srv = await launch('tok-ro', true);
    apiRoutes = extractApiRoutes(srv.app);
    // Sanity: we must find at least some routes. If 0 are found the test
    // framework has changed and the walk is broken.
    assert.ok(apiRoutes.length > 0, `extractApiRoutes found 0 /api/* routes — route walk is broken`);
  });
  after(async () => { await srv.close(); });

  it('every GET/HEAD route serves WITHOUT a token (auth guard did not block)', async () => {
    const getRoutes = apiRoutes.filter((r) => r.method === 'GET' || r.method === 'HEAD');
    assert.ok(getRoutes.length > 0, 'no GET routes found — route walk is broken');

    for (const route of getRoutes) {
      const url = `${srv.baseUrl}${materializePath(route.path)}`;
      let status: number;

      if (route.path === '/api/events') {
        // SSE: connection stays open. Verify headers arrive (status 200) then
        // abort. If the guard blocked it, status would be 403 before headers.
        const ac = new AbortController();
        try {
          const res = await fetch(url, { signal: ac.signal });
          status = res.status;
          // Drain the body partially to avoid Node.js resource leaks.
          res.body?.cancel().catch(() => {});
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            // Aborted before status arrived — can't assert, skip.
            continue;
          }
          throw err;
        } finally {
          ac.abort();
        }
      } else {
        const res = await fetch(url, { method: route.method });
        status = res.status;
        await res.body?.cancel().catch(() => {});
      }

      assert.notEqual(
        status,
        401,
        `GET ${route.path}: expected no auth challenge in read-only mode, got 401`
      );
      assert.notEqual(
        status,
        403,
        `GET ${route.path}: expected no auth block in read-only mode, got 403`
      );
    }
  });

  it('every non-GET/HEAD mutation route returns 403 WITHOUT the write token', async () => {
    const mutationRoutes = apiRoutes.filter(
      (r) => r.method !== 'GET' && r.method !== 'HEAD'
    );
    assert.ok(mutationRoutes.length > 0, 'no mutation routes found — route walk is broken');

    for (const route of mutationRoutes) {
      const url = `${srv.baseUrl}${materializePath(route.path)}`;
      const res = await fetch(url, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await res.body?.cancel().catch(() => {});
      assert.equal(
        res.status,
        403,
        `${route.method} ${route.path}: expected 403 without token in read-only mode, got ${res.status}`
      );
    }
  });

  it('enumerates at least one GET and one mutation route (confirms walk is not vacuous)', () => {
    const gets = apiRoutes.filter((r) => r.method === 'GET');
    const mutations = apiRoutes.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
    assert.ok(gets.length >= 1, `expected at least 1 GET route, found ${gets.length}`);
    assert.ok(mutations.length >= 1, `expected at least 1 mutation route, found ${mutations.length}`);
  });
});

// ─── SSE in read-only ────────────────────────────────────────────────────────

describe('accessGuard — SSE in read-only mode', () => {
  let srv: Launched;
  before(async () => { srv = await launch('tok-sse', true); });
  after(async () => { await srv.close(); });

  it('GET /api/events serves without a token (SSE stream opens)', async () => {
    const ac = new AbortController();
    let status: number | null = null;
    let contentType: string | null = null;

    try {
      const res = await fetch(`${srv.baseUrl}/api/events`, { signal: ac.signal });
      status = res.status;
      contentType = res.headers.get('content-type');
      res.body?.cancel().catch(() => {});
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
    } finally {
      ac.abort();
    }

    if (status !== null) {
      assert.equal(status, 200, `SSE without token expected 200, got ${status}`);
      assert.ok(
        contentType?.includes('text/event-stream'),
        `SSE content-type expected text/event-stream, got ${contentType}`
      );
    }
    // If status is null the request was aborted before headers — not a failure.
  });
});

// ─── Mutation with write token succeeds in read-only mode ────────────────────

describe('accessGuard — mutation with valid token in read-only mode', () => {
  let srv: Launched;
  before(async () => { srv = await launch('tok-write', true); });
  after(async () => { await srv.close(); });

  it('POST with valid write token is NOT blocked (returns something other than 403)', async () => {
    // POST /api/stop is the simplest mutation: no ID params, always valid.
    const res = await fetch(`${srv.baseUrl}/api/stop`, {
      method: 'POST',
      headers: { 'x-loom-token': 'tok-write', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(res.status, 403, 'mutation with valid token must not be blocked');
    assert.notEqual(res.status, 401, 'mutation with valid token must not get 401');
  });
});

// ─── Both enablement paths produce the same guard behavior ──────────────────

describe('accessGuard — both enablement paths (readOnly=true)', () => {
  // The two enablement paths are:
  //   1. createApp({ readOnly: true })          — from LOOM_WEB_READONLY=1 env var (web.ts reads it)
  //   2. createApp({ readOnly: true })          — from --read-only CLI flag (index.ts sets it)
  // Both converge to the same createApp option. This test exercises that option
  // directly, proving the guard behavior is identical regardless of how readOnly
  // was set. Integration of the env-var and CLI-flag paths is in web.ts / index.ts.

  it('readOnly=true (env-var path): GET passes, mutation returns 403', async () => {
    const srv = await launch('tok-env', true);
    try {
      const getRes = await fetch(`${srv.baseUrl}/api/status`);
      assert.equal(getRes.status, 200);
      const postRes = await fetch(`${srv.baseUrl}/api/stop`, { method: 'POST' });
      assert.equal(postRes.status, 403);
    } finally {
      await srv.close();
    }
  });

  it('readOnly=false (default path): GET without token returns 401, not 403', async () => {
    const srv = await launch('tok-default-2', false);
    try {
      const getRes = await fetch(`${srv.baseUrl}/api/status`);
      assert.equal(getRes.status, 401);
    } finally {
      await srv.close();
    }
  });
});

// ─── Single centralized guard (no per-handler copies) ───────────────────────

describe('accessGuard — single guard, no per-handler checks', () => {
  let srv: Launched;
  before(async () => { srv = await launch('tok-guard', true); });
  after(async () => { await srv.close(); });

  it('GET routes return resource responses (not 401/403) proving no handler re-checks auth', async () => {
    // In read-only mode without token: GET /api/epics/nonexistent → 404 (not
    // found), not 401/403. 404 proves the guard passed and the handler ran.
    const res = await fetch(`${srv.baseUrl}/api/epics/nonexistent-epic-id`);
    assert.equal(res.status, 404, `handler should run after guard passes; 401/403 would mean a second guard check`);
  });

  it('GET /api/status returns 200 without token (guard passed, handler ran)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/status`);
    assert.equal(res.status, 200);
  });
});

// ─── Timing-safe comparison ──────────────────────────────────────────────────

describe('accessGuard — crypto.timingSafeEqual safety', () => {
  let srvDefault: Launched;
  let srvReadOnly: Launched;
  before(async () => {
    srvDefault = await launch('tok-timing', false);
    srvReadOnly = await launch('tok-timing-ro', true);
  });
  after(async () => {
    await srvDefault.close();
    await srvReadOnly.close();
  });

  it('wrong-length token is rejected without throwing (default mode → 401)', async () => {
    const res = await fetch(`${srvDefault.baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'short' },
    });
    assert.equal(res.status, 401);
  });

  it('wrong-length token on mutation is rejected without throwing (read-only → 403)', async () => {
    const res = await fetch(`${srvReadOnly.baseUrl}/api/stop`, {
      method: 'POST',
      headers: { 'x-loom-token': 'x' },
    });
    assert.equal(res.status, 403);
  });

  it('empty token is rejected without throwing (default → 401)', async () => {
    const res = await fetch(`${srvDefault.baseUrl}/api/status`, {
      headers: { 'x-loom-token': '' },
    });
    assert.equal(res.status, 401);
  });

  it('correct token succeeds (default → 200)', async () => {
    const res = await fetch(`${srvDefault.baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'tok-timing' },
    });
    assert.equal(res.status, 200);
  });
});
