import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../state/Database.js';
import { LeaseStore } from '../state/LeaseStore.js';

describe('LeaseStore', () => {
  it('acquires a free lease and is idempotent for the same holder', () => {
    const db = createDatabase(':memory:');
    const a = new LeaseStore(db, { owner: 'A', pid: 1, hostname: 'h' });
    assert.ok(a.acquire('epic-001'), 'free lease acquired');
    assert.ok(a.acquire('epic-001'), 're-acquire by same holder is a no-op success');
    assert.equal(a.holder('epic-001')?.owner, 'A');
    db.close();
  });

  it('refuses a live lease held by another supervisor (even same pid)', () => {
    const db = createDatabase(':memory:');
    const alive = () => true;
    // Same pid/host (one process) but distinct owners — must still exclude.
    const a = new LeaseStore(db, { owner: 'A', pid: 1, hostname: 'h', isAlive: alive });
    const b = new LeaseStore(db, { owner: 'B', pid: 1, hostname: 'h', isAlive: alive });
    assert.ok(a.acquire('epic-001'));
    assert.equal(b.acquire('epic-001'), false, 'second supervisor is locked out');
    assert.ok(b.heldByOther('epic-001'), 'b sees the lease held by another');
    db.close();
  });

  it('lets independent epics run in parallel (per-epic, not global)', () => {
    const db = createDatabase(':memory:');
    const alive = () => true;
    const a = new LeaseStore(db, { owner: 'A', pid: 1, hostname: 'h', isAlive: alive });
    const b = new LeaseStore(db, { owner: 'B', pid: 2, hostname: 'h', isAlive: alive });
    assert.ok(a.acquire('epic-001'));
    assert.ok(b.acquire('epic-002'), 'a different epic is not blocked');
    db.close();
  });

  it('frees the lease on release', () => {
    const db = createDatabase(':memory:');
    const alive = () => true;
    const a = new LeaseStore(db, { owner: 'A', pid: 1, hostname: 'h', isAlive: alive });
    const b = new LeaseStore(db, { owner: 'B', pid: 2, hostname: 'h', isAlive: alive });
    assert.ok(a.acquire('epic-001'));
    assert.equal(b.acquire('epic-001'), false);
    a.release('epic-001');
    assert.ok(b.acquire('epic-001'), 'lease is free after release');
    db.close();
  });

  it('reclaims a lease whose same-host holder process is dead', () => {
    const db = createDatabase(':memory:');
    const dead = (pid: number) => pid === 2; // only pid 2 (the reclaimer) is alive
    const a = new LeaseStore(db, { owner: 'A', pid: 999999, hostname: 'h', isAlive: dead });
    assert.ok(a.acquire('epic-001'));
    const b = new LeaseStore(db, { owner: 'B', pid: 2, hostname: 'h', isAlive: dead });
    assert.ok(b.acquire('epic-001'), 'dead same-host holder reclaimed');
    assert.equal(b.holder('epic-001')?.owner, 'B');
    db.close();
  });

  it('reclaims a stale lease regardless of pid liveness', () => {
    const db = createDatabase(':memory:');
    const a = new LeaseStore(db, { owner: 'A', pid: 1, hostname: 'h', isAlive: () => true });
    assert.ok(a.acquire('epic-001'));
    db.prepare(
      `UPDATE loom_lease SET heartbeat_at = datetime('now', '-2 hours') WHERE epic_id = ?`
    ).run('epic-001');
    const b = new LeaseStore(db, {
      owner: 'B',
      pid: 2,
      hostname: 'h',
      staleMs: 60 * 60 * 1000,
      isAlive: () => true,
    });
    assert.ok(b.acquire('epic-001'), 'stale lease reclaimed even when holder looks alive');
    db.close();
  });

  it('does not pid-probe a cross-host holder, but still honors staleness', () => {
    const db = createDatabase(':memory:');
    const a = new LeaseStore(db, { owner: 'A', pid: 1, hostname: 'host-a', isAlive: () => false });
    assert.ok(a.acquire('epic-001'));
    const b = new LeaseStore(db, { owner: 'B', pid: 2, hostname: 'host-b', isAlive: () => false });
    assert.equal(b.acquire('epic-001'), false, 'cross-host live lease respected');
    db.prepare(
      `UPDATE loom_lease SET heartbeat_at = datetime('now', '-2 hours') WHERE epic_id = ?`
    ).run('epic-001');
    assert.ok(b.acquire('epic-001'), 'cross-host lease reclaimed once stale');
    db.close();
  });

  it('heartbeat keeps a lease from being reclaimed', () => {
    const db = createDatabase(':memory:');
    const a = new LeaseStore(db, { owner: 'A', pid: 1, hostname: 'h', staleMs: 50, isAlive: () => true });
    assert.ok(a.acquire('epic-001'));
    a.heartbeat('epic-001');
    assert.ok(a.holder('epic-001'), 'fresh heartbeat keeps the lease live');
    db.close();
  });

  it('holder() returns null when the lease is free', () => {
    const db = createDatabase(':memory:');
    const a = new LeaseStore(db, { owner: 'A', pid: 1, hostname: 'h' });
    assert.equal(a.holder('epic-001'), null);
    assert.equal(a.heldByOther('epic-001'), false);
    db.close();
  });
});
