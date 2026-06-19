/**
 * Shared test utilities used across multiple integration test files.
 */

export function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
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
