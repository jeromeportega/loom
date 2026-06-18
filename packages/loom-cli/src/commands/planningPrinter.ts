import type { PlanningEvent } from '@loom-ai/core';

/**
 * Returns a PlanningEvent subscriber that tails persona output in the terminal
 * when verbose is true. When verbose is false, every event is a no-op — the
 * default non-verbose output is unchanged.
 *
 * Mirrors makeEventPrinter's partial-line buffering: output chunks are split on
 * newlines; any trailing partial line is held until the next chunk or a phase
 * transition flushes it.
 */
export function makePlanningPrinter(opts: { verbose: boolean }): (e: PlanningEvent) => void {
  let lineBuffer = '';

  function flushPartial(): void {
    if (lineBuffer.length > 0) {
      process.stdout.write(lineBuffer + '\n');
      lineBuffer = '';
    }
  }

  return (event) => {
    if (!opts.verbose) return;

    if (event.type === 'phase') {
      flushPartial();
      process.stdout.write(`\n── ${event.phase} ──\n`);
      return;
    }

    if (event.type === 'output') {
      const text = lineBuffer + event.chunk;
      const parts = text.split('\n');
      lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        process.stdout.write(line + '\n');
      }
    }
  };
}
