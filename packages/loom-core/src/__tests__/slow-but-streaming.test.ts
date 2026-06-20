/**
 * Slow-but-streaming & stream-wiring integration tests (epic-030 story-030-002).
 *
 * Two layers:
 *
 *   1. ClaudeCodeWorker.parseStreamLine routing: verify that `system/status
 *      status='requesting'` emits `{ kind: 'requesting' }` and that other parsed
 *      events emit `{ kind: 'stream_event', label }`, as required by ADR-002.
 *
 *   2. BaseCliWorker integration: exercises the full stdout data-handler pipeline
 *      (recordActivity FIRST, then processLines) with a fake child, an injected-
 *      clock guard, and a fake git worktree so run() can checkpoint + return a
 *      WorkerResult.
 *
 * All clock advances use injected monotonic+wall time (no real sleeps).
 *
 * Mandated test:
 *   SLOW-BUT-STREAMING guard unit variant lives in hung-request-detection.test.ts.
 *   The integration variant (same-buffer race, arm/disarm through the real data
 *   handler) lives here.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { ClaudeCodeWorker } from '../orchestrator/ClaudeCodeWorker.js';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';
import { WorkerTimeoutGuard, type WorkerTimeoutGuardOptions } from '../orchestrator/WorkerTimeoutGuard.js';
import type { Story } from '../types.js';

// ─── 1. ClaudeCodeWorker.parseStreamLine routing unit tests ──────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
class TestableClaudeWorker extends ClaudeCodeWorker {
  exposeParseStreamLine(line: string) {
    return (this as any).parseStreamLine(line);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('ClaudeCodeWorker — parseStreamLine guard signal routing (epic-030)', () => {
  it('system/status requesting emits guardSignal { kind: requesting }', () => {
    const w = new TestableClaudeWorker();
    const parsed = w.exposeParseStreamLine(
      '{"type":"system","subtype":"status","status":"requesting"}'
    );
    assert.deepEqual(parsed.guardSignal, { kind: 'requesting' });
  });

  it('system/status idle (non-requesting) emits no guardSignal', () => {
    const w = new TestableClaudeWorker();
    const parsed = w.exposeParseStreamLine(
      '{"type":"system","subtype":"status","status":"idle"}'
    );
    assert.equal(parsed.guardSignal, undefined);
  });

  it('assistant event emits guardSignal { kind: stream_event, label: assistant/delta }', () => {
    const w = new TestableClaudeWorker();
    const parsed = w.exposeParseStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      })
    );
    assert.deepEqual(parsed.guardSignal, { kind: 'stream_event', label: 'assistant/delta' });
  });

  it('result event emits guardSignal { kind: stream_event, label: result }', () => {
    const w = new TestableClaudeWorker();
    const parsed = w.exposeParseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', result: '', num_turns: 1 })
    );
    assert.deepEqual(parsed.guardSignal, { kind: 'stream_event', label: 'result' });
  });

  it('system/init event emits guardSignal { kind: stream_event, label: system/init }', () => {
    const w = new TestableClaudeWorker();
    const parsed = w.exposeParseStreamLine(
      '{"type":"system","subtype":"init","model":"claude-opus-4-8"}'
    );
    assert.deepEqual(parsed.guardSignal, { kind: 'stream_event', label: 'system/init' });
  });

  it('user replay with text emits guardSignal { kind: stream_event, label: user/replay }', () => {
    const w = new TestableClaudeWorker();
    const parsed = w.exposeParseStreamLine(
      JSON.stringify({ type: 'user', message: { content: 'operator note' } })
    );
    assert.deepEqual(parsed.guardSignal, { kind: 'stream_event', label: 'user/replay' });
  });

  it('user replay without content emits no guardSignal (falls through to empty)', () => {
    const w = new TestableClaudeWorker();
    const parsed = w.exposeParseStreamLine(
      '{"type":"user","message":{}}'
    );
    assert.equal(parsed.guardSignal, undefined);
    assert.deepEqual(parsed, {});
  });

  it('stream_event partial delta emits no guardSignal (raw bytes handle liveness)', () => {
    const w = new TestableClaudeWorker();
    const parsed = w.exposeParseStreamLine(
      '{"type":"stream_event","event":{"type":"content_block_delta"}}'
    );
    assert.equal(parsed.guardSignal, undefined);
    assert.deepEqual(parsed, {});
  });
});

// ─── 2. Integration tests: BaseCliWorker processLines / guard arm-disarm ─────

/** A controllable child that mimics the surface `spawnAgent` touches. */
class FakeChild extends EventEmitter {
  pid = 9999;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private _stdinEnded = false;
  stdin: { write(s: string): boolean; end(): void; readonly writableEnded: boolean };

