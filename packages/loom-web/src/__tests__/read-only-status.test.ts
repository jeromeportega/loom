/**
 * Integration tests for story-027-001:
 *   - GET /api/status surfaces `read_only: true` when launched with opts.readOnly=true
 *   - GET /api/status surfaces `read_only: false` when opts.readOnly=false or absent
 *   - accessGuard behavior is unchanged (GET passes, non-GET returns 403 without token)
 *
 * Does NOT modify auth.ts or access-guard.test.ts (NFR-1).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase } from '@loom-ai/core';
import { createApp } from '../server/index.js';

interface Srv {
  baseUrl: string;
  close: () => Promise<void>;
}

async function launch(readOnly?: boolean): Promise<Srv> {
  const db = createDatabase(':memory:');
  const app = createApp({ db, token: 'test-ro-token', ssePollMs: 50, loomBin: ['true'], readOnly });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}

// ─── FR-7 / AC7: read_only field on GET /api/status ─────────────────────────

describe('GET /api/status — read_only field (FR-7/AC7)', () => {
  let srvReadOnly: Srv;
  let srvDefault: Srv;
  let srvExplicitFalse: Srv;

  before(async () => {
    srvReadOnly      = await launch(true);
    srvDefault       = await launch();       // readOnly omitted → defaults to false
    srvExplicitFalse = await launch(false);
  });
  after(async () => {
    await srvReadOnly.close();
    await srvDefault.close();
    await srvExplicitFalse.close();
  });

  it('returns read_only: true when readOnly=true', async () => {
    const res = await fetch(`${srvReadOnly.baseUrl}/api/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { read_only?: boolean };
    assert.strictEqual(body.read_only, true, 'read_only must be true in read-only mode');
  });

  it('returns read_only: false when readOnly=false', async () => {
    const res = await fetch(`${srvExplicitFalse.baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'test-ro-token' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { read_only?: boolean };
    assert.strictEqual(body.read_only, false, 'read_only must be false when not in read-only mode');
  });

  it('returns read_only: false when readOnly is omitted from opts', async () => {
    const res = await fetch(`${srvDefault.baseUrl}/api/status`, {
      headers: { 'x-loom-token': 'test-ro-token' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { read_only?: boolean };
    // Either false or absent — client treats both as false
    assert.ok(
      body.read_only === false || body.read_only === undefined,
      `expected read_only to be false or absent, got ${body.read_only}`
    );
  });

  it('response always includes the epics array alongside read_only', async () => {
    const res = await fetch(`${srvReadOnly.baseUrl}/api/status`);
    const body = (await res.json()) as { epics?: unknown[]; read_only?: boolean };
    assert.ok(Array.isArray(body.epics), 'epics array must be present');
    assert.strictEqual(body.read_only, true);
  });
});

// ─── NFR-1: accessGuard behavior unchanged in read-only mode ─────────────────

describe('accessGuard regression — read-only mode (NFR-1)', () => {
  let srv: Srv;
  before(async () => { srv = await launch(true); });
  after(async () => { await srv.close(); });

  it('GET /api/status passes without a token in read-only mode (200)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/status`);
    assert.equal(res.status, 200, 'GET must pass tokenless in read-only mode');
  });

  it('POST mutation returns 403 without a token in read-only mode', async () => {
    const res = await fetch(`${srv.baseUrl}/api/stop`, { method: 'POST' });
    assert.equal(res.status, 403, 'non-GET without token must be 403 in read-only mode');
  });

  it('POST mutation with the write token is NOT blocked (returns something other than 403)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/stop`, {
      method: 'POST',
      headers: { 'x-loom-token': 'test-ro-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notEqual(res.status, 403, 'valid write token must not be blocked in read-only mode');
    assert.notEqual(res.status, 401, 'valid write token must not receive 401');
  });
});

// ─── NFR-2: frozen read endpoints untouched ───────────────────────────────────

describe('frozen read endpoints — read-only mode (NFR-2)', () => {
  let srv: Srv;
  before(async () => { srv = await launch(true); });
  after(async () => { await srv.close(); });

  it('GET /api/epics/:id/traces returns 404 (not found) without token — auth guard passed', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/no-such-epic/traces`);
    // 404 proves the guard didn't block it (would be 401/403 otherwise)
    assert.equal(res.status, 404, 'traces endpoint must be reachable without token in read-only mode');
  });

  it('GET /api/agents/:id/audit returns 404 (not found) without token — auth guard passed', async () => {
    const res = await fetch(`${srv.baseUrl}/api/agents/no-such-agent/audit`);
    assert.equal(res.status, 404, 'audit endpoint must be reachable without token in read-only mode');
  });

  it('GET /api/skills returns 200 without token in read-only mode', async () => {
    const res = await fetch(`${srv.baseUrl}/api/skills`);
    assert.equal(res.status, 200, 'skills endpoint must be reachable without token in read-only mode');
  });

  it('GET /api/skills/:name/history returns 200 without token in read-only mode', async () => {
    const res = await fetch(`${srv.baseUrl}/api/skills/no-such-skill/history`);
    assert.equal(res.status, 200, 'skill history endpoint must be reachable without token in read-only mode');
  });
});
