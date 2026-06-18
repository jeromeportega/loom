import type { CommandDescription } from '../describe/schema.js';
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
      try {
        const epics = new EpicStore(db).list();
        // Sort ascending by created_at so the last element is always the newest,
        // regardless of what order EpicStore.list() returns.
        const sorted = [...epics].sort((a, b) =>
          a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
        );
        const last = sorted[sorted.length - 1];
        if (last) latestEpic = { id: last.id, status: last.status, title: last.title };
      } finally {
        db.close();
      }
    }
  } catch (err) {
    process.stderr.write(
      `[loom project] warning: could not read epic data: ${(err as Error).message}\n`
    );
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

export const spec: CommandDescription = {
  name: 'project',
  summary: 'Show a registered project and its latest epic',
  whenToUse: 'Use to inspect a specific registered loom project by path. Mirrors loom_get_project from the MCP surface.',
  arguments: [
    { name: 'project-root', type: 'string', required: true, description: 'Absolute or relative path to the project root' },
  ],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit JSON: { project, latest_epic? }', changesOutputShape: true },
  ],
  output: {
    text: 'Project root, name, and latest epic with status',
    json: { supported: true, shape: '{ project: { root, name }, latest_epic?: { id, status, title } }' },
  },
  examples: [
    { command: 'loom project /path/to/repo', description: 'Show project details and latest epic' },
    { command: 'loom project . --json', description: 'Emit project details as JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Project details shown' },
    { code: 1, meaning: 'Project not registered with loom' },
  ],
  errors: ['Project is not registered — run `loom init` in that directory first'],
  relationships: { prerequisites: ['init'], nextSteps: ['status', 'projects'] },
};
