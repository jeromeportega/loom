import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_STALE_CROSS_HOST_MS = 5 * 60 * 1000; // 5 minutes
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
  if (!owner) {
    // Lock dir exists but no owner.json: may be mid-creation (race between mkdirSync
    // and writeLock completing). Use directory mtime: if the dir is very young (< 30 s)
    // treat it as live so we do not steal a lock that is actively being set up.
    // If it is old without an owner file the creator must have crashed — treat as stale.
    try {
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      return age > 30_000;
    } catch {
      return true; // Cannot stat → treat as stale.
    }
  }

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

function tryAcquire(lockDir: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      // If writeLock throws (e.g. rename of temp owner file fails), clean up
      // the ownerless lock directory so it is not treated as a live lock.
      try {
        writeLock(lockDir);
      } catch (writeErr) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        throw writeErr;
      }
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

function release(lockDir: string): void {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Runs `fn` while holding an atomic-mkdir lock at path.join(dir, lockName).
 * Reclaims stale locks (dead PID same-host; age heuristic cross-host), releases
 * unconditionally. Generalizes the acquireMigrateLock/writeLock/isLockStale pattern
 * currently inline in prepareRepoState.ts.
 */
export function withDirLock<T>(dir: string, lockName: string, fn: () => T): T {
  const lockDir = path.join(dir, lockName);

  // Spin-wait until we can acquire the lock (up to ~5 s, 250 × 20 ms).
  const MAX_POLLS = 250;
  let acquired = false;
  for (let i = 0; i < MAX_POLLS; i++) {
    acquired = tryAcquire(lockDir);
    if (acquired) break;
    // Busy-wait ~20 ms before retrying — mirrors the loser poll in prepareRepoState.
    const spinUntil = Date.now() + 20;
    while (Date.now() < spinUntil) { /* busy-wait */ }
  }
  if (!acquired) {
    throw new Error(
      `[loom] Could not acquire lock ${lockDir} after ${MAX_POLLS * 20} ms. ` +
      'Another process may be holding it. Try again once it finishes.',
    );
  }

  try {
    return fn();
  } finally {
    release(lockDir);
  }
}
