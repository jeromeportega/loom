import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpawnStagger } from '../resilience/SpawnStagger.js';
import {
  Mulberry32,
  SystemRetryClock,
  type RetryClock,
} from '../resilience/RetryClock.js';
import {
  SPAWN_STAGGER_MIN_MS,
  SPAWN_STAGGER_MAX_MS,
} from '../resilience/constants.js';

// ─── Deterministic fake clock: a virtual timeline, NO real sleeps ────────────
//
// Every `setTimeout(fn, ms)` is queued at `now + ms` on a virtual timeline.
// `runAll()` fires queued callbacks in due-time order, advancing `now` to each
// callback's deadline as it fires — so a chain of staggered waits resolves at
// exactly the cumulative virtual time it would in production, with zero real
// time elapsed. Callbacks scheduled BY a callback (the serialised stagger chain
// schedules the next slot only after the previous one fires) are picked up on
// the next drain pass, so the whole chain settles deterministically.

class VirtualClock implements RetryClock {
  /** Virtual "now" in ms — advanced as timers fire. */
  nowMs = 0;
  private queue: Array<{ id: number; dueAt: number; fn: () => void; live: boolean }> = [];
  private nextId = 0;

  monotonicNs(): bigint {
    return BigInt(this.nowMs) * 1_000_000n;
  }
  wallMs(): number {
    return this.nowMs;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.push({ id, dueAt: this.nowMs + ms, fn, live: true });
    return id;
  }
  clearTimeout(handle: unknown): void {
    const entry = this.queue.find((e) => e.id === handle);
    if (entry) entry.live = false;
  }

  /**
   * Fire every queued callback in due-time order until the queue drains,
   * advancing `nowMs` to each callback's deadline. Re-checks the queue after
   * every callback so timers scheduled by a firing callback are picked up.
   * Bounded to guard against an accidental infinite reschedule in a test.
   */
  runAll(): void {
    for (let guard = 0; guard < 10_000; guard++) {
      const next = this.queue
        .filter((e) => e.live)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!next) return;
      next.live = false;
      this.nowMs = Math.max(this.nowMs, next.dueAt);
      next.fn();
    }
    throw new Error('VirtualClock.runAll exceeded its iteration guard');
  }
}

/** Drains microtasks so promise `.then` chains settle between clock drains. */
const flushMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('SpawnStagger.waitForSlot — 1–2s jittered slot from the seeded source (AC1, AC2)', () => {
  it('schedules a single delay inside [MIN, MAX) drawn from the injected source — no real sleep', async () => {
    const clock = new VirtualClock();
    const seed = 0xc0ffee;
    const stagger = new SpawnStagger({ clock, jitter: new Mulberry32(seed) });
    // Predict the delay from the SAME seed + draw sequence the stagger uses.
    const expectGen = new Mulberry32(seed);
    const span = SPAWN_STAGGER_MAX_MS - SPAWN_STAGGER_MIN_MS;
    const expected = SPAWN_STAGGER_MIN_MS + expectGen.next() * span;

    const p = stagger.waitForSlot();
    let resolvedAt: number | undefined;
    void p.then(() => {
      resolvedAt = clock.nowMs;
    });

    // Let the chain's `.then` settle so the slot's timer is actually scheduled
    // on the virtual clock, then fire it. Nothing real slept.
    await flushMicrotasks();
    clock.runAll();
    await p;

    assert.equal(resolvedAt, expected, 'slot resolved at the seeded jittered delay');
    assert.ok(
      expected >= SPAWN_STAGGER_MIN_MS && expected < SPAWN_STAGGER_MAX_MS,
      `delay ${expected} within [${SPAWN_STAGGER_MIN_MS}, ${SPAWN_STAGGER_MAX_MS})`
    );
  });

  it('the draw extremes map to the [MIN, MAX) window edges', async () => {
    // A draw of exactly 0 maps to the floor (MIN); a draw →1 maps just under
    // the ceiling (MAX). Observe the scheduled delay on a recording clock.
    const recorded: number[] = [];
    const recordClock: RetryClock = {
      monotonicNs: () => 0n,
      wallMs: () => 0,
      setTimeout: (fn, ms) => {
        recorded.push(ms);
        fn(); // fire immediately so the chain advances; no real sleep
        return 0;
      },
      clearTimeout: () => undefined,
    };
    const floor = new SpawnStagger({ clock: recordClock, jitter: { next: () => 0 } });
    const ceil = new SpawnStagger({ clock: recordClock, jitter: { next: () => 0.999999 } });
    await floor.waitForSlot();
    await ceil.waitForSlot();

    assert.equal(recorded[0], SPAWN_STAGGER_MIN_MS, 'draw 0 ⇒ MIN');
    assert.ok(
      Math.abs(recorded[1] - SPAWN_STAGGER_MAX_MS) < 1,
      `draw →1 ⇒ ≈ MAX (got ${recorded[1]})`
    );
  });

  it('every slot across many seeds stays within [MIN, MAX)', async () => {
    // Observe the scheduled delay on a recording clock that fires immediately,
    // so a fresh stagger's single slot is captured with no real time elapsed.
    const recorded: number[] = [];
    const recordClock: RetryClock = {
      monotonicNs: () => 0n,
      wallMs: () => 0,
      setTimeout: (fn, ms) => {
        recorded.push(ms);
        fn();
        return 0;
      },
      clearTimeout: () => undefined,
    };
    for (let seed = 1; seed <= 200; seed++) {
      const s = new SpawnStagger({ clock: recordClock, jitter: new Mulberry32(seed) });
      await s.waitForSlot();
    }
    assert.equal(recorded.length, 200, 'one delay scheduled per stagger');
    for (const ms of recorded) {
      assert.ok(
        ms >= SPAWN_STAGGER_MIN_MS && ms < SPAWN_STAGGER_MAX_MS,
        `delay ${ms} within [${SPAWN_STAGGER_MIN_MS}, ${SPAWN_STAGGER_MAX_MS})`
      );
    }
  });
});

