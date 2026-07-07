import { spawn } from 'node:child_process';
import type { CommandRunner, CommandResult } from './IntegrationGate.js';

export type { CommandRunner };

export interface SmokeResult {
  command:         string;
  exitCode:        number;
  durationSeconds: number;
  timeoutKilled:   boolean;
}

export interface SmokeRunOptions {
  command:        string;
  worktreeCwd:    string;
  timeoutMinutes: number;
  runner?:        CommandRunner;
}

const smokeDefaultRunner: CommandRunner = (cmd, cwd, timeoutMs) =>
  new Promise<CommandResult>((resolve) => {
    const started = Date.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        shell:    true,
        cwd,
        detached: true,
        env:      process.env,
        stdio:    'pipe',
      });
    } catch (err) {
      resolve({
        exitCode:  null,
        output:    (err as Error).message ?? String(err),
        timedOut:  false,
        durationMs: Date.now() - started,
      });
      return;
    }

    child.stdout?.resume();
    child.stderr?.resume();

    const pid = child.pid;
    let timedOut = false;

    const deadline = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(deadline);
      resolve({
        exitCode:  null,
        output:    '',
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    child.on('close', (code) => {
      clearTimeout(deadline);
      resolve({
        exitCode:  code,
        output:    '',
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
    };
  } catch {
    return {
      command,
      exitCode:        1,
      durationSeconds: (Date.now() - started) / 1000,
      timeoutKilled:   false,
    };
  }
}
