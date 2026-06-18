import { EpicStore } from '../state/index.js';
import { redactSecrets } from '../util/redact.js';
import type { PlanningPhase } from '../types.js';
import type { PlanningEvent } from './PlanningEvent.js';

/**
 * Rolling tail buffer for planning persona output, mirroring Supervisor's
 * per-agent outputTails. Receives raw text chunks, redacts secrets, appends
 * to a bounded buffer, emits PlanningEvents, and flushes to durable state on
 * a periodic timer (ADR-005).
 *
 * The buffer is bounded to LIVE_TAIL_CHARS — oldest content is dropped once
 * the buffer exceeds 2× the limit. This is the same accepted limitation as
 * agents.log_tail (ADR-005).
 */
export class PlanningOutputSink {
  static readonly LIVE_TAIL_CHARS = 4096;
  static readonly TAIL_FLUSH_MS = 1000;

  private tail: { buffer: string; dirty: boolean } = { buffer: '', dirty: false };
  private currentPhase: PlanningPhase | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private epicId: string,
    private epicStore: EpicStore,
    private onPlanningEvent?: (e: PlanningEvent) => void
  ) {}

  /** Starts the periodic flush timer. Call once before any persona runs. */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), PlanningOutputSink.TAIL_FLUSH_MS);
  }

  /**
   * Records the active persona and writes a phase-transition marker into the
   * tail so readers can attribute buffered lines to a persona.
   * Also emits a `phase` PlanningEvent.
   */
  setPhase(phase: PlanningPhase): void {
    this.currentPhase = phase;
    const marker = `\n── ${phase} ──\n`;
    this.appendRaw(marker);
    this.onPlanningEvent?.({ type: 'phase', phase });
  }

  /**
   * Called once per streamed text delta from an LLM call. Redacts secrets
   * before buffering and before emitting the PlanningEvent — all downstream
   * consumers (the DB column, SSE, verbose terminal) receive clean text.
   *
   * CONTRACT: `setPhase()` must be called before any `handleChunk()` call.
   * Chunks that arrive before the first `setPhase()` are written to the
   * rolling buffer (and thus the DB tail) but do NOT emit an `output`
   * PlanningEvent. In the current Planner flow the window is zero lines
   * (setPhase is called before each agent run), so this is not reachable.
   */
  handleChunk(chunk: string): void {
    const redacted = redactSecrets(chunk);
    this.appendRaw(redacted);
    if (this.currentPhase !== null) {
      this.onPlanningEvent?.({ type: 'output', phase: this.currentPhase, chunk: redacted });
    }
  }

  /**
   * Stops the flush timer and performs a final flush. Call after all personas
   * complete (success or error) to ensure nothing is left in the dirty buffer.
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  private appendRaw(s: string): void {
    this.tail.buffer += s;
    if (this.tail.buffer.length > PlanningOutputSink.LIVE_TAIL_CHARS * 2) {
      this.tail.buffer = this.tail.buffer.slice(-PlanningOutputSink.LIVE_TAIL_CHARS);
    }
    this.tail.dirty = true;
  }

  private flush(): void {
    if (!this.tail.dirty) return;
    const trimmed =
      this.tail.buffer.length > PlanningOutputSink.LIVE_TAIL_CHARS
        ? this.tail.buffer.slice(-PlanningOutputSink.LIVE_TAIL_CHARS)
        : this.tail.buffer;
    this.epicStore.updatePlanningLogTail(this.epicId, trimmed);
    this.tail.dirty = false;
  }
}
