import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { EpicStore, AuditLog } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

/**
 * `loom archive <epic-id>` hides a run from the default `loom status`, web
 * dashboard, and MCP views (and skips it in supervisor selection) without
 * deleting anything. `loom unarchive <epic-id>` brings it back. Both are
 * audit-logged.
 */
export function runArchive(epicId: string): void {
  mutate(epicId, true);
}

export function runUnarchive(epicId: string): void {
  mutate(epicId, false);
}

function mutate(epicId: string, archive: boolean): void {
  const { db } = openLoom();
  const store = new EpicStore(db);
  const audit = new AuditLog(db);

  const epic = store.get(epicId);
  if (!epic) {
    console.error(`Epic "${epicId}" not found.`);
    process.exit(1);
  }

  const alreadyArchived = epic.archived_at != null;
  if (archive && alreadyArchived) {
    console.log(`  ${epicId} is already archived.`);
    return;
  }
  if (!archive && !alreadyArchived) {
    console.log(`  ${epicId} is not archived.`);
    return;
  }

  if (archive) store.archive(epicId);
  else store.unarchive(epicId);

  audit.record({
    action: archive ? 'epic_archived' : 'epic_unarchived',
    command: epicId,
  });

  const verb = archive ? 'archived' : 'unarchived';
  console.log(`  ${verb}  ${epicId}: ${epic.title}`);
  if (archive) {
    console.log('\n  Hidden from `loom status`. Show it again with `loom status --archived`.');
  }
}

function openLoom(): { db: ReturnType<typeof openProjectDatabase>; loomDir: string } {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }
  return { db: openProjectDatabase(projectRoot), loomDir };
}

export const spec: CommandDescription = {
  name: 'archive',
  summary: 'Hide an epic run from default views (non-destructive)',
  whenToUse: 'Use after a completed or abandoned epic to declutter `loom status` and the web dashboard without deleting data.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic to archive (e.g. epic-001)' },
  ],
  options: [],
  output: { text: 'Confirmation message that the epic was archived' },
  examples: [
    { command: 'loom archive epic-001', description: 'Archive epic-001 so it is hidden from default views' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Archived successfully' },
    { code: 1, meaning: 'Epic not found or loom not initialized' },
  ],
  errors: ['Epic not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['init', 'run'], nextSteps: ['unarchive', 'status'] },
};

export const specUnarchive: CommandDescription = {
  name: 'unarchive',
  summary: 'Restore an archived epic run to default views',
  whenToUse: 'Use to bring back an epic previously hidden with `loom archive`.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic to unarchive (e.g. epic-001)' },
  ],
  options: [],
  output: { text: 'Confirmation message that the epic was unarchived' },
  examples: [
    { command: 'loom unarchive epic-001', description: 'Restore epic-001 to default views' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Unarchived successfully' },
    { code: 1, meaning: 'Epic not found or loom not initialized' },
  ],
  errors: ['Epic not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['archive'], nextSteps: ['status'] },
};
