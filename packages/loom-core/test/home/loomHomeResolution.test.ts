/**
 * story-053 — Functional tests: every command routes DB access through
 * prepareRepoState, ensuring all commands see migrated state and no stray
 * empty DB is created at the legacy path.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, openDatabase, resetDatabaseForTest } from '../../src/state/Database.js';
import { prepareRepoState } from '../../src/home/prepareRepoState.js';

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── AC: read-only command sees migrated state; no stray DB at legacy path ────

describe('loomHomeResolution — prepareRepoState migrates DB and exposes it to callers', () => {
  let projectRoot: string;
  let loomHome: string;
  let loomDir: string;

  before(() => {
    // Isolated temp dirs: project root + sibling loom-home
    const base = makeTmp('loom-resolve-');
    projectRoot = path.join(base, 'my-project');
    loomHome = path.join(base, 'loom-home');
    loomDir = path.join(projectRoot, '.loom');

    fs.mkdirSync(loomDir, { recursive: true });

    // Seed a legacy DB at .loom/loom.db (pre-migration state)
    const legacyDbPath = path.join(loomDir, 'loom.db');
    const db = createDatabase(legacyDbPath);
    db.prepare(`INSERT INTO epics (id, title, status) VALUES (?, ?, ?)`)
      .run('epic-resolve-001', 'Resolution Test Epic', 'planned');
    db.close();

    // Reset the singleton so openDatabase() below re-opens at the migrated path
    resetDatabaseForTest();
  });

  after((ctx) => {
    // Clean up base temp dir (parent of projectRoot)
    const base = path.dirname(projectRoot);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
    // Reset singleton to avoid bleed into other tests
    resetDatabaseForTest();
  });

  it('prepareRepoState succeeds and returns a dbPath under loom-home', () => {
    const policy = { loom_home: loomHome };
    const { dbPath } = prepareRepoState(projectRoot, policy);
    assert.ok(
      dbPath.startsWith(loomHome),
      `dbPath must be under loom-home: ${dbPath}`,
    );
  });

  it('the migrated DB exists at the returned dbPath', () => {
    const policy = { loom_home: loomHome };
    const { dbPath } = prepareRepoState(projectRoot, policy);
    assert.ok(fs.existsSync(dbPath), `DB must exist at migrated path: ${dbPath}`);
  });

  it('the migrated DB contains the seeded epic', () => {
    const policy = { loom_home: loomHome };
    const { dbPath } = prepareRepoState(projectRoot, policy);
    const db = createDatabase(dbPath);
    try {
      const row = db.prepare(`SELECT id, title FROM epics WHERE id = ?`).get('epic-resolve-001') as
        | { id: string; title: string }
        | undefined;
      assert.ok(row, 'seeded epic must be present in migrated DB');
      assert.equal(row.title, 'Resolution Test Epic');
    } finally {
      db.close();
    }
  });

  it('legacy .loom/loom.db no longer exists after migration (moved, not copied)', () => {
    const legacyDbPath = path.join(loomDir, 'loom.db');
    assert.ok(
      !fs.existsSync(legacyDbPath),
      'legacy .loom/loom.db must not exist after migration (it should have been moved)',
    );
  });

  it('no stray empty DB was created at the legacy path', () => {
    // Even after a second call to prepareRepoState (idempotent), legacy path stays absent
    const policy = { loom_home: loomHome };
    prepareRepoState(projectRoot, policy);
    const legacyDbPath = path.join(loomDir, 'loom.db');
    assert.ok(
      !fs.existsSync(legacyDbPath),
      'no stray empty DB must appear at .loom/loom.db after idempotent re-call',
    );
  });

  it('openDatabase with namespaceDir from prepareRepoState returns a live DB handle', () => {
    const policy = { loom_home: loomHome };
    const { namespaceDir } = prepareRepoState(projectRoot, policy);
    resetDatabaseForTest(); // ensure singleton is re-opened at the right path
    const db = openDatabase(namespaceDir);
    const row = db.prepare(`SELECT COUNT(*) AS n FROM epics`).get() as { n: number };
    assert.ok(row.n >= 1, 'openDatabase via namespaceDir must see migrated epics');
    resetDatabaseForTest();
  });
});

// ── AC: fresh-install path — no legacy DB, prepareRepoState creates it cleanly ─

describe('loomHomeResolution — fresh install: prepareRepoState creates DB only at loom-home', () => {
  let projectRoot: string;
  let loomHome: string;
  let loomDir: string;

  before(() => {
    const base = makeTmp('loom-fresh-');
    projectRoot = path.join(base, 'fresh-project');
    loomHome = path.join(base, 'loom-home');
    loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    resetDatabaseForTest();
  });

  after(() => {
    const base = path.dirname(projectRoot);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
    resetDatabaseForTest();
  });

  it('prepareRepoState succeeds with no legacy DB', () => {
    const policy = { loom_home: loomHome };
    const { dbPath } = prepareRepoState(projectRoot, policy);
    assert.ok(dbPath.startsWith(loomHome), `dbPath must be under loom-home: ${dbPath}`);
  });

  it('no legacy DB is created at .loom/loom.db during fresh init', () => {
    const legacyDbPath = path.join(loomDir, 'loom.db');
    assert.ok(
      !fs.existsSync(legacyDbPath),
      'fresh init must not create a DB at the legacy .loom/loom.db path',
    );
  });

  it('openDatabase with returned namespaceDir creates a working DB at loom-home', () => {
    const policy = { loom_home: loomHome };
    const { namespaceDir } = prepareRepoState(projectRoot, policy);
    resetDatabaseForTest();
    const db = openDatabase(namespaceDir);
    // DB should be usable (schema applied)
    const row = db.prepare(`SELECT COUNT(*) AS n FROM epics`).get() as { n: number };
    assert.equal(row.n, 0, 'fresh DB must start with 0 epics');
    resetDatabaseForTest();
  });
});
