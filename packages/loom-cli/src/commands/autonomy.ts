import type { CommandDescription, PositionalArg } from '../describe/schema.js';
import { renderValueMeanings } from '../describe/helpSupplement.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  EpicStore,
  AuditLog,
  AutonomyLevelSchema,
  setEpicAutonomy,
  EpicNotFoundError,
} from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface AutonomyOptions {
  json?: boolean;
}

const levelArg: PositionalArg = {
  name: 'level',
  type: 'enum',
  required: false,
  description: 'Autonomy level to set; omit to show the current value',
  values: ['full-auto', 'checkpoint', 'manual'],
  valueMeanings: {
    'full-auto': 'run continuously without pausing',
    'checkpoint': 'pause after each story for review',
    'manual': 'require explicit approval at each step',
  },
};

/**
 * `loom autonomy <epic-id> [level]` — set the autonomy level for an epic
 * (full-auto | checkpoint | manual). Omit `level` to print the current value.
 */
export function runAutonomy(epicId: string, level: string | undefined, opts: AutonomyOptions = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
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
    const meanings = renderValueMeanings(levelArg);
    if (meanings) console.log(meanings);
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

export const spec: CommandDescription = {
  name: 'autonomy',
  summary: 'Set or show the autonomy level for an epic',
  whenToUse: 'Use to control how much human oversight the supervisor applies: full-auto runs continuously, checkpoint pauses after each story, manual requires explicit approval at each step.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic id (e.g. epic-001)' },
    levelArg,
  ],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit JSON: { id, autonomy_level }', changesOutputShape: true },
  ],
  output: {
    text: 'Current or updated autonomy level for the epic',
    json: { supported: true, shape: '{ id: string, autonomy_level: string }' },
  },
  examples: [
    { command: 'loom autonomy epic-001', description: 'Show the current autonomy level for epic-001' },
    { command: 'loom autonomy epic-001 checkpoint', description: 'Set epic-001 to pause after each story' },
    { command: 'loom autonomy epic-001 full-auto --json', description: 'Set full-auto and emit JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Level shown or updated successfully' },
    { code: 1, meaning: 'Epic not found, invalid level, or loom not initialized' },
  ],
  errors: ['Epic not found', 'Invalid autonomy level — must be full-auto, checkpoint, or manual', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['approve'], nextSteps: ['run', 'status'] },
};
