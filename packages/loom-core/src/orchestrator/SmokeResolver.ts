import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Policy } from '../types.js';

/**
 * Returns the effective smoke command string, or null when the smoke step
 * should be skipped entirely.
 *
 * Resolution order:
 *   1. policy.agents.smoke_command (when defined and non-empty)
 *   2. package.json scripts.smoke  → "npm run smoke"
 *   3. package.json scripts.verify → "npm run verify"
 *   4. null
 *
 * Never throws. Returns null on any filesystem error reading package.json.
 */
export async function resolveSmokeCommand(
  projectRoot: string,
  policy: Policy,
): Promise<string | null> {
  if (policy.agents.smoke_command) {
    return policy.agents.smoke_command;
  }

  let pkg: unknown;
  try {
    const raw = await readFile(path.join(projectRoot, 'package.json'), 'utf8');
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof pkg === 'object' &&
    pkg !== null &&
    'scripts' in pkg &&
    typeof (pkg as Record<string, unknown>).scripts === 'object' &&
    (pkg as Record<string, unknown>).scripts !== null
  ) {
    const scripts = (pkg as Record<string, unknown>).scripts as Record<string, unknown>;
    if ('smoke' in scripts) {
      return 'npm run smoke';
    }
    if ('verify' in scripts) {
      return 'npm run verify';
    }
  }

  return null;
}
