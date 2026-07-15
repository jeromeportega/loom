import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, AuditLog } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';

const TOKEN = 'test-token-audit';

async function launch(): Promise<{
  db: Database.Database;
  auditLog: AuditLog;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const db = createDatabase(':memory:');
  const auditLog = new AuditLog(db);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-audit-route-test-'));
  fs.mkdirSync(path.join(projectRoot, '.loom', 'logs'), { recursive: true });
  const app = createApp({ db, token: TOKEN, loomBin: ['true'], projectRoot });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    db,
    auditLog,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          fs.rmSync(projectRoot, { recursive: true, force: true });
          err ? reject(err) : resolve();
        })
      ),
  };
}

let srv: Awaited<ReturnType<typeof launch>>;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-audit-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  srv = await launch();
});

afterEach(async () => {
  if (srv) await srv.close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

const authed = (opts: RequestInit = {}): RequestInit => ({
  ...opts,
  headers: { ...(opts.headers as Record<string, string> ?? {}), 'x-loom-token': TOKEN },
});

describe('GET /api/audit/verify — auth', () => {
  it('unauthenticated request returns non-200 (401)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/audit/verify`);
    assert.notEqual(res.status, 200);
    assert.equal(res.status, 401);
  });

  it('authenticated request returns 200', async () => {
    const res = await fetch(`${srv.baseUrl}/api/audit/verify`, authed());
    assert.equal(res.status, 200);
  });
});

describe('GET /api/audit/verify — response shape', () => {
  it('returns a JSON body whose shape matches VerifyChainResult — all required keys present', async () => {
    const res = await fetch(`${srv.baseUrl}/api/audit/verify`, authed());
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;

    assert.ok('ok' in body, 'missing ok');
    assert.ok('hashedRows' in body, 'missing hashedRows');
    assert.ok('legacyRows' in body, 'missing legacyRows');
    assert.ok('fromId' in body, 'missing fromId');
    assert.ok('toId' in body, 'missing toId');

    assert.equal(typeof body.ok, 'boolean');
    assert.equal(typeof body.hashedRows, 'number');
    assert.equal(typeof body.legacyRows, 'number');
  });

  it('on an intact chain, response body has ok: true', async () => {
    srv.auditLog.record({ action: 'test_action_1' });
    srv.auditLog.record({ action: 'test_action_2' });

    const res = await fetch(`${srv.baseUrl}/api/audit/verify`, authed());
    const body = await res.json() as { ok: boolean; hashedRows: number };
    assert.equal(body.ok, true);
    assert.equal(body.hashedRows, 2);
  });

  it('on a broken chain (tampered row), response body has ok: false and brokenAtId is set', async () => {
    srv.auditLog.record({ action: 'first_action' });
    srv.auditLog.record({ action: 'tamper_target' });
    // Corrupt only the second row so brokenAtId is predictable
    const target = srv.db
      .prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { id: number };
    srv.db
      .prepare("UPDATE audit_log SET entry_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id = ?")
      .run(target.id);

    const res = await fetch(`${srv.baseUrl}/api/audit/verify`, authed());
    const body = await res.json() as { ok: boolean; brokenAtId: number };
    assert.equal(body.ok, false);
    assert.equal(body.brokenAtId, target.id, 'brokenAtId should match the corrupted row id');
  });

  it('returns ok: true and hashedRows: 0 when the audit log is empty', async () => {
    const res = await fetch(`${srv.baseUrl}/api/audit/verify`, authed());
    const body = await res.json() as { ok: boolean; hashedRows: number; fromId: unknown; toId: unknown };
    assert.equal(body.ok, true);
    assert.equal(body.hashedRows, 0);
    assert.equal(body.fromId, null);
    assert.equal(body.toId, null);
  });
});

describe('GET /api/audit/verify — no new npm dependencies', () => {
  it('packages/loom-web/package.json has no new entries for this feature', () => {
    const pkgPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    // Snapshot of the full dependency key set established before this feature.
    // Any addition — intentional or accidental — must be reflected here.
    const EXPECTED_DEPS = new Set([
      '@atlaskit/pragmatic-drag-and-drop',
      '@loom-ai/core',
      'express',
      '@radix-ui/react-slot',
      '@radix-ui/react-tabs',
      '@tanstack/react-query',
      '@testing-library/react',
      '@types/express',
      '@types/node',
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'autoprefixer',
      'class-variance-authority',
      'clsx',
      'jsdom',
      'postcss',
      'react',
      'react-dom',
      'react-router-dom',
      'tailwind-merge',
      'tailwindcss',
      'typescript',
      'vite',
      'vitest',
    ]);
    for (const key of Object.keys(allDeps)) {
      assert.ok(EXPECTED_DEPS.has(key), `unexpected new dependency: ${key}`);
    }
    assert.equal(
      Object.keys(allDeps).length,
      EXPECTED_DEPS.size,
      'dependency count changed — update EXPECTED_DEPS if intentional'
    );
  });
});