  constructor() {
    super();
    const self = this;
    this.stdin = {
      write: () => true,
      end() { self._stdinEnded = true; },
      get writableEnded() { return self._stdinEnded; },
    };
  }
  emitStdout(s: string): void { this.stdout.emit('data', Buffer.from(s)); }
  close(code: number | null): void { this.emit('close', code); }
}

const NS_PER_MS = 1_000_000n;

/**
 * A worker subclass that:
 *  - spawns a FakeChild (no real CLI process)
 *  - injects a fake clock + controllable poll into the WorkerTimeoutGuard
 *  - exposes `guardTick()` / `advanceGuard(ms)` for test control
 *  - injects a fake RetryController so no real backoff sleeps
 */
abstract class ControllableWorker extends ClaudeCodeWorker {
  lastChild?: FakeChild;
  killCount = 0;
  private pollFn: (() => void) | null = null;
  protected gWallMs = 1_000_000_000;
  protected gMonoNs = 5_000_000_000n;

  guardTick(): void { this.pollFn?.(); }
  advanceGuard(ms: number): void {
    this.gWallMs += ms;
    this.gMonoNs += BigInt(ms) * NS_PER_MS;
  }

  protected binary(): string { return 'cursor-agent'; }
  protected agentArgs(): string[] { return []; }

  protected createGuard(opts: WorkerTimeoutGuardOptions): WorkerTimeoutGuard {
    return new WorkerTimeoutGuard({
      ...opts,
      pollMs: 5_000,
      warnMs: 0,
      now: () => this.gWallMs,
      monotonicNow: () => this.gMonoNs,
      setInterval: (fn: () => void) => { this.pollFn = fn; return 'poll'; },
      clearInterval: () => { this.pollFn = null; },
      setTimeout: () => 'grace',
      clearTimeout: () => undefined,
      killProcess: () => { this.killCount += 1; },
    });
  }

