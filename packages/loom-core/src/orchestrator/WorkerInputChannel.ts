/**
 * Operator → live-worker side-channel for mid-spawn guidance injection.
 *
 * Workers that support a streaming-input transport (today: `claude-cli` via
 * `--input-format stream-json`) build a real channel from their child's
 * stdin. Backends that don't (today: `cursor-cli` and the mock runner)
 * fall back to NO_OP_CHANNEL — the existing per-revision pickup of
 * `.loom/guidance/<story-id>.md` still works for them.
 *
 * The supervisor receives one channel per running story (via
 * `WorkerAssignment.onChannel`) and pushes deltas from a `fs.watch` on
 * the guidance directory. See docs/research/live-agent-guidance.md for
 * the design.
 */
export interface WorkerInputChannel {
  /**
   * Push a user message into the live worker. Returns false if the
   * backend doesn't support streaming input, the spawn has ended, or
   * the message exceeds the byte cap. Implementations MUST handle
   * pipe-buffer backpressure by awaiting `'drain'`.
   */
  push(text: string): Promise<boolean>;
  /** True when the channel can accept messages right now. */
  available(): boolean;
  /** Owner-side close. Idempotent. */
  close(): void;
}

export const NO_OP_CHANNEL: WorkerInputChannel = {
  push: async () => false,
  available: () => false,
  close: () => {},
};

/**
 * Cap on a single push payload. The cap exists because the kernel pipe
 * buffer is ~64KB on macOS; oversized pushes risk stalling the worker
 * subprocess waiting for stdin drain. Bigger guidance should be split
 * by the operator, or land via the per-revision file path.
 */
export const MAX_GUIDANCE_BYTES = 16 * 1024;
