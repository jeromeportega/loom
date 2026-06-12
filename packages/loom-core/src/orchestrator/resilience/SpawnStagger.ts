/**
 * Spawn staggering for concurrent `cursor-agent` workers (story-006-004).
 *
 * When the Supervisor fans out several workers at once (`maxConcurrent > 1`),
 * every cursor-agent process boots and atomically rewrites
 * `~/.cursor/cli-config.json` at nearly the same instant. That simultaneous
 * rename storm — the "rename herd" — is the `cli_config_rename` infra fault the
 * classifier (story-006-002) backstops: a worker that opens the config mid-swap
 * sees a transient ENOENT and dies before producing any output.
 *
 * This stagger clears the herd at the source by spacing the spawns out. Each
 * worker awaits `waitForSlot()` before it spawns; the stagger serialises those
 * waits so that consecutive spawns are separated by a SPAWN_STAGGER_MIN_MS..
 * SPAWN_STAGGER_MAX_MS jittered gap drawn from the SAME injectable
 * seeded/timer source (`RetryClock` + `JitterSource`) the retry path uses. Two
 * workers calling `waitForSlot()` at the same instant do NOT both wake after a
 * single ~1.5s delay; the second waits for the first's slot to elapse and then
 * its own gap — so the spawns are genuinely staggered, not merely individually
 * delayed.
 *
 * Trade-off (ADR-7): this accepts 1–2s of per-worker start latency to clear the
 * rename herd, rather than taking a cross-process lock on a file loom does not
 * own. The classifier + bounded auto-retry remain the backstop if the race
 * still fires despite the stagger.
 *
 * Ownership (epic-006 shared contract): story-006-004 creates and owns this
 * file. It IMPORTS `SPAWN_STAGGER_MIN_MS`/`SPAWN_STAGGER_MAX_MS` from the
 * single-source `resilience/constants.ts` (owned by story-006-003) and takes a
 * `RetryClock`/`JitterSource` as injected parameters — it re-declares neither.
 */
import { SPAWN_STAGGER_MIN_MS, SPAWN_STAGGER_MAX_MS } from './constants.js';
import { type RetryClock, type JitterSource } from './RetryClock.js';

export interface SpawnStaggerOptions {
  clock: RetryClock;
  jitter: JitterSource;
}

export class SpawnStagger {
  private readonly clock: RetryClock;
  private readonly jitter: JitterSource;
  /**
   * Tail of the serialisation chain. Each `waitForSlot()` chains its jittered
   * delay onto the previous one so concurrent callers are spaced rather than
   * waking together. The first call chains onto an already-resolved promise, so
   * it waits exactly one gap; the Nth concurrent call waits the sum of N gaps.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: SpawnStaggerOptions) {
    this.clock = opts.clock;
    this.jitter = opts.jitter;
  }

  /**
   * Resolve after this spawn's stagger slot. The delay is a single draw from
   * the injected `JitterSource` mapped uniformly into
   * `[SPAWN_STAGGER_MIN_MS, SPAWN_STAGGER_MAX_MS)` and scheduled via
   * `clock.setTimeout`, so an injected fake clock makes it deterministic and
   * sleepless in tests. Calls serialise: the returned promise does not resolve
   * until every slot requested before it has elapsed plus this one — that is
   * what spaces concurrent spawns apart instead of releasing them together.
   */
  waitForSlot(): Promise<void> {
    const delayMs = this.nextDelayMs();
    const slot = this.chain.then(
      () =>
        new Promise<void>((resolve) => {
          this.clock.setTimeout(() => resolve(), delayMs);
        })
    );
    // The next caller chains onto this slot. Swallow rejection on the stored
    // tail so one failed slot can never poison the chain for later callers
    // (the delay timer above never rejects, so this is purely defensive).
    this.chain = slot.catch(() => undefined);
    return slot;
  }

  /**
   * One jittered delay in `[SPAWN_STAGGER_MIN_MS, SPAWN_STAGGER_MAX_MS)`, drawn
   * from the injected seeded source. A draw of 0 maps to the floor, →1 maps
   * toward the ceiling.
   */
  private nextDelayMs(): number {
    const span = SPAWN_STAGGER_MAX_MS - SPAWN_STAGGER_MIN_MS;
    return SPAWN_STAGGER_MIN_MS + this.jitter.next() * span;
  }
}
