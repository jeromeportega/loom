import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Policy } from '../types.js';
import { resolveLoomHomePath } from './resolveLoomHomePath.js';
import { ensureLoomHome } from './ensureLoomHome.js';
import { resolveRepoStatePaths, type RepoStatePaths } from './repoState.js';
import { migrateStateDatabase } from './migrateState.js';
import { migratePlanningScratch } from './migrateScratch.js';

const LOCK_STALE_CROSS_HOST_MS = 5 * 60 * 1000; // 5 minutes

const LOCK_DIR_NAME = '.migrate.lock';
const OWNER_FILE = 'owner.json';

interface LockOwner {
  pid: number;
  hostname: string;
  started_at: string;
}

function writeLock(lockDir: string): void {
  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  };
  const payload = JSON.stringify(owner);
  // Write to a temp file first, then rename into the lock dir so owner.json
  // is never observed in a partially-written state.
  const tmp = path.join(lockDir, `${OWNER_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, payload, 'utf8');
  try {
    fs.renameSync(tmp, path.join(lockDir, OWNER_FILE));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const raw = fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf8');
    return JSON.parse(raw) as LockOwner;
  } catch {
    return null;
  }
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (!owner) return true; // No owner.json → stale

  if (owner.hostname !== os.hostname()) {
    // Different host; cannot check PID. Use age as a fallback: a lock older
    // than LOCK_STALE_CROSS_HOST_MS is assumed to be from a crashed process.
    const age = Date.now() - Date.parse(owner.started_at);
    return Number.isFinite(age) && age > LOCK_STALE_CROSS_HOST_MS;
  }

  // Same host: check whether the owning process is still alive.
  try {
    process.kill(owner.pid, 0); // Throws ESRCH if process is gone.
    return false; // Process alive → not stale.
  } catch (err: unknown) {
    // ESRCH = no such process (dead). EPERM = alive but owned by another user.
    // Only treat as stale when we are certain the process is gone.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Attempts to acquire the migration lock atomically via fs.mkdirSync.
 * Returns true when the lock was acquired, false when another live process holds it.
 * Clears stale locks (dead PID on same host) and retries once.
 */
function acquireMigrateLock(namespaceDir: string): boolean {
  const lockDir = path.join(namespaceDir, LOCK_DIR_NAME);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      writeLock(lockDir);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      if (isLockStale(lockDir)) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
        continue; // Retry after clearing the stale lock.
      }

      // Live lock held by another process — loser path.
      return false;
    }
  }
  return false;
}

function releaseMigrateLock(namespaceDir: string): void {
  const lockDir = path.join(namespaceDir, LOCK_DIR_NAME);
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Idempotent first-run orchestrator for loom-home state.
 *
 * Orchestration order (ADR-006):
 *   1. resolveLoomHomePath + ensureLoomHome
 *   2. resolveRepoStatePaths(projectRoot, policy) → namespaceDir
 *   3. Acquire .migrate.lock → migrateStateDatabase → migratePlanningScratch → release
 *   4. Return RepoStatePaths
 *
 * The lock is acquired atomically (fs.mkdirSync). The loser double-checks
 * dest existence and returns paths without re-migrating.
 */
export function prepareRepoState(
  projectRoot: string,
  policy: Pick<Policy, 'loom_home'>,
): RepoStatePaths {
  // 1. Ensure loom-home exists as a git repository.
  const loomHome = resolveLoomHomePath(projectRoot, policy);
  ensureLoomHome(loomHome);

  // 2. Resolve namespace paths.
  const paths = resolveRepoStatePaths(projectRoot, policy);
  fs.mkdirSync(paths.namespaceDir, { recursive: true });

  // 3. Acquire migration lock.
  const acquired = acquireMigrateLock(paths.namespaceDir);

  if (!acquired) {
    // Another process holds the lock and is migrating the DB. Spin-wait until
    // it places the DB at paths.dbPath. Without this guard, the caller's
    // openDatabase() would create an empty file at paths.dbPath before the
    // winner's renameSync runs, triggering the winner's fs.existsSync guard and
    // permanently orphaning all historical state.
    //
    // Uses a Date.now() busy-poll instead of Atomics.wait: Node.js forbids
    // Atomics.wait on the main thread (throws TypeError on Node ≥ 9.4).
    if (!fs.existsSync(paths.dbPath)) {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(paths.dbPath) && Date.now() < deadline) {
        const until = Date.now() + 20;
        while (Date.now() < until) { /* busy-wait 20 ms */ }
      }
      if (!fs.existsSync(paths.dbPath)) {
        throw new Error(
          `[loom] Timed out waiting for migration to complete at ${paths.dbPath}. ` +
          'Another process is migrating the database. Try again once it finishes.',
        );
      }
    }
    return paths;
  }

  try {
    const srcDir = path.join(projectRoot, '.loom');
    migrateStateDatabase({ srcDir, dstPath: paths.dbPath });
    migratePlanningScratch({ srcRoot: path.join(srcDir, 'planning'), dstRoot: paths.planningRoot });
  } finally {
    releaseMigrateLock(paths.namespaceDir);
  }

  return paths;
}
