import fs from 'node:fs';
import path from 'node:path';
import {
  openDatabase,
  EpicStore,
  AuditLog,
  AutonomyLevelSchema,
  setEpicAutonomy,
  EpicNotFoundError,
} from '@loom-ai/core';

export interface AutonomyOptions {
  json?: boolean;
}

/**
 * `loom autonomy <epic-id> [level]` — set the autonomy level for an epic
 * (full-auto | checkpoint | manual). Omit `level` to print the current value.
 */
export function runAutonomy(epicId: string, level: string | undefined, opts: AutonomyOptions = {}): void {
  const loomDir = path.join(process.cwd(), '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openDatabase(loomDir);
  const epicStore = new EpicStore(db);

  // Read mode: no level supplied.
  if (level === undefined) {
    if (!epicStore.get(epicId)) {
      console.error(`Epic "${epicId}" not found.`);
      process.exit(1);
      return;
    }
    const current = epicStore.getAutonomy(epicId);
    if (opts.json) {
      console.log(JSON.stringify({ id: epicId, autonomy_level: current }, null, 2));
      return;
    }
    console.log(`  ${epicId} — autonomy: ${current}`);
    return;
  }

  // Set mode.
  const parsed = AutonomyLevelSchema.safeParse(level);
  if (!parsed.success) {
    console.error('invalid level; must be one of: full-auto, checkpoint, manual');
    process.exit(1);
    return;
  }

  try {
    const result = setEpicAutonomy({ epicStore, auditLog: new AuditLog(db) }, epicId, parsed.data, 'cli');
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`  ${result.id} — autonomy set to ${result.autonomy_level}`);
  } catch (err) {
    if (err instanceof EpicNotFoundError) {
      console.error(err.message);
      process.exit(1);
      return;
    }
    throw err;
  }
}
