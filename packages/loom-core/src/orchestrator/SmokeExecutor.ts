import { spawn } from 'node:child_process';
import type { CommandRunner, CommandResult } from './IntegrationGate.js';

export type { CommandRunner };

export interface SmokeResult {
  command:         string;
  exitCode:        number;
  durationSeconds: number;
  timeoutKilled:   boolean;
  output:          string;
}

export interface SmokeRunOptions {
  command:        string;
  worktreeCwd:    string;          // merged worktree path — NOT process.cwd()
  timeoutMinutes: number;          // from policy.agents.smoke_timeout_minutes
  runner?:        CommandRunner;   // injectable for tests; production default below
}

const smokeDefaultRunner: CommandRunner = (cmd, cwd, timeoutMs) =>
  new Promise<CommandResult>((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, {
      shell:    true,
      cwd,
      detached: true,
      env:      process.env,
      stdio:    'pipe',
    });

    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));

    const pid = child.pid;
    let timedOut = false;

    const deadline = setTimeout(() => {
      if (pid !== undefined) {
        timedOut = true;
        try {
          // Unix only: kills the entire process group so no child processes survive.
          // On Windows this throws EINVAL; the fallback kills the shell only (best-effort).
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      // pid undefined: no kill sent; timedOut stays false to avoid misreporting
    }, timeoutMs);

    child.on('error', (err: Error) => {
      clearTimeout(deadline);
      resolve({
        exitCode:  null,
        output:    err.message,
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    child.on('close', (code) => {
      clearTimeout(deadline);
      resolve({
        exitCode:  code,
        output:    Buffer.concat(chunks).toString(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });

/**
 * Runs the smoke command in worktreeCwd with a new process group.
 * Sends SIGKILL to the entire process group on timeout.
 * Never throws — callers inspect exitCode and timeoutKilled.
 */
export async function runSmoke(opts: SmokeRunOptions): Promise<SmokeResult> {
  const { command, worktreeCwd, timeoutMinutes } = opts;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const started = Date.now();

  try {
    const runner = opts.runner ?? smokeDefaultRunner;
    const result = await runner(command, worktreeCwd, timeoutMs);
    return {
      command,
      exitCode:        result.exitCode ?? 1,
      durationSeconds: result.durationMs / 1000,
      timeoutKilled:   result.timedOut,
      output:          result.output,
    };
  } catch {
    return {
      command,
      exitCode:        1,
      durationSeconds: (Date.now() - started) / 1000,
      timeoutKilled:   false,
      output:          '',
    };
  }
}
