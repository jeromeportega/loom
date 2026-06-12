import type { AgentStore } from '../state/AgentStore.js';
import type { AuditLog } from '../state/AuditLog.js';

/**
 * Mirror of the stream-json trace shape the supervisor receives from
 * worker backends. We only need kind + subject for the watchdog — the
 * supervisor wraps onTrace in such a way that both the DB write AND
 * the watchdog update happen on the same call.
 */
export interface WatchdogTrace {
  kind: string;
  subject?: string;
}

export interface WorkerWatchdogOptions {
  agentId: string;
  storyId: string;
  agentStore: AgentStore;
  audit: AuditLog;
  /**
   * Seconds after worker start with zero edit-class tool calls
   * (Edit / Write / MultiEdit) before the watchdog emits a warning
   * audit row. 0 disables the warn step (kill is still active).
   * Recommended default: 600 (10 min).
   */
  warnSec: number;
  /**
   * Seconds after worker start with zero edit-class tool calls before
   * the watchdog SIGTERMs the worker and marks the story failed with
   * reason `analysis-only-watchdog`. 0 disables the kill (only warns).
   * Recommended default: 1200 (20 min).
   */
  killSec: number;
  /** Polling interval in ms — defaults to 30_000 (30s). */
  pollMs?: number;
  /** Time-source override for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Process-kill override for tests. Defaults to process.kill. Called
   * with (pid, 'SIGTERM') exactly like process.kill.
   */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Timer override for tests — accepts the same shape as setInterval.
   * Defaults to setInterval.
   */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * Catches the analysis-only failure mode in flight. Workers stuck in
 * extensive investigation (Bash/Read/Grep loops) but never editing
 * code burn session capacity and produce empty patches. The watchdog
 * monitors the live decision-trace stream for edit-class calls; if
 * zero by `warnSec` it logs an audit entry, and if zero by `killSec`
 * it SIGTERMs the worker subprocess.
 *
 * Default behavior in loom is OFF (policy.agents.analysis_only_watchdog
 * defaults to 'off'). Operators turn it on per repo. The flag stays off
 * for bench runs by default so the baseline measurement is preserved —
 * turning it on for a bench is a deliberate intervention that needs its
 * own Gate 3 measurement.
 *
 * Lifecycle:
 *   1. `start()` — installs the polling timer
 *   2. `onTrace(trace)` — wired into the supervisor's onTrace; counts
 *      edits as they stream
 *   3. `stop()` — clears the timer (call in a finally block when the
 *      worker.run promise resolves)
 *
 * The watchdog does not alter what the worker SEES — only what the
 * supervisor does on its behalf if the worker stalls. Methodology-safe:
 * doesn't modify the prompt; only acts on an unambiguous failure signal.
 */
export class WorkerWatchdog {
  private editCount = 0;
  private readonly startMs: number;
  private timerHandle: unknown;
  private warned = false;
  private killed = false;

  constructor(private readonly opts: WorkerWatchdogOptions) {
    this.startMs = (opts.now ?? Date.now)();
  }

  /** Wire into the supervisor's onTrace pipeline. Idempotent + cheap. */
  onTrace(trace: WatchdogTrace): void {
    if (trace.kind === 'tool_intent' && EDIT_TOOLS.has(trace.subject ?? '')) {
      this.editCount += 1;
    }
  }

  /** Live counter — primarily for tests. */
  get editsSeen(): number {
    return this.editCount;
  }

  /** Start the polling timer. */
  start(): void {
    const interval = this.opts.setInterval ?? setInterval;
    this.timerHandle = interval(() => this.check(), this.opts.pollMs ?? 30_000);
  }

  /** Stop the polling timer. Safe to call multiple times. */
  stop(): void {
    if (this.timerHandle !== undefined) {
      if (this.opts.clearInterval) {
        this.opts.clearInterval(this.timerHandle);
      } else {
        clearInterval(this.timerHandle as NodeJS.Timeout);
      }
      this.timerHandle = undefined;
    }
  }

  /**
   * Public for tests. The polling timer drives this in production.
   * Returns the action taken on this check so tests can assert.
   */
  check(): 'noop' | 'warn' | 'kill' {
    if (this.killed) return 'noop';
    if (this.editCount > 0) return 'noop';

    const now = (this.opts.now ?? Date.now)();
    const elapsedSec = (now - this.startMs) / 1000;

    if (
      !this.warned &&
      this.opts.warnSec > 0 &&
      elapsedSec >= this.opts.warnSec
    ) {
      this.warned = true;
      this.opts.audit.record({
        agent_id: this.opts.agentId,
        action: 'worker_watchdog_warn',
        command: this.opts.storyId,
        allowed: true,
        detail: {
          reason: 'analysis-only',
          elapsed_sec: Math.round(elapsedSec),
          edit_count: 0,
        },
      });
    }

    if (this.opts.killSec > 0 && elapsedSec >= this.opts.killSec) {
      this.executeKill(elapsedSec);
      return 'kill';
    }
    return this.warned ? 'warn' : 'noop';
  }

  private executeKill(elapsedSec: number): void {
    this.killed = true;
    const agent = this.opts.agentStore.get(this.opts.agentId);
    const pid = agent?.worker_pid;
    if (!pid) {
      this.opts.audit.record({
        agent_id: this.opts.agentId,
        action: 'worker_watchdog_kill_skip',
        command: this.opts.storyId,
        allowed: false,
        detail: {
          reason: 'no_worker_pid',
          elapsed_sec: Math.round(elapsedSec),
        },
      });
      this.stop();
      return;
    }
    try {
      (this.opts.killProcess ?? process.kill)(pid, 'SIGTERM');
      this.opts.audit.record({
        agent_id: this.opts.agentId,
        action: 'worker_watchdog_kill',
        command: this.opts.storyId,
        allowed: true,
        detail: {
          reason: 'analysis-only',
          pid,
          elapsed_sec: Math.round(elapsedSec),
          edit_count: 0,
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === 'ESRCH' ? 'worker already exited' : (err as Error).message;
      this.opts.audit.record({
        agent_id: this.opts.agentId,
        action: 'worker_watchdog_kill_failed',
        command: this.opts.storyId,
        allowed: false,
        detail: { reason: msg, pid, elapsed_sec: Math.round(elapsedSec) },
      });
    } finally {
      this.stop();
    }
  }
}
