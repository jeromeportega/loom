import os from 'node:os';
import path from 'node:path';

/**
 * The machine-level loom directory — `~/.loom` by default, overridable with
 * the `LOOM_HOME` environment variable. The override keeps the project
 * registry, machine config, and global limiter out of a developer's real
 * `~/.loom` during tests, and lets a machine relocate loom state if needed.
 */
export function loomHome(): string {
  const override = process.env.LOOM_HOME;
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), '.loom');
}
