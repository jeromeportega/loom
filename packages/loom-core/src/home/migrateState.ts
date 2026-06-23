import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { MigrationResult } from './repoState.js';

const DB_FILENAME = 'loom.db';
const KEY_TABLES = ['epics', 'agents', 'audit_log', 'skill_usage', 'lessons'];

function checkpointAndClose(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function removeSidecars(dbPath: string): void {
  for (const ext of ['-wal', '-shm']) {
    const sidecar = dbPath + ext;
    try {
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    } catch {
      // Best-effort sidecar cleanup
    }
  }
}

/**
 * Verifies the copy at tmpPath against the original at srcPath.
 * Returns true only when integrity_check passes AND key-table row counts match.
 * structurally unreachable on any failure (see ADR-004).
 */
function verifyMigration(srcPath: string, tmpPath: string): boolean {
  let dstDb: Database.Database;
  try {
    dstDb = new Database(tmpPath, { readonly: true });
  } catch {
    return false;
  }
  try {
    const check = dstDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (!check[0] || check[0].integrity_check !== 'ok') return false;

    let srcDb: Database.Database;
    try {
      srcDb = new Database(srcPath, { readonly: true });
    } catch {
      return false;
    }
    try {
      for (const table of KEY_TABLES) {
        let srcCount: number;
        try {
          srcCount = (srcDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        } catch {
          continue; // Table absent in source too (old schema) — skip this table.
        }
        let dstCount: number;
        try {
          dstCount = (dstDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        } catch {
          return false; // Source has table but destination doesn't — copy is incomplete.
        }
        if (srcCount !== dstCount) return false;
      }
    } finally {
      srcDb.close();
    }
    return true;
  } finally {
    dstDb.close();
  }
}

/**
 * Migrates the loom state database from srcDir to dstPath.
 *
 * - Checkpoints WAL (PRAGMA wal_checkpoint(TRUNCATE)) and closes source before any move.
 * - Attempts atomic rename first (same filesystem).
 * - On EXDEV (cross-filesystem), falls back to copy-to-temp → integrity_check +
 *   key-table row-count parity → atomic rename into place → unlink source.
 * - Source is NEVER deleted until destination verification passes (ADR-004).
 */
export function migrateStateDatabase(opts: { srcDir: string; dstPath: string }): MigrationResult {
  const { srcDir, dstPath } = opts;
  const srcPath = path.join(srcDir, DB_FILENAME);

  if (!fs.existsSync(srcPath)) {
    return { migrated: false, from: null, to: dstPath, method: null };
  }

  if (path.resolve(srcPath) === path.resolve(dstPath)) {
    return { migrated: false, from: null, to: dstPath, method: null };
  }

  if (fs.existsSync(dstPath)) {
    return { migrated: false, from: null, to: dstPath, method: null };
  }

  fs.mkdirSync(path.dirname(dstPath), { recursive: true });

  // Fold all WAL pages into the main file before any move.
  checkpointAndClose(srcPath);

  // Attempt atomic rename (same filesystem).
  try {
    fs.renameSync(srcPath, dstPath);
    removeSidecars(srcPath);
    return { migrated: true, from: srcPath, to: dstPath, method: 'rename' };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Fall through to cross-filesystem copy path.
  }

  // EXDEV fallback: copy → verify → atomic rename into place → unlink source.
  // `fs.unlinkSync(srcPath)` is structurally unreachable on any failure path.
  const tmpPath = `${dstPath}.tmp-${process.pid}`;
  let tmpCreated = false;
  try {
    fs.copyFileSync(srcPath, tmpPath);
    tmpCreated = true;

    if (!verifyMigration(srcPath, tmpPath)) {
      throw new Error(
        'migrateStateDatabase: verification failed (integrity_check or row-count mismatch) — source preserved',
      );
    }

    // Atomic rename temp into final position.
    fs.renameSync(tmpPath, dstPath);
    tmpCreated = false;

    // Only delete source AFTER destination is fully in place.
    fs.unlinkSync(srcPath);
    removeSidecars(srcPath);

    return { migrated: true, from: srcPath, to: dstPath, method: 'copy' };
  } catch (err) {
    if (tmpCreated) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    }
    throw err;
  }
}
