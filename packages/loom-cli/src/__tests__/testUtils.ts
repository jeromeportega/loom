/**
 * Shared test utilities used across multiple integration test files.
 */

export function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

export interface Captured {
  exitCode: number | null;
  logs: string[];
  errors: string[];
}

/**
 * Runs `fn`, capturing process.exit, console.log, and console.error.
 * NOT concurrency-safe: mutates global process/console state without any lock.
 * Tests using this helper must run with --test-concurrency=1 (the Node test
 * runner default) to avoid interleaved capture calls corrupting each other's
 * exit code and log state.
 */
export async function capture(fn: () => Promise<void> | void): Promise<Captured> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    await fn();
    // Detect process.exitCode = N; return (does not throw)
    if (exitCode === null && process.exitCode !== undefined && process.exitCode !== null) {
      exitCode = process.exitCode as number;
    }
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
  }
  return { exitCode, logs, errors };
}

export async function runInProcess(fn: () => Promise<void>): Promise<{ exitCode: number | null }> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = () => {};
  console.error = () => {};
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) {
      console.error = origErr;
      throw err;
    }
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { exitCode };
}
