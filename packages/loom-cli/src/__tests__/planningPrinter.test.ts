import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makePlanningPrinter } from '../commands/planningPrinter.js';
import { spec } from '../commands/epic.js';
import type { PlanningEvent } from '@loom-ai/core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Intercepts process.stdout.write for the duration of the callback. Returns
 * the accumulated string of all write calls. Does NOT forward to the real
 * terminal — tests only need the captured string.
 */
function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  const replacement = function (
    chunk: string | Uint8Array,
    _encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    _cb?: (err?: Error | null) => void
  ): boolean {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  process.stdout.write = replacement as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

// ─── makePlanningPrinter — verbose: true (AC2) ────────────────────────────────

describe('makePlanningPrinter({ verbose: true })', () => {
  it('prints a complete-line output chunk immediately', () => {
    const { handle } = makePlanningPrinter({ verbose: true });
    const out = captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'hello world\n' } satisfies PlanningEvent);
    });
    assert.equal(out, 'hello world\n');
  });

  it('buffers a partial line (no trailing newline) until the next chunk completes it', () => {
    const { handle } = makePlanningPrinter({ verbose: true });

    const first = captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'par' } satisfies PlanningEvent);
    });
    assert.equal(first, '', 'partial chunk produces no output yet');

    const second = captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'tial\n' } satisfies PlanningEvent);
    });
    assert.equal(second, 'partial\n', 'second chunk completes the line');
  });

  it('splits a chunk with multiple newlines into multiple lines', () => {
    const { handle } = makePlanningPrinter({ verbose: true });
    const out = captureStdout(() => {
      handle({ type: 'output', phase: 'pm', chunk: 'line1\nline2\nline3\n' } satisfies PlanningEvent);
    });
    assert.equal(out, 'line1\nline2\nline3\n');
  });

  it('prints a phase marker on a type: phase event', () => {
    const { handle } = makePlanningPrinter({ verbose: true });
    const out = captureStdout(() => {
      handle({ type: 'phase', phase: 'pm' } satisfies PlanningEvent);
    });
    assert.match(out, /pm/, 'phase name appears in the marker');
    assert.match(out, /──/, 'marker separator appears');
  });

  it('flushes a partial line when a phase transition arrives', () => {
    const { handle } = makePlanningPrinter({ verbose: true });

    captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'unfinished' } satisfies PlanningEvent);
    });

    const out = captureStdout(() => {
      handle({ type: 'phase', phase: 'pm' } satisfies PlanningEvent);
    });
    assert.match(out, /unfinished/, 'partial line is flushed before the phase marker');
    assert.match(out, /pm/, 'phase marker follows the flushed line');
  });

  it('prints the exact chunk it receives (redacted source AC4 — printer is a pass-through)', () => {
    // The core (PlanningOutputSink) applies redaction before firing onPlanningEvent.
    // The printer is intentionally a pass-through — it must not re-redact.
    const { handle } = makePlanningPrinter({ verbose: true });
    const redactedChunk = 'call me sk-ant-REDACTED at 5pm\n';
    const out = captureStdout(() => {
      handle({ type: 'output', phase: 'architect', chunk: redactedChunk } satisfies PlanningEvent);
    });
    assert.equal(out, redactedChunk, 'printer emits the chunk verbatim without re-redacting');
  });

  it('handles a chunk delivered across exactly two calls (partial-line buffering)', () => {
    const { handle } = makePlanningPrinter({ verbose: true });

    captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'half' } satisfies PlanningEvent);
    });
    const out = captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: '-line\n' } satisfies PlanningEvent);
    });
    assert.equal(out, 'half-line\n');
  });

  it('omits the leading newline before the very first phase marker', () => {
    const { handle } = makePlanningPrinter({ verbose: true });
    const out = captureStdout(() => {
      handle({ type: 'phase', phase: 'analyst' } satisfies PlanningEvent);
    });
    assert.ok(!out.startsWith('\n'), 'first phase marker must not have a leading newline');
    assert.match(out, /analyst/);
  });

  it('adds a leading newline before a subsequent phase marker', () => {
    const { handle } = makePlanningPrinter({ verbose: true });
    captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'text\n' } satisfies PlanningEvent);
    });
    const out = captureStdout(() => {
      handle({ type: 'phase', phase: 'pm' } satisfies PlanningEvent);
    });
    assert.ok(out.startsWith('\n'), 'subsequent phase marker must be preceded by a newline');
    assert.match(out, /pm/);
  });
});

