import fs from 'node:fs';
import path from 'node:path';
import { ProjectRegistry, createDatabase, EpicStore } from '@loom-ai/core';

export interface ProjectOptions {
  json?: boolean;
}

/**
 * `loom project <project-root>` — one registered project's detail plus its
 * latest epic, mirroring `loom_get_project`.
 */
export function runProject(projectRoot: string, opts: ProjectOptions = {}): void {
  const resolvedRoot = path.resolve(projectRoot);
  const entry = new ProjectRegistry().list().find((p) => p.root === resolvedRoot);

  if (!entry) {
    process.exitCode = 1;
    console.error(`Project "${resolvedRoot}" is not registered with loom.`);
    return;
  }

  let latestEpic: { id: string; status: string; title: string } | undefined;
  try {
    const dbPath = path.join(entry.root, '.loom', 'loom.db');
    if (fs.existsSync(dbPath)) {
      const db = createDatabase(dbPath);
      const epics = new EpicStore(db).list();
      const last = epics[epics.length - 1];
      if (last) latestEpic = { id: last.id, status: last.status, title: last.title };
      db.close();
    }
  } catch {
    // ignore — registry entry is still useful without epic data
  }

  if (opts.json) {
    const out: { project: typeof entry; latest_epic?: typeof latestEpic } = {
      project: entry,
      ...(latestEpic ? { latest_epic: latestEpic } : {}),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const name = path.basename(entry.root);
  console.log(`  root:         ${entry.root}`);
  console.log(`  name:         ${name}`);
  if (latestEpic) {
    console.log(`  latest epic:  ${latestEpic.id}  [${latestEpic.status}]  ${latestEpic.title}`);
  } else {
    console.log(`  latest epic:  (none)`);
  }
}
