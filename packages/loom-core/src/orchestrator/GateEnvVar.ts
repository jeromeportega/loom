import type { EnvVarFinding } from './FinalizeGates.js';

/**
 * Stub — story-077-003 replaces this file entirely with the real implementation.
 * Pass null when .env.example is absent; gate returns [] and emits no findings.
 */
export function checkUndocumentedEnvVars(_opts: {
  epicDiff: string;
  envExampleVars: Set<string> | null;
}): EnvVarFinding[] {
  return [];
}
