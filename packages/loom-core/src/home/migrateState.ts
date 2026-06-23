import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { MigrationResult } from './repoState.js';

const DB_FILENAME = 'loom.db';
const KEY_TABLES = ['epics', 'agents', 'audit_log', 'skill_usage', 'lessons'];

/**
 * Checkpoints WAL pages into the main DB file and closes.
 * Returns true when the WAL file still has residual data after the checkpoint
 * (which can happen when concurrent readers hold a read transaction and prevent
 * a full TRUNCATE — the residual frames are still committed and must travel
 * alongside the main file so no rows are lost).
 */
function checkpointAndClose(dbPath: string): boolean {
  const db = new Database(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const walPath = dbPath + '-wal';
  return fs.existsSync(walPath) && fs.statSync(walPath).size > 0;
}

function reCheckpointAtDst(dstPath: string): void {
  try {
    const db = new Database(dstPath);
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
  } catch { /* best-effort */ }
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
  // Returns true when concurrent readers prevented a full checkpoint and the
  // WAL sidecar still contains committed frames that must move with the DB.
  const walHasResidual = checkpointAndClose(srcPath);
  const srcWalPath = srcPath + '-wal';

  // Attempt atomic rename (same filesystem).
  try {
    fs.renameSync(srcPath, dstPath);
    if (walHasResidual && fs.existsSync(srcWalPath)) {
      // Move residual WAL alongside the main file, then consolidate at dst.
      // Non-best-effort: if WAL rename fails, throw to prevent removeSidecars
      // from silently discarding committed WAL frames.
      fs.renameSync(srcWalPath, dstPath + '-wal');
      reCheckpointAtDst(dstPath);
    }
    removeSidecars(srcPath);
    return { migrated: true, from: srcPath, to: dstPath, method: 'rename' };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Fall through to cross-filesystem copy path.
  }

  // EXDEV fallback: copy → verify → atomic rename into place → unlink source.
  // `fs.unlinkSync(srcPath)` is structurally unreachable on any failure path.
  const tmpPath = `${dstPath}.tmp-${process.pid}`;
  const tmpWalPath = `${tmpPath}-wal`;
  let tmpCreated = false;
  try {
    fs.copyFileSync(srcPath, tmpPath);
    if (walHasResidual && fs.existsSync(srcWalPath)) {
      try { fs.copyFileSync(srcWalPath, tmpWalPath); } catch { /* best-effort */ }
    }
    tmpCreated = true;

    if (!verifyMigration(srcPath, tmpPath)) {
      throw new Error(
        'migrateStateDatabase: verification failed (integrity_check or row-count mismatch) — source preserved',
      );
    }

    // Atomic rename temp into final position.
    fs.renameSync(tmpPath, dstPath);
    // tmpPath is now at dstPath; clear the flag so the catch block does not
    // try to unlink it there (it no longer exists at tmpPath).
    tmpCreated = false;

    if (walHasResidual && fs.existsSync(tmpWalPath)) {
      // Non-best-effort: confirm the WAL is in place before checkpointing and
      // before unlinking the source. If the rename fails, throwing here prevents
      // removeSidecars(srcPath) from running and discarding committed WAL frames.
      // Source is still intact at this point and can be retried.
      if (!fs.existsSync(dstPath + '-wal')) {
        fs.renameSync(tmpWalPath, dstPath + '-wal');
      }
      reCheckpointAtDst(dstPath);
    }

    // Only delete source AFTER destination is fully in place.
    fs.unlinkSync(srcPath);
    removeSidecars(srcPath);

    return { migrated: true, from: srcPath, to: dstPath, method: 'copy' };
  } catch (err) {
    if (tmpCreated) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      try { if (fs.existsSync(tmpWalPath)) fs.unlinkSync(tmpWalPath); } catch { /* best-effort */ }
    }
    throw err;
  }
}
