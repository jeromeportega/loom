import fs from 'node:fs';
import path from 'node:path';
import { loomHome } from './paths.js';

/** One loom-initialized repo, as recorded in the machine-level registry. */
export interface ProjectEntry {
  /** Absolute path to the repo root. */
  root: string;
  /** ISO timestamp of when `loom init` registered it. */
  registeredAt: string;
}

/** The default registry location: `<loomHome>/projects.json`. */
export function defaultRegistryPath(): string {
  return path.join(loomHome(), 'projects.json');
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A machine-level registry of loom-initialized repos. `loom init` records a
 * repo here; `loom status --all` reads it to aggregate across every project.
 *
 * Reads self-heal: a registered directory that no longer exists is pruned from
 * the file rather than treated as fatal.
 */
export class ProjectRegistry {
  private readonly file: string;

  constructor(opts: { path?: string } = {}) {
    this.file = opts.path ?? defaultRegistryPath();
  }

  /** Records a repo root (absolute, deduplicated). Idempotent. */
  register(root: string): void {
    const abs = path.resolve(root);
    const entries = this.readRaw();
    if (entries.some((e) => e.root === abs)) return;
    entries.push({ root: abs, registeredAt: new Date().toISOString() });
    this.write(entries);
  }

  /** Removes a repo root from the registry, if present. */
  unregister(root: string): void {
    const abs = path.resolve(root);
    const entries = this.readRaw();
    const kept = entries.filter((e) => e.root !== abs);
    if (kept.length !== entries.length) this.write(kept);
  }

  /**
   * Registered projects whose directory still exists. Vanished directories are
   * pruned from the file as a side effect, so the registry self-heals.
   */
  list(): ProjectEntry[] {
    const entries = this.readRaw();
    const existing = entries.filter((e) => directoryExists(e.root));
    if (existing.length !== entries.length) this.write(existing);
    return existing;
  }

  private readRaw(): ProjectEntry[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      const list = (parsed as { projects?: unknown }).projects;
      if (!Array.isArray(list)) return [];
      return list
        .filter(
          (e): e is ProjectEntry =>
            !!e && typeof (e as ProjectEntry).root === 'string'
        )
        .map((e) => ({ root: e.root, registeredAt: e.registeredAt ?? '' }));
    } catch {
      // A corrupt registry must not be fatal — treat it as empty.
      return [];
    }
  }

  private write(entries: ProjectEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ projects: entries }, null, 2) + '\n'
    );
  }
}