describe('SpawnStagger — concurrent spawns are SPACED under deterministic timing (AC3)', () => {
  it('serialises N concurrent waits so each resolves a 1–2s gap after the previous, no real sleep', async () => {
    const clock = new VirtualClock();
    const stagger = new SpawnStagger({ clock, jitter: new Mulberry32(7) });

    // Fire five waits "at the same instant" — exactly the rename-herd scenario:
    // the Supervisor dispatching maxConcurrent workers in one loop turn.
    const N = 5;
    const resolveTimes: number[] = [];
    const waits = Array.from({ length: N }, (_, i) =>
      stagger.waitForSlot().then(() => {
        resolveTimes[i] = clock.nowMs;
      })
    );

    // Drain the virtual clock until every slot has settled. Each fired timer may
    // schedule the next slot's timer (the serialised chain), so alternate
    // running timers with flushing microtasks until all resolve.
    for (let i = 0; i < N + 2; i++) {
      await flushMicrotasks();
      clock.runAll();
    }
    await Promise.all(waits);

    assert.equal(resolveTimes.length, N, 'all slots resolved');
    // Spacing invariant: every consecutive pair is separated by a 1–2s gap.
    for (let i = 1; i < N; i++) {
      const gap = resolveTimes[i] - resolveTimes[i - 1];
      assert.ok(
        gap >= SPAWN_STAGGER_MIN_MS && gap < SPAWN_STAGGER_MAX_MS,
        `gap ${i} (${gap}ms) within [${SPAWN_STAGGER_MIN_MS}, ${SPAWN_STAGGER_MAX_MS})`
      );
    }
    // And they resolve strictly in request order, monotonically increasing.
    for (let i = 1; i < N; i++) {
      assert.ok(resolveTimes[i] > resolveTimes[i - 1], `slot ${i} after slot ${i - 1}`);
    }
    // The whole herd is spread across at least (N-1)·MIN ms — never a single
    // ~1.5s burst (which is what an un-serialised per-call delay would produce).
    const totalSpread = resolveTimes[N - 1] - resolveTimes[0];
    assert.ok(
      totalSpread >= (N - 1) * SPAWN_STAGGER_MIN_MS,
      `total spread ${totalSpread}ms >= ${(N - 1) * SPAWN_STAGGER_MIN_MS}ms`
    );
  });

  it('an UN-serialised per-call delay would NOT space the herd — proves serialisation matters', async () => {
    // Control: independent timers all started at t=0 resolve within one MAX
    // window of each other (a burst), not spaced. This is the failure mode the
    // chain prevents; asserting it makes the stagger test meaningful.
    const clock = new VirtualClock();
    const gen = new Mulberry32(7);
    const span = SPAWN_STAGGER_MAX_MS - SPAWN_STAGGER_MIN_MS;
    const N = 5;
    const resolveTimes: number[] = [];
    const waits = Array.from({ length: N }, (_, i) => {
      const ms = SPAWN_STAGGER_MIN_MS + gen.next() * span;
      return new Promise<void>((resolve) => {
        clock.setTimeout(resolve, ms);
      }).then(() => {
        resolveTimes[i] = clock.nowMs;
      });
    });
    await flushMicrotasks();
    clock.runAll();
    await Promise.all(waits);

    const burst = Math.max(...resolveTimes) - Math.min(...resolveTimes);
    assert.ok(
      burst < SPAWN_STAGGER_MAX_MS,
      `un-serialised waits bunch within one window (${burst}ms) — not staggered`
    );
  });
});

describe('SpawnStagger — production sources wire without altering them', () => {
  it('constructs against a SystemRetryClock + Mulberry32 and returns a promise', async () => {
    // Construct with the REAL production sources to prove the wiring type-checks
    // and runs, but drive the delay through a fake clock instead of awaiting a
    // genuine 1–2s sleep — the no-real-sleep invariant (AC2) holds. We assert
    // the SystemRetryClock itself exposes the production timer surface.
    const sys = new SystemRetryClock();
    assert.equal(typeof sys.monotonicNs(), 'bigint');
    assert.equal(typeof sys.wallMs(), 'number');
    const h = sys.setTimeout(() => undefined, 0);
    sys.clearTimeout(h);

    const clock = new VirtualClock();
    const stagger = new SpawnStagger({ clock, jitter: new Mulberry32(1) });
    const p = stagger.waitForSlot();
    assert.ok(p instanceof Promise, 'waitForSlot returns a promise');
    await flushMicrotasks();
    clock.runAll();
    await p; // resolves via the fake clock — no real time elapsed
  });
});
