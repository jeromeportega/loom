import { PolicyValidationError } from '@loom-ai/core';

// Only PolicyValidationError gets a clean exit; everything else rethrows with its
// stack intact so a loom bug surfaces as an unhandled rejection (Philosophy #3 / ADR-1).
export function handleTopLevelError(err: unknown): never {
  if (err instanceof PolicyValidationError) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }
  throw err;
}
