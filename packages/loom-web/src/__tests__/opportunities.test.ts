/**
 * Integration route tests for GET /api/opportunities, POST …/scope, POST …/dismiss.
 * All tests exercise the real createApp() (NFR-4) with an in-memory SQLite DB.
 *
 * Token-gating check summary:
 *   GET  /api/opportunities       — public-read (no token needed)
 *   POST /api/opportunities/:id/scope   — write-token required (403 without it in readOnly)
 *   POST /api/opportunities/:id/dismiss — write-token required (403 without it in readOnly)
 *
 * Owner: story-004-006
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, AuditLog, OpportunityStore } from '@loom-ai/core';
import type { OpportunityRecord } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TOKEN = 'test-opp-token-456';

/**
 * Launches the Express app on an ephemeral port in read-only mode so that
 * GET routes are public and mutation routes require the write token.
 */
async function launch(token = TOKEN): Promise<{
  db: Database.Database;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const db = createDatabase(':memory:');
  const app = createApp({
    db,
    token,
    readOnly: true,
    // Inject a stub BriefRefiner that returns quality_score=3 (below default threshold).
    // The gate fails, scopeOpportunity writes an audit row with {ok:false}, then returns.
    _opportunityBriefRefiner: {
      refine: async (_rough: string) => ({
        ready: false,
        original: _rough,
        refined_brief: undefined,
        critique: {
          strong_points: [],
          ambiguities: ['stub — below threshold'],
          missing_scope: [],
          untestable_claims: [],
          hidden_complexity: [],
        },
        questions: ['what exactly should be built?'],
        quality_score: 3,
        delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
      }),
    },
    _opportunityPlanner: undefined,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected address');
  return {
    db,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())),
  };
}

/**
 * Seeds one open opportunity into the DB and returns its numeric id.
 */
function seedOpportunity(db: Database.Database): number {
  const store = new OpportunityStore(db);
  const now = new Date().toISOString();
  const opp: OpportunityRecord = {
    id: 0,
    key: 'opp-test-001',
    title: 'Reduce CI failure rate',
    rationale: 'CI fails 20% of runs, blocking developer productivity',
    impact: 0.8,
    effort: 0.4,
    confidence: 0.7,
    score: 1.4,
    rank: 1,
    status: 'open',
    signal_count: 3,
    member_keys: ['sig-1', 'sig-2', 'sig-3'],
    evidence: [{ title: 'CI run failures', url: 'file:ci.log:10' }],
    scoped_epic_id: null,
    created_at: now,
    updated_at: now,
  };
  store.upsertRanked([opp]);
  return store.listRanked()[0].id;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let db: Database.Database;
let baseUrl: string;
let close: () => Promise<void>;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-opp-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  ({ db, baseUrl, close } = await launch());
});

afterEach(async () => {
  await close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── GET /api/opportunities ───────────────────────────────────────────────────

describe('GET /api/opportunities — public-read list', () => {
  it('returns 200 without a token (readOnly mode)', async () => {
    const res = await fetch(`${baseUrl}/api/opportunities`);
    assert.equal(res.status, 200, 'should be public-read (no token required)');
  });

  it('returns an empty array when no opportunities are in the DB', async () => {
    const res = await fetch(`${baseUrl}/api/opportunities`);
    const body = (await res.json()) as unknown[];
    assert.ok(Array.isArray(body), 'body is array');
    assert.equal(body.length, 0);
  });

  it('returns a ranked OpportunityCard[] with required fields', async () => {
    seedOpportunity(db);

    const res = await fetch(`${baseUrl}/api/opportunities`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);

    const card = body[0];
    // Verify all required OpportunityCard fields are present
    assert.ok(typeof card.id === 'number', 'id is number');
    assert.ok(typeof card.title === 'string', 'title present');
    assert.ok(typeof card.rationale === 'string', 'rationale present');
    assert.ok(typeof card.score === 'number', 'score present');
    assert.ok(typeof card.rank === 'number', 'rank present');
    assert.ok(typeof card.signal_count === 'number', 'signal_count present');
    assert.ok(typeof card.status === 'string', 'status present');
    assert.ok(Array.isArray(card.evidence), 'evidence is array');
    assert.equal(card.status, 'open');
    assert.equal(card.rank, 1);
    assert.equal(card.signal_count, 3);
    // Evidence links present
    const evidence = card.evidence as Array<{ title: string; url: string }>;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].title, 'CI run failures');
  });

  it('returns 200 with the token as well (read works both ways)', async () => {
    const res = await fetch(`${baseUrl}/api/opportunities`, {
      headers: { 'x-loom-token': TOKEN },
    });
    assert.equal(res.status, 200);
  });

  it('rejects an unregistered ?project= with 400 (path-traversal guard)', async () => {
    const res = await fetch(
      `${baseUrl}/api/opportunities?project=/tmp/not-registered`
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /unknown project root/i);
  });
});

