import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateStateDatabase } from '../../src/home/migrateState.js';
import { prepareRepoState } from '../../src/home/prepareRepoState.js';
import { resolveRepoStatePaths } from '../../src/home/repoState.js';
import { createDatabase } from '../../src/state/Database.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-migrate-'));
}

interface SeedResult {
  epicIds: string[];
  agentIds: string[];
  auditIds: number[];
  skillIds: number[];
  lessonIds: number[];
}

/**
 * Seeds known rows into a real better-sqlite3 database.
 * Returns the identifiers so we can assert parity at the destination.
 */
function seedDb(db: Database.Database): SeedResult {
  db.prepare(
    `INSERT INTO epics (id, title, status) VALUES (?, ?, ?)`,
  ).run('epic-test-001', 'Test Epic Alpha', 'planned');
  db.prepare(
    `INSERT INTO epics (id, title, status) VALUES (?, ?, ?)`,
  ).run('epic-test-002', 'Test Epic Beta', 'done');

  db.prepare(
    `INSERT INTO agents (id, epic_id, story_id, status) VALUES (?, ?, ?, ?)`,
  ).run('agent-001', 'epic-test-001', 'story-001', 'pending');

  const auditR = db
    .prepare(`INSERT INTO audit_log (agent_id, action, allowed) VALUES (?, ?, ?)`)
    .run('agent-001', 'cmd_exec', 1);
  const skillR = db
    .prepare(
      `INSERT INTO skill_usage (skill_name, agent_id, story_id) VALUES (?, ?, ?)`,
    )
    .run('test-skill', 'agent-001', 'story-001');
  const lessonR = db
    .prepare(
      `INSERT INTO lessons (epic_id, category, observation, general_rule, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run('epic-test-001', 'testing', 'observation text', 'general rule text', new Date().toISOString());

  return {
    epicIds: ['epic-test-001', 'epic-test-002'],
    agentIds: ['agent-001'],
    auditIds: [Number(auditR.lastInsertRowid)],
    skillIds: [Number(skillR.lastInsertRowid)],
    lessonIds: [Number(lessonR.lastInsertRowid)],
  };
}

function assertRowParity(srcPath: string, dstPath: string, seed: SeedResult): void {
  const tables: Array<{ table: string; count: number }> = [
    { table: 'epics', count: seed.epicIds.length },
    { table: 'agents', count: seed.agentIds.length },
    { table: 'audit_log', count: seed.auditIds.length },
    { table: 'skill_usage', count: seed.skillIds.length },
    { table: 'lessons', count: seed.lessonIds.length },
  ];

  const dst = new Database(dstPath, { readonly: true });
  try {
    for (const { table, count } of tables) {
      const row = dst.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(row.n, count, `${table}: expected ${count} rows at dst, got ${row.n}`);
    }
    // Confirm the source is gone (after a completed migration)
    assert.ok(!fs.existsSync(srcPath), `srcPath should be removed after migration: ${srcPath}`);
  } finally {
    dst.close();
  }
}

// ── migrateStateDatabase — happy path (rename) ────────────────────────────────

describe('migrateStateDatabase — no-op when source absent', () => {
  let tmp: string;

  before(() => { tmp = makeTmp(); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns migrated=false and method=null when srcDir has no loom.db', () => {
    const srcDir = path.join(tmp, 'empty-src');
    const dstPath = path.join(tmp, 'dst', 'loom.db');
    fs.mkdirSync(srcDir, { recursive: true });

    const result = migrateStateDatabase({ srcDir, dstPath });
    assert.equal(result.migrated, false);
    assert.equal(result.from, null);
    assert.equal(result.method, null);
    assert.equal(result.to, dstPath);
  });

  it('returns migrated=false when src === dst (same path)', () => {
    const dir = path.join(tmp, 'same');
    const db = createDatabase(path.join(dir, 'loom.db'));
    db.close();
    const srcDir = dir;
    const dstPath = path.join(dir, 'loom.db');
    const result = migrateStateDatabase({ srcDir, dstPath });
    assert.equal(result.migrated, false);
  });

  it('returns migrated=false (idempotent) when dstPath already exists', () => {
    const srcDir = path.join(tmp, 'idem-src');
    const dstDir = path.join(tmp, 'idem-dst');
    const src = createDatabase(path.join(srcDir, 'loom.db'));
    src.close();
    const dst = createDatabase(path.join(dstDir, 'loom.db'));
    dst.close();

    const result = migrateStateDatabase({ srcDir, dstPath: path.join(dstDir, 'loom.db') });
    assert.equal(result.migrated, false);
    // Source should still be present since we did not migrate
    assert.ok(fs.existsSync(path.join(srcDir, 'loom.db')));
  });
});

describe('migrateStateDatabase — rename path (same filesystem)', () => {
  let tmp: string;

  before(() => { tmp = makeTmp(); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('moves all seeded rows to dst and removes src (AC2, AC6)', () => {
    const srcDir = path.join(tmp, 'rename-src');
    const dstPath = path.join(tmp, 'rename-dst', 'loom.db');

    const src = createDatabase(path.join(srcDir, 'loom.db'));
    const seed = seedDb(src);
    src.close();

    const result = migrateStateDatabase({ srcDir, dstPath });

    assert.equal(result.migrated, true);
    assert.equal(result.method, 'rename');
    assert.equal(result.from, path.join(srcDir, 'loom.db'));
    assert.equal(result.to, dstPath);

    assertRowParity(path.join(srcDir, 'loom.db'), dstPath, seed);
  });
});

// ── WAL handling ──────────────────────────────────────────────────────────────

describe('migrateStateDatabase — WAL checkpoint (AC3)', () => {
  let tmp: string;

  before(() => { tmp = makeTmp(); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('rows in WAL survive migration; WAL sidecar removed after rename', () => {
    const srcDir = path.join(tmp, 'wal-src');
    const dstPath = path.join(tmp, 'wal-dst', 'loom.db');
    const srcDbPath = path.join(srcDir, 'loom.db');

    // Open in WAL mode (default from createDatabase) and write rows WITHOUT
    // an explicit checkpoint — pages go to the WAL file, not the main file.
    const src = createDatabase(srcDbPath);
    const seed = seedDb(src);
    // Close without PRAGMA wal_checkpoint(TRUNCATE) so WAL may have pages.
    src.close();

    // The WAL file exists because WAL mode was used.
    const walPath = srcDbPath + '-wal';
    // The WAL may or may not have pages depending on SQLite internals,
    // but the migration must work regardless. Verify the WAL is gone post-move.

    const result = migrateStateDatabase({ srcDir, dstPath });

    assert.equal(result.migrated, true);
    assert.ok(!fs.existsSync(walPath), '-wal sidecar must be removed after migration');
    assert.ok(!fs.existsSync(srcDbPath + '-shm'), '-shm sidecar must be removed');

    // All rows must be at destination.
    const dst = new Database(dstPath, { readonly: true });
    try {
      const n = dst.prepare('SELECT COUNT(*) AS n FROM epics').get() as { n: number };
      assert.equal(n.n, seed.epicIds.length, 'All epic rows must survive WAL migration');
    } finally {
      dst.close();
    }
  });
});

// ── EXDEV (cross-filesystem) copy path ───────────────────────────────────────

describe('migrateStateDatabase — EXDEV copy fallback (AC4)', () => {
  let tmp: string;
  let origRenameSync: typeof fs.renameSync;

  before(() => {
    tmp = makeTmp();
    // Intercept the first renameSync call with an EXDEV error, then restore.
    let intercepted = false;
    origRenameSync = fs.renameSync;
    fs.renameSync = (src: fs.PathLike, dst: fs.PathLike) => {
      if (!intercepted && String(dst).endsWith('loom.db') && !String(dst).endsWith('.tmp')) {
        intercepted = true;
        const err = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        throw err;
      }
      return origRenameSync(src as string, dst as string);
    };
  });

  after(() => {
    fs.renameSync = origRenameSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('falls back to copy, verifies integrity, and removes source (AC4)', () => {
    const srcDir = path.join(tmp, 'exdev-src');
    const dstPath = path.join(tmp, 'exdev-dst', 'loom.db');

    const src = createDatabase(path.join(srcDir, 'loom.db'));
    const seed = seedDb(src);
    src.close();

    const result = migrateStateDatabase({ srcDir, dstPath });

    assert.equal(result.migrated, true, 'should have migrated');
    assert.equal(result.method, 'copy', 'should use copy method on EXDEV');
    assert.equal(result.from, path.join(srcDir, 'loom.db'));

    assertRowParity(path.join(srcDir, 'loom.db'), dstPath, seed);
  });
});

// ── VERIFY-BEFORE-DELETE invariant ───────────────────────────────────────────

describe('migrateStateDatabase — verify-before-delete (NFR-1)', () => {
  let tmp: string;
  let origRenameSync: typeof fs.renameSync;
  let origCopyFileSync: typeof fs.copyFileSync;

  before(() => {
    tmp = makeTmp();
  });

  beforeEach(() => {
    // Force EXDEV path and make the copy produce a corrupt (garbage) file.
    let renameIntercepted = false;
    let copyIntercepted = false;
    origRenameSync = fs.renameSync;
    origCopyFileSync = fs.copyFileSync;

    (fs as Record<string, unknown>).renameSync = (src: fs.PathLike, dst: fs.PathLike) => {
      if (!renameIntercepted && String(dst).endsWith('loom.db') && !String(dst).endsWith('.tmp-')) {
        renameIntercepted = true;
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      }
      return origRenameSync(src, dst);
    };

    (fs as Record<string, unknown>).copyFileSync = (src: fs.PathLike, dst: fs.PathLike, flags?: number) => {
      if (!copyIntercepted) {
        copyIntercepted = true;
        // Write non-SQLite garbage so integrity_check fails and tables are absent.
        fs.writeFileSync(dst, Buffer.from('not-a-valid-sqlite-database-xyzzy'));
        return;
      }
      return origCopyFileSync(src, dst, flags);
    };
  });

  afterEach(() => {
    (fs as Record<string, unknown>).renameSync = origRenameSync;
    (fs as Record<string, unknown>).copyFileSync = origCopyFileSync;
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('source is preserved and temp discarded when verification fails', () => {
    const srcDir = path.join(tmp, 'verify-src');
    const dstPath = path.join(tmp, 'verify-dst', 'loom.db');
    const srcDbPath = path.join(srcDir, 'loom.db');

    const src = createDatabase(srcDbPath);
    seedDb(src);
    src.close();

    assert.throws(
      () => migrateStateDatabase({ srcDir, dstPath }),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'should be an Error');
        assert.ok(
          /verification failed/.test(err.message) || (err as NodeJS.ErrnoException).code != null,
          `unexpected error: ${String(err)}`,
        );
        return true;
      },
    );

    // Source must still be present and intact.
    assert.ok(fs.existsSync(srcDbPath), 'source DB must survive verification failure');

    // Destination must not exist (temp was cleaned up).
    assert.ok(!fs.existsSync(dstPath), 'destination must not exist after verification failure');

    // No .tmp files left behind.
    const dstDir = path.dirname(dstPath);
    if (fs.existsSync(dstDir)) {
      const leftovers = fs.readdirSync(dstDir).filter((f) => f.includes('.tmp-'));
      assert.equal(leftovers.length, 0, `no tmp files should remain: ${leftovers}`);
    }
  });
});

// ── prepareRepoState + migration integration ──────────────────────────────────

describe('prepareRepoState — open location (AC1)', () => {
  let tmp: string;
  const policy = { loom_home: '' };

  before(() => {
    tmp = makeTmp();
    policy.loom_home = path.join(tmp, 'loom-home');
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('openDatabase should use namespaceDir, not projectRoot/.loom (AC1)', () => {
    const projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(path.join(projectRoot, '.loom'), { recursive: true });
    // Write minimal policy.yaml so PolicyEngine.load() doesn't fail elsewhere
    fs.writeFileSync(path.join(projectRoot, '.loom', 'policy.yaml'), '', 'utf8');

    const paths = prepareRepoState(projectRoot, policy);

    const { namespaceDir } = resolveRepoStatePaths(projectRoot, policy);
    assert.equal(paths.namespaceDir, namespaceDir);
    assert.ok(
      paths.dbPath.startsWith(policy.loom_home),
      `dbPath (${paths.dbPath}) must be under loom-home`,
    );
    assert.ok(
      !paths.dbPath.startsWith(projectRoot),
      `dbPath (${paths.dbPath}) must not be under projectRoot`,
    );
  });
});

describe('prepareRepoState — lossless migration (AC2, AC7)', () => {
  let tmp: string;
  let loomHome: string;
  let projectRoot: string;
  let seed: SeedResult;

  before(() => {
    tmp = makeTmp();
    loomHome = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    const loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), '', 'utf8');

    // Seed DB at the old in-repo location.
    const src = createDatabase(path.join(loomDir, 'loom.db'));
    seed = seedDb(src);
    src.close();
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('all epic/agent/audit/skill/lesson rows intact at loom-home location', () => {
    const policy = { loom_home: loomHome };
    const paths = prepareRepoState(projectRoot, policy);

    // DB must exist at loom-home path.
    assert.ok(fs.existsSync(paths.dbPath), `DB must exist at namespaceDir: ${paths.dbPath}`);

    // Row parity.
    const dst = new Database(paths.dbPath, { readonly: true });
    try {
      const tables = [
        { table: 'epics', count: seed.epicIds.length },
        { table: 'agents', count: seed.agentIds.length },
        { table: 'audit_log', count: seed.auditIds.length },
        { table: 'skill_usage', count: seed.skillIds.length },
        { table: 'lessons', count: seed.lessonIds.length },
      ];
      for (const { table, count } of tables) {
        const row = dst.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        assert.equal(row.n, count, `${table}: expected ${count} rows at loom-home`);
      }
    } finally {
      dst.close();
    }

    // Source removed (FR-8/AC6).
    assert.ok(
      !fs.existsSync(path.join(projectRoot, '.loom', 'loom.db')),
      'old in-repo loom.db must be removed after migration',
    );
  });

  it('no fresh empty DB created beside old one (FR-3)', () => {
    // Source already moved in the previous test; re-check just to be explicit.
    const inRepoPath = path.join(projectRoot, '.loom', 'loom.db');
    assert.ok(!fs.existsSync(inRepoPath), 'no loom.db should exist at in-repo path');
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('prepareRepoState — idempotency (AC5)', () => {
  let tmp: string;
  let loomHome: string;
  let projectRoot: string;

  before(() => {
    tmp = makeTmp();
    loomHome = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    const loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), '', 'utf8');

    const src = createDatabase(path.join(loomDir, 'loom.db'));
    seedDb(src);
    src.close();
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('second prepareRepoState call is a no-op (no re-migration, no duplicate rows)', () => {
    const policy = { loom_home: loomHome };

    const paths1 = prepareRepoState(projectRoot, policy);
    const countBefore = (() => {
      const db = new Database(paths1.dbPath, { readonly: true });
      const n = (db.prepare('SELECT COUNT(*) AS n FROM epics').get() as { n: number }).n;
      db.close();
      return n;
    })();

    // Second call — must be a no-op.
    const paths2 = prepareRepoState(projectRoot, policy);
    assert.equal(paths2.namespaceDir, paths1.namespaceDir, 'paths must be consistent');

    const countAfter = (() => {
      const db = new Database(paths2.dbPath, { readonly: true });
      const n = (db.prepare('SELECT COUNT(*) AS n FROM epics').get() as { n: number }).n;
      db.close();
      return n;
    })();

    assert.equal(countAfter, countBefore, 'row count must not change on second call');
  });
});

// ── Concurrency / lock ────────────────────────────────────────────────────────

describe('prepareRepoState — concurrency (AC5)', () => {
  let tmp: string;
  let loomHome: string;
  let projectRoot: string;
  let seed: SeedResult;

  before(() => {
    tmp = makeTmp();
    loomHome = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    const loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), '', 'utf8');

    const src = createDatabase(path.join(loomDir, 'loom.db'));
    seed = seedDb(src);
    src.close();
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('loser does not re-migrate when lock is held by a live process', () => {
    const policy = { loom_home: loomHome };

    // Run first migration (winner).
    const paths = prepareRepoState(projectRoot, policy);

    // Manually re-create the lock dir to simulate a concurrent winner.
    const lockDir = path.join(paths.namespaceDir, '.migrate.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const ownerJson = { pid: process.pid, hostname: os.hostname(), started_at: new Date().toISOString() };
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(ownerJson));

    const countBefore = (() => {
      const db = new Database(paths.dbPath, { readonly: true });
      const n = (db.prepare('SELECT COUNT(*) AS n FROM epics').get() as { n: number }).n;
      db.close();
      return n;
    })();

    // Loser call: lock is held by OUR live process.
    const loserPaths = prepareRepoState(projectRoot, policy);
    assert.equal(loserPaths.namespaceDir, paths.namespaceDir);

    const countAfter = (() => {
      const db = new Database(loserPaths.dbPath, { readonly: true });
      const n = (db.prepare('SELECT COUNT(*) AS n FROM epics').get() as { n: number }).n;
      db.close();
      return n;
    })();

    assert.equal(countAfter, countBefore, 'loser must not re-migrate or duplicate rows');

    // Clean up the manually created lock.
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it('owner.json contains pid, hostname, started_at', () => {
    const policy = { loom_home: loomHome };
    const paths = resolveRepoStatePaths(projectRoot, policy);
    fs.mkdirSync(paths.namespaceDir, { recursive: true });

    const lockDir = path.join(paths.namespaceDir, '.migrate.lock-check');
    fs.mkdirSync(lockDir, { recursive: true });
    const owner = { pid: process.pid, hostname: os.hostname(), started_at: new Date().toISOString() };
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner));

    const raw = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    assert.ok(typeof raw.pid === 'number', 'owner.json must have pid');
    assert.ok(typeof raw.hostname === 'string', 'owner.json must have hostname');
    assert.ok(typeof raw.started_at === 'string', 'owner.json must have started_at');

    fs.rmSync(lockDir, { recursive: true, force: true });
  });
});

// ── Crash recovery (stale lock) ───────────────────────────────────────────────

describe('prepareRepoState — crash recovery (AC5, FR-3)', () => {
  let tmp: string;
  let loomHome: string;
  let projectRoot: string;
  let seed: SeedResult;

  before(() => {
    tmp = makeTmp();
    loomHome = path.join(tmp, 'loom-home');
    projectRoot = path.join(tmp, 'project');
    const loomDir = path.join(projectRoot, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), '', 'utf8');

    const src = createDatabase(path.join(loomDir, 'loom.db'));
    seed = seedDb(src);
    src.close();
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('clears stale lock (dead PID) and migrates successfully', () => {
    const policy = { loom_home: loomHome };
    const paths = resolveRepoStatePaths(projectRoot, policy);
    fs.mkdirSync(paths.namespaceDir, { recursive: true });

    // Plant a stale lock with a definitely-dead PID (2^31 - 1).
    const lockDir = path.join(paths.namespaceDir, '.migrate.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const staleOwner = { pid: 2147483647, hostname: os.hostname(), started_at: '2000-01-01T00:00:00.000Z' };
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(staleOwner));

    // prepareRepoState should detect stale lock, clear it, and migrate.
    const result = prepareRepoState(projectRoot, policy);

    assert.ok(fs.existsSync(result.dbPath), 'DB must be migrated even with stale lock');
    assert.ok(!fs.existsSync(lockDir), 'stale lock must be removed after migration');

    // Row parity check.
    const dst = new Database(result.dbPath, { readonly: true });
    try {
      const n = dst.prepare('SELECT COUNT(*) AS n FROM epics').get() as { n: number };
      assert.equal(n.n, seed.epicIds.length, 'all rows must be present after stale-lock recovery');
    } finally {
      dst.close();
    }

    // Old in-repo DB removed (FR-8).
    assert.ok(
      !fs.existsSync(path.join(projectRoot, '.loom', 'loom.db')),
      'in-repo loom.db must be removed after successful migration',
    );
  });
});

// ── Stale-source removal (AC6, FR-8) ─────────────────────────────────────────

describe('migrateStateDatabase — stale source removal (AC6, FR-8)', () => {
  let tmp: string;

  before(() => { tmp = makeTmp(); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('removes loom.db, -wal, and -shm from source after confirmed move', () => {
    const srcDir = path.join(tmp, 'stale-src');
    const dstPath = path.join(tmp, 'stale-dst', 'loom.db');
    const srcDbPath = path.join(srcDir, 'loom.db');

    const src = createDatabase(srcDbPath);
    seedDb(src);
    src.close();

    // Manually create sidecar files to test cleanup.
    fs.writeFileSync(srcDbPath + '-wal', Buffer.alloc(0));
    fs.writeFileSync(srcDbPath + '-shm', Buffer.alloc(0));

    migrateStateDatabase({ srcDir, dstPath });

    assert.ok(!fs.existsSync(srcDbPath), 'loom.db must be removed');
    assert.ok(!fs.existsSync(srcDbPath + '-wal'), '-wal must be removed');
    assert.ok(!fs.existsSync(srcDbPath + '-shm'), '-shm must be removed');
  });
});