  protected spawnChild(_bin: string, _args: string[], _opts: SpawnOptions): ChildProcessWithoutNullStreams {
    const child = new FakeChild();
    this.lastChild = child;
    this.setupChild(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  }

  /** Subclasses drive the child's lifecycle here. */
  protected abstract setupChild(child: FakeChild): void;
}

// ─── git helper ──────────────────────────────────────────────────────────────

function gitc(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const STORY: Story = {
  id: 'story-030-002',
  title: 'Hung model-request detection',
  description: 'integration test story',
  acceptance_criteria: ['works'],
  estimated_complexity: 'medium',
  dependencies: [],
};

function makeRepo(): { repoDir: string; baseSha: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-slow-streaming-'));
  gitc(['init', '-q'], repoDir);
  gitc(['config', 'user.email', 'test@loom.dev'], repoDir);
  gitc(['config', 'user.name', 'Loom Test'], repoDir);
  gitc(['config', 'commit.gpgsign', 'false'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# base\n');
  gitc(['add', '.'], repoDir);
  gitc(['commit', '-q', '-m', 'initial'], repoDir);
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  gitc(['checkout', '-q', '-b', 'story/story-030-002'], repoDir);
  return { repoDir, baseSha };
}

function makeAssignment(repoDir: string, baseSha: string): WorkerAssignment {
  return {
    storyId: STORY.id,
    epicId: 'epic-030',
    story: STORY,
    worktreePath: repoDir,
    branchName: 'story/story-030-002',
    baseSha,
    projectRoot: repoDir,
    skills: [],
    stallMs: 60_000,
    absoluteCapMs: 600_000,
  };
}

describe('BaseCliWorker — same-buffer race and requesting→silence integration (epic-030)', () => {
  let repoDir: string;
  let baseSha: string;

  beforeEach(() => {
    const r = makeRepo();
    repoDir = r.repoDir;
    baseSha = r.baseSha;
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('SAME-BUFFER RACE: requesting + delta in one chunk ends disarmed (ADR-002 recordActivity-first invariant)', async () => {
    // A single stdout chunk contains the requesting status line followed
    // immediately by an assistant content line. After:
    //   1. recordActivity() (from the data handler) — disarms
    //   2. processLines() — requesting line re-arms, then delta disarms again
    // The budget must end DISARMED so no hung kill fires.
    let guardArmedAfterChunk: boolean | null = null;

    class SameBufferWorker extends ControllableWorker {
      protected setupChild(child: FakeChild): void {
        queueMicrotask(() => {
          // Emit ONE chunk with requesting + assistant delta concatenated.
          const requestingLine = JSON.stringify({
            type: 'system', subtype: 'status', status: 'requesting',
          });
          const deltaLine = JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'hello' }] },
          });
          child.emitStdout(requestingLine + '\n' + deltaLine + '\n');

          // Tick the guard: advance past the hung-request bound (45s) and check.
          this.advanceGuard(50_000);
          this.guardTick();
          // Capture whether a kill was scheduled.
          guardArmedAfterChunk = this.killCount > 0;

          // Worker completes cleanly.
          child.close(0);
        });
      }
    }

    const worker = new SameBufferWorker({
      hungRequestMs: 45_000,
      stallMs: 60_000,
      absoluteCapMs: 0,
      openPr: false,
    });
    await worker.run(makeAssignment(repoDir, baseSha));
    assert.equal(
      guardArmedAfterChunk,
      false,
      'budget is DISARMED after same-buffer requesting+delta — no hung kill'
    );
    assert.equal(worker.killCount, 0, 'no kill fires');
  });

  it('REQUESTING-THEN-SILENCE: armed by status line, killed after hungRequestMs elapses', async () => {
    // The worker emits a requesting status line, then goes silent. After the
    // hung-request bound elapses the guard fires a 'hung_request' kill.
    let resultKillReason: string | undefined;

    class RequestingThenSilentWorker extends ControllableWorker {
      protected setupChild(child: FakeChild): void {
        queueMicrotask(() => {
          // Emit the requesting status line.
          child.emitStdout(
            JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }) + '\n'
          );
          // Advance past the hung-request bound and tick — this should kill.
          this.advanceGuard(50_000);
          this.guardTick();
          // Guard kill is async from the child's perspective: the SIGTERM fires,
          // but we simulate the child closing after the kill.
          child.close(null);
        });
      }
    }

    const worker = new RequestingThenSilentWorker({
      hungRequestMs: 45_000,
      stallMs: 12 * 60_000,
      absoluteCapMs: 0,
      openPr: false,
    });
    const result = await worker.run(makeAssignment(repoDir, baseSha));
    resultKillReason = result.killReason;
    // The worker should have been killed (timedOut) with 'hung_request' reason.
    assert.equal(
      worker.killCount >= 1,
      true,
      'guard sent a kill signal'
    );
    // WorkerResult should carry the killReason from the guard.
    assert.equal(resultKillReason, 'hung_request', 'result.killReason is hung_request');
    assert.equal(
      result.lastStreamEvent,
      'system/status:requesting',
      'result.lastStreamEvent identifies where the worker was stuck'
    );
  });

  it('SLOW-BUT-STREAMING integration: streaming worker never killed before stall deadline', async () => {
    // Worker emits requesting, then keeps streaming (assistant delta events).
    // The hung-request budget stays disarmed the whole time so no early kill.
    // Worker exits cleanly, so result is done.
    class SlowButStreamingWorker extends ControllableWorker {
      protected setupChild(child: FakeChild): void {
        queueMicrotask(async () => {
          child.emitStdout(
            JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }) + '\n'
          );
          // Before the hung bound (45s), emit a content delta — disarms budget.
          this.advanceGuard(20_000);
          child.emitStdout(
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'thinking...' }] },
            }) + '\n'
          );
          // Tick guard after the delta — budget is now disarmed.
          this.advanceGuard(30_000); // total 50s > 45s hung bound, but disarmed
          this.guardTick();
          // Worker completes normally.
          child.close(0);
        });
      }
    }

    const worker = new SlowButStreamingWorker({
      hungRequestMs: 45_000,
      stallMs: 60_000,
      absoluteCapMs: 0,
      openPr: false,
    });
    const result = await worker.run(makeAssignment(repoDir, baseSha));
    assert.equal(worker.killCount, 0, 'streaming worker is never killed by hung-request path');
    assert.equal(result.status, 'done', 'slow-but-streaming worker completes successfully');
    assert.equal(result.killReason, undefined, 'no killReason on successful completion');
  });
});