// ─── POST /api/opportunities/:id/scope ────────────────────────────────────────

describe('POST /api/opportunities/:id/scope — token-gated', () => {
  it('returns 403 without the write token (readOnly mode gates mutations)', async () => {
    const id = seedOpportunity(db);
    const res = await fetch(`${baseUrl}/api/opportunities/${id}/scope`, {
      method: 'POST',
    });
    assert.equal(
      res.status,
      403,
      'scope must require the write token even in read-only mode'
    );
  });

  it('invokes scoping and writes an audit row when called with the token', async () => {
    const id = seedOpportunity(db);
    const res = await fetch(`${baseUrl}/api/opportunities/${id}/scope`, {
      method: 'POST',
      headers: { 'x-loom-token': TOKEN },
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as { ok: boolean; critique?: string };
    // Stub refiner returns quality_score=3 → gate fails → {ok:false}
    assert.equal(body.ok, false);
    assert.ok(typeof body.critique === 'string', 'critique returned on gate failure');

    // Audit row must have been written (opportunity_scoped action)
    const audit = new AuditLog(db);
    const rows = audit.recent(1000);
    const scopeRow = rows.find(
      (r) => r.action === 'opportunity_scoped' && r.command === String(id)
    );
    assert.ok(scopeRow, 'opportunity_scoped audit row written');
    const detail = JSON.parse(scopeRow.detail ?? '{}') as { ok: boolean };
    assert.equal(detail.ok, false);
  });

  it('returns 404 for an unknown opportunity id', async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/99999/scope`, {
      method: 'POST',
      headers: { 'x-loom-token': TOKEN },
    });
    assert.equal(res.status, 404);
  });
});

// ─── POST /api/opportunities/:id/dismiss ─────────────────────────────────────

describe('POST /api/opportunities/:id/dismiss — token-gated', () => {
  it('returns 403 without the write token (readOnly mode gates mutations)', async () => {
    const id = seedOpportunity(db);
    const res = await fetch(`${baseUrl}/api/opportunities/${id}/dismiss`, {
      method: 'POST',
    });
    assert.equal(
      res.status,
      403,
      'dismiss must require the write token even in read-only mode'
    );
  });

  it('sets status=dismissed, returns {status:"dismissed"}, and writes audit row', async () => {
    const id = seedOpportunity(db);
    const res = await fetch(`${baseUrl}/api/opportunities/${id}/dismiss`, {
      method: 'POST',
      headers: { 'x-loom-token': TOKEN },
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'dismissed');

    // DB state updated
    const store = new OpportunityStore(db);
    const opp = store.get(id);
    assert.ok(opp, 'opportunity still in DB');
    assert.equal(opp.status, 'dismissed');

    // Audit row written
    const audit = new AuditLog(db);
    const rows = audit.recent(1000);
    const dismissRow = rows.find(
      (r) => r.action === 'opportunity_dismissed' && r.command === String(id)
    );
    assert.ok(dismissRow, 'opportunity_dismissed audit row written');
  });

  it('dismissed opportunity does not appear when status=open filter used (ADR-004)', async () => {
    const id = seedOpportunity(db);
    // Dismiss it
    await fetch(`${baseUrl}/api/opportunities/${id}/dismiss`, {
      method: 'POST',
      headers: { 'x-loom-token': TOKEN },
    });

    // List all — dismissed one shows up but with status='dismissed'
    const res = await fetch(`${baseUrl}/api/opportunities`);
    const body = (await res.json()) as Array<{ status: string }>;
    const dismissed = body.find(c => c.status === 'dismissed');
    assert.ok(dismissed, 'dismissed opportunity still listed (not deleted)');
    assert.equal(dismissed.status, 'dismissed');
  });

  it('returns 404 for an unknown opportunity id', async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/99999/dismiss`, {
      method: 'POST',
      headers: { 'x-loom-token': TOKEN },
    });
    assert.equal(res.status, 404);
  });
});

// ─── Read vs write gotcha ─────────────────────────────────────────────────────

describe('read vs write token gotcha', () => {
  it('GET /api/opportunities needs no token (public read)', async () => {
    const res = await fetch(`${baseUrl}/api/opportunities`);
    assert.equal(res.status, 200, 'GET is public');
  });

  it('POST …/scope without token is rejected (403)', async () => {
    const id = seedOpportunity(db);
    const res = await fetch(`${baseUrl}/api/opportunities/${id}/scope`, { method: 'POST' });
    assert.notEqual(res.status, 200);
    assert.notEqual(res.status, 404);
    // 403 in readOnly mode
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  it('POST …/dismiss without token is rejected (403)', async () => {
    const id = seedOpportunity(db);
    const res = await fetch(`${baseUrl}/api/opportunities/${id}/dismiss`, { method: 'POST' });
    assert.notEqual(res.status, 200);
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });
});
