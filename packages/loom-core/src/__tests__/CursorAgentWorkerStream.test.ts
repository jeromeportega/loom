import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CursorAgentWorker, type CursorAgentWorkerOptions } from '../orchestrator/CursorAgentWorker.js';
import { WorkerTimeoutGuard, type WorkerTimeoutGuardOptions } from '../orchestrator/WorkerTimeoutGuard.js';
import type { WorkerAssignment, WorkerUsage } from '../orchestrator/WorkerRunner.js';
import type { Story } from '../types.js';

/**
 * Real cursor-agent `--output-format stream-json --stream-partial-output`
 * event lines, captured verbatim as inline string constants. Kept inline (not
 * loose fixture files) because `npm test` runs against `dist/__tests__/**` and
 * loose files are not copied by the TypeScript build (per the epic-004
 * ownership note).
 */
const FIXTURE = {
  // Session bootstrap — no humanText, no usage.
  systemInit: '{"type":"system","subtype":"init","model":"sonnet-4"}',
  // User echo — silent for cursor (no guidance-trace branch like claude).
  user: '{"type":"user","message":{"role":"user","content":"implement the story"}}',
  // The dashboard SSE live-output surface: incremental assistant text.
  assistantText:
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading CursorAgentWorker.ts to understand the seam."}]}}',
  // A tool invocation event — must not throw, must stay silent.
  toolCall:
    '{"type":"tool_call","subtype":"started","tool":"read_file","args":{"path":"a.ts"}}',
  // Terminal event WITH usage fields — the only usage-harvest surface.
  resultWithUsage:
    '{"type":"result","result":"done","duration_ms":1234,' +
    '"usage":{"input_tokens":100,"output_tokens":50,' +
    '"cache_read_input_tokens":10,"cache_creation_input_tokens":5},' +
    '"request_count":3,"total_cost_usd":0.42}',
  // Terminal event with NO usage fields — exercises the requestCount:1 fallback.
  resultNoUsage: '{"type":"result","result":"done","duration_ms":10}',
} as const;

const EXPECTED_USAGE_WITH_FIELDS: WorkerUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheCreationTokens: 5,
  totalTokens: 165,
  requestCount: 3,
  costUsd: 0.42,
};

const EXPECTED_USAGE_FALLBACK: WorkerUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  requestCount: 1,
  costUsd: 0,
};

// ─── Deterministic fakes (no real cursor-agent, no real timers, no sleeps) ──

/**
 * A controllable child process. The test drives stdout/stderr/close manually;
 * stdin is captured. Satisfies exactly the surface `spawnAgent` touches.
 */
class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinEnded = false;
  writes: string[] = [];
  stdin: { write(s: string): boolean; end(): void; readonly writableEnded: boolean };

  constructor() {
    super();
    const child = this;
    this.stdin = {
      write(s: string): boolean {
        child.writes.push(s);
        return true;
      },
      end(): void {
        child.stdinEnded = true;
      },
      get writableEnded(): boolean {
        return child.stdinEnded;
      },
    };
  }

  emitData(s: string): void {
    this.stdout.emit('data', Buffer.from(s));
  }

  close(code: number | null): void {
    this.emit('close', code);
  }
}

/**
 * Injectable clock. The guard reads `monotonicNow()` for duration math and
 * `now()` only for suspend detection (story-006-005); both advance together
 * here so a single manual `fire()` after `advance()` evaluates a deadline. The
 * poll cadence itself is irrelevant to the kill decision.
 */
