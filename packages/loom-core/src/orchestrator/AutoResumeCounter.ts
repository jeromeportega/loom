/**
 * Run-scoped, non-persisted counter for automatic-resume attempts, keyed per
 * story (ADR-3). One instance is constructed per Supervisor (per run); the Map
 * dies with the instance — no static state, no DB writes (FR-5).
 *
 * Trade-off: per-story keying means aggregate run budget is N × cap. This is
 * an FR-5 open assumption; do not switch to a global key without confirmation.
 */
export class AutoResumeCounter {
  private readonly counts = new Map<string, number>();

  /** Returns the number of auto-resume attempts recorded for storyId (0 if absent). */
  attemptsFor(storyId: string): number {
    return this.counts.get(storyId) ?? 0;
  }

  /** Increments the attempt count for storyId and returns the new count. */
  record(storyId: string): number {
    const next = this.attemptsFor(storyId) + 1;
    this.counts.set(storyId, next);
    return next;
  }
}
