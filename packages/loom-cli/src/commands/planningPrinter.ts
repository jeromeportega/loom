import type { PlanningEvent } from '@loom-ai/core';

/**
 * Returns a PlanningEvent subscriber that tails persona output in the terminal
 * when verbose is true. When verbose is false, every event is a no-op — the
 * default non-verbose output is unchanged.
 *
 * Mirrors makeEventPrinter's partial-line buffering: output chunks are split on
 * newlines; any trailing partial line is held until the next chunk, a phase
 * transition, or an explicit flush() call drains it.
 *
 * Call flush() immediately after the planner resolves to drain any partial line
 * that was not terminated by a newline in the final streamed chunk.
 */
export function makePlanningPrinter(opts: { verbose: boolean }): {
  handle: (e: PlanningEvent) => void;
  flush: () => void;
} {
  let lineBuffer = '';
  let hasOutput = false;

  function flushPartial(): void {
    if (lineBuffer.length > 0) {
      process.stdout.write(lineBuffer + '\n');
      lineBuffer = '';
    }
  }

  function handle(event: PlanningEvent): void {
    if (!opts.verbose) return;

    if (event.type === 'phase') {
      flushPartial();
      // Omit the leading newline before the very first marker to avoid an
      // orphaned blank line at the top of verbose output.
      process.stdout.write(`${hasOutput ? '\n' : ''}── ${event.phase} ──\n`);
      hasOutput = true;
      return;
    }

    if (event.type === 'output') {
      const text = lineBuffer + event.chunk;
      const parts = text.split('\n');
      lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        process.stdout.write(line + '\n');
        hasOutput = true;
      }
    }
  }

  function flush(): void {
    if (!opts.verbose) return;
    flushPartial();
  }

  return { handle, flush };
}
