import fs from 'node:fs';
import path from 'node:path';
import { loomHome } from './paths.js';

/** Machine-level loom settings, read from `~/.loom/config.json`. */
export interface MachineConfig {
  /**
   * Cap on worker agents running concurrently across *every* loom run on the
   * machine. Unset = no global cap (each run is bounded only by its own
   * policy.agents.max_concurrent).
   */
  maxGlobalWorkers?: number;
}

/** The default machine-config location: `<loomHome>/config.json`. */
export function defaultMachineConfigPath(): string {
  return path.join(loomHome(), 'config.json');
}

/**
 * Loads the machine-level config. A missing, unreadable, or malformed file
 * yields an empty config — machine config is always optional.
 */
export function loadMachineConfig(configPath = defaultMachineConfigPath()): MachineConfig {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const config: MachineConfig = {};
    const cap = parsed.max_global_workers;
    if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) {
      config.maxGlobalWorkers = Math.floor(cap);
    }
    return config;
  } catch {
    return {};
  }
}