class FakeClock {
  t = 0;
  private intervals = new Map<symbol, () => void>();
  now = (): number => this.t;
  // Monotonic backs the guard's stall/cap math; keep it in lockstep with the
  // wall clock (ms → ns) so `advance()` drives durations as before.
  monotonicNow = (): bigint => BigInt(this.t) * 1_000_000n;
  setInterval = (fn: () => void): unknown => {
    const h = Symbol('interval');
    this.intervals.set(h, fn);
    return h;
  };
  clearInterval = (h: unknown): void => {
    this.intervals.delete(h as symbol);
  };
  setTimeout = (): unknown => 'grace-timer';
  clearTimeout = (): void => undefined;
  advance(ms: number): void {
    this.t += ms;
  }
  /** Simulate a poll tick: run every live interval callback once. */
  fire(): void {
    for (const fn of this.intervals.values()) fn();
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
class TestableCursor extends CursorAgentWorker {
  lastChild?: FakeChild;
  constructor(
    private clock?: FakeClock,
    private kills?: Array<{ pid: number; signal: string }>,
    opts: CursorAgentWorkerOptions = {}
  ) {
    super(opts);
  }

  exposeAgentArgs(): string[] {
    return (this as any).agentArgs();
  }
  exposeParseStreamLine(line: string): {
    humanText?: string;
    usage?: WorkerUsage;
    traces?: Array<{ kind: string; subject?: string; rationale: string }>;
  } {
    return (this as any).parseStreamLine(line);
  }
  exposeStreamingInput(): boolean {
    return (this as any).streamingInput();
  }
  exposeIsTerminalLine(line: string): boolean {
    return (this as any).isTerminalLine(line);
  }
  get usage(): WorkerUsage | undefined {
    return (this as any).accumulatedUsage;
  }

  protected spawnChild(): ChildProcessWithoutNullStreams {
    const c = new FakeChild();
    this.lastChild = c;
    return c as unknown as ChildProcessWithoutNullStreams;
  }

  protected createGuard(opts: WorkerTimeoutGuardOptions): WorkerTimeoutGuard {
    if (!this.clock || !this.kills) return super.createGuard(opts);
    const kills = this.kills;
    const clock = this.clock;
    return new WorkerTimeoutGuard({
      ...opts,
      warnMs: 0,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      killProcess: (pid, signal) => kills.push({ pid, signal }),
    });
  }

  /** Returns the spawnAgent promise synchronously so the test can grab
      `lastChild` (set inside the promise executor) before driving it. */
  runSpawn(a: WorkerAssignment): Promise<{
    code: number | null;
    output: string;
    timedOut: boolean;
    timeoutReason?: string;
  }> {
    return (this as any).spawnAgent(a, 'ignored');
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const STORY: Story = {
  id: 'story-004-001',
  title: 'stream-json switch',
  description: 'noop',
  acceptance_criteria: ['n/a'],
  estimated_complexity: 'medium',
  dependencies: [],
};

function assignment(over: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    storyId: STORY.id,
    epicId: 'epic-004',
    story: STORY,
    worktreePath: '/tmp/loom-fake-worktree',
    branchName: 'story/story-004-001',
    baseSha: '',
    projectRoot: '/tmp/loom-fake-worktree',
    skills: [],
    ...over,
  };
}

// ─── (1) agentArgs ──────────────────────────────────────────────────────────

describe('CursorAgentWorker.agentArgs', () => {
  it('returns exactly the stream-json + partial-output invocation', () => {
    const w = new TestableCursor(undefined, undefined, { model: 'opus-4' });
    assert.deepEqual(w.exposeAgentArgs(), [
      '-p',
      '--model',
      'opus-4',
      '--force',
      '--trust',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
    ]);
  });

  it('defaults the model to sonnet-4', () => {
    const w = new TestableCursor();
    assert.equal(w.exposeAgentArgs()[2], 'sonnet-4');
  });
});

// ─── (2)/(3)/(4) parseStreamLine against fixture lines ───────────────────────

describe('CursorAgentWorker.parseStreamLine — fixture-driven', () => {
  const w = new TestableCursor();

  it('system/init → no humanText, no usage', () => {
    assert.deepEqual(w.exposeParseStreamLine(FIXTURE.systemInit), {});
  });

  it('user event → silent (no guidance trace)', () => {
    assert.deepEqual(w.exposeParseStreamLine(FIXTURE.user), {});
  });

  it('assistant text content → humanText and assistantText equal the text', () => {
    assert.deepEqual(w.exposeParseStreamLine(FIXTURE.assistantText), {
      humanText: 'Reading CursorAgentWorker.ts to understand the seam.',
      assistantText: 'Reading CursorAgentWorker.ts to understand the seam.',
    });
  });

  it('assistant with no text blocks → empty', () => {
    assert.deepEqual(
      w.exposeParseStreamLine('{"type":"assistant","message":{"content":[]}}'),
      {}
    );
  });

  it('tool_call → no throw, no output, no usage', () => {
    assert.deepEqual(w.exposeParseStreamLine(FIXTURE.toolCall), {});
  });

  it('result with usage fields → WorkerUsage via the readNum key lists', () => {
    assert.deepEqual(w.exposeParseStreamLine(FIXTURE.resultWithUsage), {
      usage: EXPECTED_USAGE_WITH_FIELDS,
    });
  });

  it('result with NO usage fields → requestCount:1 per-session fallback (FR-4)', () => {
    assert.deepEqual(w.exposeParseStreamLine(FIXTURE.resultNoUsage), {
      usage: EXPECTED_USAGE_FALLBACK,
    });
  });

  it('garbage (non-JSON) line → falls through to { humanText: line }, never throws', () => {
    assert.deepEqual(w.exposeParseStreamLine('not json at all'), {
      humanText: 'not json at all',
    });
  });

  it('unknown event type → empty, never throws (version-drift degrades to noise)', () => {
    assert.deepEqual(w.exposeParseStreamLine('{"type":"telemetry","foo":1}'), {});
  });

  it('JSON array / primitive → treated as opaque humanText, never throws', () => {
    assert.deepEqual(w.exposeParseStreamLine('[1,2,3]'), { humanText: '[1,2,3]' });
    assert.deepEqual(w.exposeParseStreamLine('42'), { humanText: '42' });
  });
});

// ─── (6) terminal-event detection stays never-terminal ───────────────────────

describe('CursorAgentWorker — terminal/streaming defaults (ADR-7)', () => {
  it('streamingInput() is false and isTerminalLine is never-terminal', () => {
    const w = new TestableCursor();
    assert.equal(w.exposeStreamingInput(), false);
    assert.equal(w.exposeIsTerminalLine(FIXTURE.resultWithUsage), false);
    assert.equal(w.exposeIsTerminalLine(FIXTURE.assistantText), false);
  });
});

// ─── (2) SSE live-output surface + (5) partial-line carry + usage harvest ────

describe('CursorAgentWorker.spawnAgent — stdout wiring under stream-json', () => {
  it('assistant text reaches onOutput unchanged (the dashboard SSE surface)', async () => {
    const clock = new FakeClock();
    const kills: Array<{ pid: number; signal: string }> = [];
    const w = new TestableCursor(clock, kills);
    const out: Array<{ chunk: string; source: string }> = [];

    const p = w.runSpawn(
      assignment({
        stallMs: 1000,
        absoluteCapMs: 100_000,
        onOutput: (chunk, source) => out.push({ chunk, source }),
      })
    );
    const child = w.lastChild!;
    child.emitData(FIXTURE.systemInit + '\n');
    child.emitData(FIXTURE.assistantText + '\n');
    child.emitData(FIXTURE.toolCall + '\n');
    child.close(0);
    const res = await p;

    assert.equal(res.code, 0);
    assert.equal(res.timedOut, false);
    // Only the assistant text surfaces; system/init and tool_call stay silent.
    const stdout = out.filter((o) => o.source === 'stdout');
    assert.equal(stdout.length, 1);
    assert.equal(stdout[0].chunk, 'Reading CursorAgentWorker.ts to understand the seam.\n');
  });

  it('harvests usage (incl. requestCount + cost) from the result event', async () => {
    const clock = new FakeClock();
    const kills: Array<{ pid: number; signal: string }> = [];
    const w = new TestableCursor(clock, kills);

    const p = w.runSpawn(assignment({ stallMs: 1000, absoluteCapMs: 100_000 }));
    const child = w.lastChild!;
    child.emitData(FIXTURE.assistantText + '\n');
    child.emitData(FIXTURE.resultWithUsage + '\n');
    child.close(0);
    await p;

    assert.deepEqual(w.usage, EXPECTED_USAGE_WITH_FIELDS);
  });

  it('result with no usage fields still records the requestCount:1 fallback', async () => {
    const clock = new FakeClock();
    const kills: Array<{ pid: number; signal: string }> = [];
    const w = new TestableCursor(clock, kills);

    const p = w.runSpawn(assignment({ stallMs: 1000, absoluteCapMs: 100_000 }));
    const child = w.lastChild!;
    child.emitData(FIXTURE.resultNoUsage + '\n');
    child.close(0);
    await p;

    assert.deepEqual(w.usage, EXPECTED_USAGE_FALLBACK);
  });

  it('partial-line carry: a result event split mid-JSON across two chunks parses once', async () => {
    const clock = new FakeClock();
    const kills: Array<{ pid: number; signal: string }> = [];
    const w = new TestableCursor(clock, kills);

    const p = w.runSpawn(assignment({ stallMs: 1000, absoluteCapMs: 100_000 }));
    const child = w.lastChild!;
    const split = Math.floor(FIXTURE.resultWithUsage.length / 2);
    // First chunk has no newline → buffered in carry, not yet parsed.
    child.emitData(FIXTURE.resultWithUsage.slice(0, split));
    assert.equal(w.usage, undefined, 'must not parse before the line completes');
    // Second chunk completes the line; the newline triggers exactly one parse.
    child.emitData(FIXTURE.resultWithUsage.slice(split) + '\n');
    child.close(0);
    await p;

    // Byte-identical to a single-chunk parse — folded exactly once, not twice.
    assert.deepEqual(w.usage, EXPECTED_USAGE_WITH_FIELDS);
  });

  it('a result line does not end the session early — the session ends on process exit', async () => {
    const clock = new FakeClock();
    const kills: Array<{ pid: number; signal: string }> = [];
    const w = new TestableCursor(clock, kills);

    let settled = false;
    const p = w
      .runSpawn(assignment({ stallMs: 1000, absoluteCapMs: 100_000 }))
      .then((r) => {
        settled = true;
        return r;
      });
    const child = w.lastChild!;
    child.emitData(FIXTURE.resultWithUsage + '\n');
    // Flush microtasks: the result event alone must NOT resolve the spawn.
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'result event must not terminate the session early');

    child.close(0);
    const res = await p;
    assert.equal(settled, true);
    assert.equal(res.code, 0);
  });
});

// ─── (7)/(8) stall behaviour driven only via stdout chunks (ADR-1) ───────────

describe('CursorAgentWorker.spawnAgent — progress-aware stall behaviour', () => {
  it('a worker emitting incremental output survives a run lasting 3x the stall window', async () => {
    const clock = new FakeClock();
    const kills: Array<{ pid: number; signal: string }> = [];
    const w = new TestableCursor(clock, kills);
    const stallMs = 1000;

    const p = w.runSpawn(assignment({ stallMs, absoluteCapMs: 100 * stallMs }));
    const child = w.lastChild!;

    // Emit a chunk every 0.4 of the stall window for 3x the window. Each
    // stdout chunk resets the stall clock, so the worker is never killed.
    const step = Math.floor(stallMs * 0.4);
    for (let elapsed = 0; elapsed < stallMs * 3; elapsed += step) {
      child.emitData(FIXTURE.assistantText + '\n'); // recordActivity at now=elapsed
      clock.advance(step);
      clock.fire(); // poll: sinceActivity = step < stallMs → no kill
    }
    assert.equal(kills.length, 0, 'an actively-streaming worker is never stall-killed');

    child.close(0);
    const res = await p;
    assert.equal(res.timedOut, false);
    assert.equal(res.code, 0);
  });

  it('a worker silent for story_stall_minutes is killed exactly at the window', async () => {
    const clock = new FakeClock();
    const kills: Array<{ pid: number; signal: string }> = [];
    const w = new TestableCursor(clock, kills);
    const stallMs = 1000;

    const p = w.runSpawn(assignment({ stallMs, absoluteCapMs: 100 * stallMs }));
    const child = w.lastChild!;

    // Just before the window — no output, but not yet over the stall budget.
    clock.advance(stallMs - 1);
    clock.fire();
    assert.equal(kills.length, 0, 'must not kill before the stall window elapses');

    // Cross the window exactly — the stall kill fires.
    clock.advance(1);
    clock.fire();
    assert.equal(kills.length, 1, 'silent worker killed at the stall window');
    assert.equal(kills[0].signal, 'SIGTERM');
    assert.equal(kills[0].pid, -4242, 'signals the whole process group (negative pid)');

    // SIGTERM kills the real process → close fires in production; emit it here.
    child.close(null);
    const res = await p;
    assert.equal(res.timedOut, true);
    assert.equal(res.timeoutReason, 'stall');
  });
});
