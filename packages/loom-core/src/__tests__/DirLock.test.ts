import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDirLock } from '../home/dirLock.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dirlock-'));
}

// ── Basic: runs fn and releases lock ─────────────────────────────────────────

describe('withDirLock — basic', () => {
  it('runs fn and the lock dir is gone afterward', () => {
    const dir = tmpDir();
    try {
      let ran = false;
      withDirLock(dir, '.test.lock', () => { ran = true; });
      assert.ok(ran, 'fn should have run');
      assert.ok(!fs.existsSync(path.join(dir, '.test.lock')), 'lock dir must be released');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the value from fn', () => {
    const dir = tmpDir();
    try {
      const result = withDirLock(dir, '.test.lock', () => 42);
      assert.equal(result, 42);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── fn throws: lock is still released ────────────────────────────────────────

describe('withDirLock — release on throw', () => {
  it('releases the lock even when fn throws', () => {
    const dir = tmpDir();
    try {
      assert.throws(
        () => withDirLock(dir, '.err.lock', () => { throw new Error('boom'); }),
        /boom/,
      );
      assert.ok(!fs.existsSync(path.join(dir, '.err.lock')), 'lock dir must be gone after fn throws');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Stale lock reclaim ────────────────────────────────────────────────────────

describe('withDirLock — stale lock reclaim', () => {
  it('reclaims a stale lock owned by a dead PID and runs fn', () => {
    const dir = tmpDir();
    try {
      const lockDir = path.join(dir, '.stale.lock');
      fs.mkdirSync(lockDir);
      // Seed owner.json with a definitely-dead PID (very high number)
      const fakeOwner = {
        pid: 2_147_483_647,
        hostname: os.hostname(),
        started_at: new Date(Date.now() - 10_000).toISOString(),
      };
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(fakeOwner), 'utf8');

      let ran = false;
      withDirLock(dir, '.stale.lock', () => { ran = true; });
      assert.ok(ran, 'fn must run after stale lock is reclaimed');
      assert.ok(!fs.existsSync(lockDir), 'lock dir must be released after fn');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Concurrent write: N workers contend on the same lock ─────────────────────

describe('withDirLock — concurrent write', () => {
  it('serializes N concurrent lock attempts — counter increments without corruption', async () => {
    const dir = tmpDir();
    const counterFile = path.join(dir, 'counter.txt');
    fs.writeFileSync(counterFile, '0', 'utf8');
    const N = 8;

    // Module path for the compiled dirLock module (resolved relative to this
    // compiled test at dist/__tests__/DirLock.test.js).
    const modulePath = path.resolve(__dirname, '../home/dirLock.js');

    // Each worker increments the counter file under the same lock.
    const workerScript = `
      const { workerData, parentPort } = require('worker_threads');
      const { withDirLock } = require(workerData.modulePath);
      const fs = require('fs');
      try {
        withDirLock(workerData.dir, '.counter.lock', () => {
          const cur = parseInt(fs.readFileSync(workerData.counterFile, 'utf8'), 10);
          fs.writeFileSync(workerData.counterFile, String(cur + 1), 'utf8');
        });
        parentPort.postMessage({ ok: true });
      } catch (err) {
        parentPort.postMessage({ ok: false, error: err.message });
      }
    `;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
          const worker = new Worker(workerScript, {
            eval: true,
            workerData: { modulePath, dir, counterFile },
          });
          worker.on('message', resolve);
          worker.on('error', (err) => reject(err));
        }),
      ),
    );

    try {
      for (const r of results) {
        assert.ok(r.ok, `worker failed: ${r.error ?? 'unknown'}`);
      }
      const finalValue = parseInt(fs.readFileSync(counterFile, 'utf8'), 10);
      assert.equal(finalValue, N, `counter must equal N=${N} after ${N} concurrent increments`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