// ─── flush() (no partial line lost) ──────────────────────────────────────────

describe('makePlanningPrinter flush()', () => {
  it('flushes a buffered partial line that has no trailing newline', () => {
    const { handle, flush } = makePlanningPrinter({ verbose: true });

    captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'no newline at end' } satisfies PlanningEvent);
    });

    const out = captureStdout(() => flush());
    assert.equal(out, 'no newline at end\n', 'flush() drains the partial line');
  });

  it('is a no-op when there is no buffered partial line', () => {
    const { handle, flush } = makePlanningPrinter({ verbose: true });

    captureStdout(() => {
      handle({ type: 'output', phase: 'pm', chunk: 'complete\n' } satisfies PlanningEvent);
    });

    const out = captureStdout(() => flush());
    assert.equal(out, '', 'flush() on empty buffer writes nothing');
  });

  it('is a no-op when verbose is false', () => {
    const { handle, flush } = makePlanningPrinter({ verbose: false });

    // Calling handle with content and flush on a silent printer must produce nothing
    const out = captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'secret thoughts' } satisfies PlanningEvent);
      flush();
    });
    assert.equal(out, '');
  });
});

// ─── makePlanningPrinter — verbose: false (AC3) ───────────────────────────────

describe('makePlanningPrinter({ verbose: false })', () => {
  it('produces no output on type: output events', () => {
    const { handle } = makePlanningPrinter({ verbose: false });
    const out = captureStdout(() => {
      handle({ type: 'output', phase: 'analyst', chunk: 'secret persona thoughts\n' } satisfies PlanningEvent);
    });
    assert.equal(out, '', 'non-verbose printer writes nothing');
  });

  it('produces no output on type: phase events', () => {
    const { handle } = makePlanningPrinter({ verbose: false });
    const out = captureStdout(() => {
      handle({ type: 'phase', phase: 'pm' } satisfies PlanningEvent);
    });
    assert.equal(out, '', 'non-verbose printer writes nothing for phase transitions');
  });

  it('produces no output across a full sequence of events', () => {
    const { handle } = makePlanningPrinter({ verbose: false });
    const out = captureStdout(() => {
      handle({ type: 'phase', phase: 'analyst' } satisfies PlanningEvent);
      handle({ type: 'output', phase: 'analyst', chunk: 'line1\n' } satisfies PlanningEvent);
      handle({ type: 'output', phase: 'analyst', chunk: 'partial' } satisfies PlanningEvent);
      handle({ type: 'phase', phase: 'pm' } satisfies PlanningEvent);
      handle({ type: 'output', phase: 'pm', chunk: 'line2\n' } satisfies PlanningEvent);
    });
    assert.equal(out, '', 'concise default: no persona output escapes to the terminal');
  });
});

// ─── spec.options wiring (AC1) ───────────────────────────────────────────────

describe('epic spec.options — --verbose flag registration (AC1)', () => {
  it('registers --verbose in spec.options as a boolean with changesOutputShape: true', () => {
    const flag = spec.options?.find((o) => o.name === '--verbose');
    assert.ok(flag, '--verbose must be present in epic spec.options');
    assert.equal(flag.type, 'boolean', '--verbose must be type boolean');
    assert.equal(
      flag.changesOutputShape,
      true,
      '--verbose must set changesOutputShape: true, mirroring run --verbose'
    );
  });

  it('also has --force with changesOutputShape: false (regression guard)', () => {
    const force = spec.options?.find((o) => o.name === '--force');
    assert.ok(force, '--force must still be present');
    assert.equal(force.changesOutputShape, false);
  });
});
