import { spawn } from 'node:child_process';
import { resolveGateCommand } from './GatePreflight.js';

/**
 * The integration gate is the objective answer to "is this epic actually
 * broken?" — run AFTER the EpicFinalizer merges every story branch onto
 * `epic/<id>`, on the integrated tree, before the PR opens.
 *
 * It catches the two ways an epic ships broken that the per-story checks miss:
 *
 *   1. **Amputation** — a story failed to merge (conflict) and was dropped, so
 *      the epic is missing work. This is free to detect (the finalizer already
 *      knows the conflicted set) and needs no command.
 *   2. **Cross-story regression** — every story passed its OWN tests in its OWN
 *      worktree, but the integrated whole does not build / its suite fails.
 *      Only running the suite on the merged tree surfaces this.
 *
 * Methodology note (mirrors WorkerTimeoutGuard): the command runner, the clock,
 * and the filesystem probes are injectable so the logic is unit-testable
 * without spawning a real process or touching disk.
 */
export type GateMode = 'off' | 'warn' | 'block';

export interface CommandResult {
  /** Process exit code, or null if it was killed / never produced one. */
  exitCode: number | null;
  /** Combined stdout + stderr, tail-truncated. */
  output: string;
  /** True when the command exceeded its timeout and was killed. */
  timedOut: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export type CommandRunner = (
  command: string,
  opts: { cwd: string; timeoutMs: number }
) => CommandResult | Promise<CommandResult>;

export interface IntegrationGateOptions {
  /**
   * Explicit command from `policy.agents.test_command`. When set it always
   * wins over auto-detection. Deliberately runs only this command — loom never
   * auto-`npm install`s, so a repo whose tests need a fresh install must encode
   * that here (e.g. "npm ci && npm test").
   */
  testCommand?: string;
  /** Wall-clock bound for the gate command. Default 15 minutes. */
  timeoutMs?: number;
  /** Injectable command runner. Defaults to a spawnSync shell runner. */
  runner?: CommandRunner;
  /** Injectable file existence probe (for command auto-detection). */
  fileExists?: (p: string) => boolean;
  /** Injectable file reader (for command auto-detection). Returns null if unreadable. */
  fileReader?: (p: string) => string | null;
}

export interface GateOutcome {
  /** Whether the integrated epic is healthy (no amputation AND tests pass / none ran). */
  ok: boolean;
  /** Whether a build/test command actually ran. */
  ran: boolean;
  /** The resolved command, when one was found. */
  command?: string;
  exitCode?: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Tail of the command output (for the audit row + PR annotation). */
  output: string;
  /** Story ids missing from the integrated branch (dropped merge conflicts). */
  amputated: string[];
  /** Human-readable one-liner for the audit log, PR body, and status views. */
  summary: string;
}

const OUTPUT_TAIL_BYTES = 8_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const KILL_GRACE_MS = 5_000;

/**
 * Default runner: a non-blocking shell subprocess with a hard timeout and
 * tail-captured output. Deliberately async (uses `spawn`, not `spawnSync`):
 * the gate runs at epic finalization, and a synchronous suite would freeze the
 * Node.js event loop for the whole timeout — making a long-lived MCP server
 * unresponsive to concurrent tool calls (status, policy checks) for minutes.
 *
 * The child is its own process-group leader (`detached`) so the timeout kill
 * reaps grandchildren (the test runner the suite launches), with a
 * SIGTERM→SIGKILL escalation so a child that ignores SIGTERM can't hang us.
 */
const defaultRunner: CommandRunner = (command, { cwd, timeoutMs }) =>
  new Promise<CommandResult>((resolve) => {
    const started = Date.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { cwd, shell: true, detached: true });
    } catch (err) {
      resolve({
        exitCode: null,
        output: (err as Error).message ?? String(err),
        timedOut: false,
        durationMs: Date.now() - started,
      });
      return;
    }

    let buf = '';
    const append = (d: Buffer): void => {
      buf += d.toString();
      // Keep roughly twice the tail so the final slice is stable.
      if (buf.length > OUTPUT_TAIL_BYTES * 2) buf = buf.slice(-OUTPUT_TAIL_BYTES * 2);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const pid = child.pid;
    const signalGroup = (sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          // Already gone — nothing to do.
        }
      }
    };

    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (code: number | null): void => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      const output = buf.length > OUTPUT_TAIL_BYTES ? buf.slice(-OUTPUT_TAIL_BYTES) : buf;
      resolve({ exitCode: code, output, timedOut, durationMs: Date.now() - started });
    };

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });

export class IntegrationGate {
  constructor(private readonly opts: IntegrationGateOptions = {}) {}

  /**
   * Evaluate the integrated epic. `conflicted` is the finalizer's set of
   * stories that failed to merge (the amputation signal). Runs the resolved
   * test command on `projectRoot`, which the finalizer has already checked out
   * to the merged `epic/<id>`.
   */
  async run(input: { projectRoot: string; conflicted?: string[] }): Promise<GateOutcome> {
    const amputated = input.conflicted ?? [];
    // Resolved command + cwd, delegated to GatePreflight so the gate and the
    // preflight surfaces resolve identically by construction (ADR-2). When
    // `policy.agents.test_command` is set, the operator's word is law: run it
    // from projectRoot (their command is expected to encode any `cd <subdir>`
    // it needs). When unset, auto-detection scopes to the smallest changed
    // subdirectory with its own test config (monorepo scoping).
    const resolved = resolveGateCommand(input.projectRoot, {
      testCommand: this.opts.testCommand,
      fileExists: this.opts.fileExists,
      fileReader: this.opts.fileReader,
    });
    const command = resolved.command;
    const cwd = resolved.cwd;

    // No command resolvable: we cannot test, so don't manufacture a failure —
    // fall back to the (free) amputation check only. This keeps the default
    // `warn` mode safe in repos with no detectable suite.
    if (!command) {
      const ok = amputated.length === 0;
      return {
        ok,
        ran: false,
        timedOut: false,
        durationMs: 0,
        output: '',
        amputated,
        summary: ok
          ? 'No test command found; amputation check only — all stories merged.'
          : `No test command found; ${amputated.length} story(ies) missing from the epic: ${amputated.join(', ')}.`,
      };
    }

    const runner = this.opts.runner ?? defaultRunner;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const res = await runner(command, { cwd, timeoutMs });
    const testsPassed = !res.timedOut && res.exitCode === 0;
    const ok = amputated.length === 0 && testsPassed;

    const parts: string[] = [];
    if (amputated.length > 0) {
      parts.push(`${amputated.length} story(ies) missing from the epic (${amputated.join(', ')})`);
    }
    if (res.timedOut) {
      parts.push(`\`${command}\` timed out after ${Math.round(res.durationMs / 1000)}s`);
    } else if (res.exitCode !== 0) {
      parts.push(`\`${command}\` failed (exit ${res.exitCode})`);
    } else {
      parts.push(`\`${command}\` passed in ${Math.round(res.durationMs / 1000)}s`);
    }

    return {
      ok,
      ran: true,
      command,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      output: res.output,
      amputated,
      summary: `${ok ? 'Integration gate passed' : 'Integration gate failed'}: ${parts.join('; ')}.`,
    };
  }
}
