import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cross-host staleness window: if a lock was last touched more than this many ms
 * ago by a different host, it is assumed to be from a crashed process and is reclaimed.
 * Note: there is no heartbeat — a legitimately long-running holder on another host
 * could have its lock stolen after 5 minutes. Use on shared filesystems with caution.
 */
const LOCK_STALE_CROSS_HOST_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Ownerless lock staleness window: if the lock directory exists but contains no
 * owner.json, we allow up to this many ms for the creator to finish writing
 * owner.json (mkdirSync → temp-file write → renameSync). 60 s is generous but
 * guards against slow I/O on NFS or throttled CI hosts where a rename can stall
 * well beyond the original 30 s ceiling.
 */
const LOCK_STALE_OWNERLESS_MS = 60_000; // 60 seconds
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
  const tmp = path.join(lockDir, `${OWNER_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
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
    // and writeLock completing). Use directory mtime: if the dir is young (< 60 s)
    // treat it as live so we do not steal a lock that is actively being set up.
    // If it is old without an owner file the creator must have crashed — treat as stale.
    try {
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      return age > LOCK_STALE_OWNERLESS_MS;
    } catch {
      return true; // Cannot stat → treat as stale.
    }
  }

  if (owner.hostname !== os.hostname()) {
    // Different host; cannot check PID. Use lock directory mtime as age baseline —
    // more reliable than self-reported started_at across clock skews.
    // Note: owner.started_at is intentionally not used here — it is self-reported
    // by the lock holder and can diverge from wall-clock time on clock-skewed hosts;
    // mtime is more trustworthy for cross-host age estimation.
    try {
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      return Number.isFinite(age) && age > LOCK_STALE_CROSS_HOST_MS;
    } catch {
      return true; // Cannot stat → treat as stale.
    }
  }

  // Same host: check whether the owning process is still alive.
  try {
    process.kill(owner.pid, 0); // Throws ESRCH if process is gone.
    return false; // Process alive → not stale.
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process (dead).
    // EINVAL = PID out of valid OS range per the OS (e.g. exceeds macOS max 99998) — treat as dead.
    // ERR_INVALID_ARG_TYPE = PID out of Node.js's valid signed 32-bit integer range
    //   (>= 2^31 or NaN); also treat as dead — no real process can hold such a PID.
    // EPERM = alive but owned by another user → not stale.
    return code === 'ESRCH' || code === 'EINVAL' || code === 'ERR_INVALID_ARG_TYPE';
  }
}

function tryAcquire(lockDir: string): boolean {
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
      // Remove stale lock, then immediately re-attempt acquisition in the same call
      // frame. Without the immediate retry, two concurrent callers could both observe
      // the stale lock, both call rmSync, and then both successfully mkdirSync in
      // separate poll iterations — breaking mutual exclusion (TOCTOU race). By
      // attempting mkdirSync right after rmSync, only one caller can win; the other
      // gets EEXIST and falls through to the outer poll loop.
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try {
        fs.mkdirSync(lockDir);
        try {
          writeLock(lockDir);
        } catch (writeErr) {
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
          throw writeErr;
        }
        return true;
      } catch (mkErr) {
        if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') throw mkErr;
        // Another racer won the re-acquisition race; fall through to outer loop.
      }
    }

    // Either a live lock or we lost the re-acquisition race — outer loop retries.
    return false;
  }
}

function release(lockDir: string): void {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Runs `fn` while holding an atomic-mkdir lock at path.join(dir, lockName).
 * Reclaims stale locks (dead PID same-host; mtime heuristic cross-host), releases
 * unconditionally. Generalizes the acquireMigrateLock/writeLock/isLockStale pattern
 * currently inline in prepareRepoState.ts.
 *
 * `dir` must exist before calling; an `ENOENT` here means the parent (e.g. loom-home)
 * has not been initialized yet.
 *
 * @throws if the lock cannot be acquired within ~5 s (another process holds it).
 * @throws if called reentrantly with the same (dir, lockName) — this lock is not
 *   reentrant. A nested call to withDirLock with the same lock path will spin for
 *   the full timeout and then throw a timeout error.
 */
export function withDirLock<T>(dir: string, lockName: string, fn: () => T): T {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `[loom] Lock parent directory does not exist: ${dir}. ` +
      'Ensure loom-home is initialized before acquiring a lock.',
    );
  }

  const lockDir = path.join(dir, lockName);

  // Hoist SharedArrayBuffer allocation outside the loop — SharedArrayBuffer
  // instances are non-trivial to allocate; creating one per poll iteration
  // adds unnecessary GC pressure under high contention.
  const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

  // Poll until we can acquire the lock (up to ~5 s, 250 × 20 ms).
  const MAX_POLLS = 250;
  let acquired = false;
  for (let i = 0; i < MAX_POLLS; i++) {
    acquired = tryAcquire(lockDir);
    if (acquired) break;
    // Block the OS thread for 20 ms without busy-spinning the CPU.
    Atomics.wait(_sleepBuf, 0, 0, 20);
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
