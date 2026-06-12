import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { GlobalLimiter, processAlive } from '../state/GlobalLimiter.js';
import { loadMachineConfig } from '../state/MachineConfig.js';

function tmp(name: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-lim-'));
  return { dir, file: path.join(dir, name) };
}

describe('GlobalLimiter', () => {
  it('caps acquisitions at capacity', () => {
    const { dir, file } = tmp('limiter.db');
    try {
      const lim = new GlobalLimiter(2, { path: file });
      assert.ok(lim.acquire('a'), 'first slot');
      assert.ok(lim.acquire('b'), 'second slot');
      assert.equal(lim.acquire('c'), null, 'third refused at the cap');
      assert.equal(lim.activeCount(), 2);
      lim.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('frees a slot on release', () => {
    const { dir, file } = tmp('limiter.db');
    try {
      const lim = new GlobalLimiter(1, { path: file });
      const a = lim.acquire('a');
      assert.ok(a);
      assert.equal(lim.acquire('b'), null, 'at the cap');
      lim.release(a);
      assert.ok(lim.acquire('b'), 'a slot is free after release');
      lim.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shares the cap across separate instances (cross-process)', () => {
    const { dir, file } = tmp('limiter.db');
    try {
      const one = new GlobalLimiter(2, { path: file });
      const two = new GlobalLimiter(2, { path: file });
      assert.ok(one.acquire('x'));
      assert.ok(two.acquire('y'));
      assert.equal(one.acquire('z'), null, 'the cap is shared across instances');
      assert.equal(two.activeCount(), 2);
      one.close();
      two.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a slot whose holder process is dead', () => {
    const { dir, file } = tmp('limiter.db');
    try {
      // Initialize the schema, then seed a slot owned by a dead pid.
      new GlobalLimiter(1, { path: file }).close();
      const raw = new Database(file);
      raw
        .prepare(
          'INSERT INTO slots (pid, label, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?)'
        )
        .run(999999, 'ghost', Date.now(), Date.now());
      raw.close();

      const lim = new GlobalLimiter(1, { path: file });
      // The dead holder is reclaimed on acquire, so a fresh slot is available.
      assert.ok(lim.acquire('live'), 'dead holder reclaimed');
      lim.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('processAlive', () => {
  it('reports the current process as alive', () => {
    assert.equal(processAlive(process.pid), true);
  });

  it('reports a non-existent pid as dead', () => {
    assert.equal(processAlive(999999), false);
  });
});

describe('loadMachineConfig', () => {
  it('returns an empty config when the file is absent', () => {
    const { dir, file } = tmp('config.json');
    try {
      assert.deepEqual(loadMachineConfig(file), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a positive max_global_workers', () => {
    const { dir, file } = tmp('config.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ max_global_workers: 6 }));
      assert.equal(loadMachineConfig(file).maxGlobalWorkers, 6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a non-positive or non-numeric cap', () => {
    const { dir, file } = tmp('config.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ max_global_workers: 0 }));
      assert.equal(loadMachineConfig(file).maxGlobalWorkers, undefined);
      fs.writeFileSync(file, JSON.stringify({ max_global_workers: 'lots' }));
      assert.equal(loadMachineConfig(file).maxGlobalWorkers, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
