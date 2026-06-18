/**
 * Integration tests for the blocked/blocked_reason contract on the web API surfaces.
 *
 * Drives ONE gate-blocked epic (status='in_progress', finalize_phase='gate')
 * through the REAL createApp web server, asserting that both surfaces report
 * blocked/blocked_reason correctly.
 *
 * Covers:
 *   - API fleet route (GET /api/fleet via buildProjectCards)
 *   - API status rollup (GET /api/status via rollupEpics)
 *   - No-leak: a normal in_progress epic never exposes blocked or finalize_phase
 *   - Status contract: status remains 'in_progress' on all surfaces
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  resetDatabaseForTest,
  EpicStore,
} from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';
import type { FleetCard } from '../shared/fleet.js';

const TOKEN = 'blocked-surfaces-test-token';
const HEADERS = { 'x-loom-token': TOKEN };

// ─── Test state ──────────────────────────────────────────────────────────────

let repo: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;
let db: Database.Database;
let epicStore: EpicStore;
let baseUrl: string;
let closeServer: () => Promise<void>;

function gitc(args: string[]): void {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(async () => {
  // Isolate machine-level LOOM_HOME so federation doesn't pick up real projects.
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-blocked-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  // Create a real git repo.
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-blocked-repo-'));
  gitc(['init', '-q', '-b', 'main']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });

  // Initialise the DB singleton.
  resetDatabaseForTest();
  db = openDatabase(path.join(repo, '.loom'));
  epicStore = new EpicStore(db);

  // Seed: gate-blocked epic (in_progress + finalize_phase='gate').
  epicStore.create('epic-gate', 'Gate blocked epic');
  epicStore.updateStatus('epic-gate', 'in_progress');
  epicStore.updateFinalizePhase('epic-gate', 'gate');

  // Also seed a normal in_progress epic (no finalize_phase).
  epicStore.create('epic-normal', 'Normal in_progress epic');
  epicStore.updateStatus('epic-normal', 'in_progress');

  // Spin up the REAL createApp web server.
  const app = createApp({ db, token: TOKEN, ssePollMs: 50, loomBin: ['true'] });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
});

afterEach(async () => {
  await closeServer();
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── API fleet route (GET /api/fleet) ────────────────────────────────────────

describe('GET /api/fleet — gate-blocked epic (anti-stub)', () => {
  it('reports blocked/blocked_reason for in_progress + gate epic', async () => {
    const res = await fetch(`${baseUrl}/api/fleet`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const cards = (await res.json()) as FleetCard[];
    const card = cards.find((c) => c.epic_id === 'epic-gate');
    assert.ok(card, 'epic-gate must appear in fleet (AC4)');
    assert.equal(card.status, 'in_progress', 'status must remain in_progress (AC6)');
    assert.equal(card.blocked, true, 'fleet must report blocked:true (AC4)');
    assert.equal(card.blocked_reason, 'integration_gate', 'fleet must report blocked_reason (AC4)');
  });

  it('does NOT report blocked for a normal in_progress epic', async () => {
    const res = await fetch(`${baseUrl}/api/fleet`, { headers: HEADERS });
    const cards = (await res.json()) as FleetCard[];
    const card = cards.find((c) => c.epic_id === 'epic-normal');
    assert.ok(card, 'epic-normal must appear in fleet');
    assert.equal(card.status, 'in_progress');
    assert.ok(!('blocked' in card), 'no blocked field for normal in_progress (AC5)');
    assert.ok(!('blocked_reason' in card), 'no blocked_reason for normal in_progress (AC5)');
  });
});

// ─── API status rollup (GET /api/status) ─────────────────────────────────────

describe('GET /api/status — gate-blocked epic', () => {
  it('reports blocked/blocked_reason for in_progress + gate epic', async () => {
    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { epics: Array<{ id: string; status: string; blocked?: boolean; blocked_reason?: string }> };
    const epic = body.epics.find((e) => e.id === 'epic-gate');
    assert.ok(epic, 'epic-gate must appear in status rollup (AC3)');
    assert.equal(epic.status, 'in_progress', 'status must remain in_progress (AC6)');
    assert.equal(epic.blocked, true, 'status rollup must report blocked:true (AC3)');
    assert.equal(epic.blocked_reason, 'integration_gate', 'status rollup must report blocked_reason (AC3)');
  });

  it('does NOT report blocked for a normal in_progress epic', async () => {
    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    const body = (await res.json()) as { epics: Array<{ id: string; blocked?: boolean; blocked_reason?: string }> };
    const epic = body.epics.find((e) => e.id === 'epic-normal');
    assert.ok(epic, 'epic-normal must appear in status rollup');
    assert.ok(!('blocked' in epic), 'no blocked field for normal in_progress (AC5)');
    assert.ok(!('blocked_reason' in epic), 'no blocked_reason for normal in_progress (AC5)');
  });
});
