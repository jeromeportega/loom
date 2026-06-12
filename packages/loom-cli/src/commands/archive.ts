import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, EpicStore, AuditLog } from '@loom-ai/core';

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

function openLoom(): { db: ReturnType<typeof openDatabase>; loomDir: string } {
  const loomDir = path.join(process.cwd(), '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }
  return { db: openDatabase(loomDir), loomDir };
}
