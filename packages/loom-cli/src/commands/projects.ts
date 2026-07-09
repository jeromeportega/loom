import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectRegistry, createDatabase, EpicStore, PolicyEngine, prepareRepoState } from '@loom-ai/core';

export interface ProjectsOptions {
  json?: boolean;
}

function loadLatestEpic(projectRoot: string): { id: string; status: string; title: string } | undefined {
  try {
    const peerLoomDir = path.join(projectRoot, '.loom');
    let peerPolicy: { loom_home?: string } = {};
    try {
      peerPolicy = PolicyEngine.load(peerLoomDir).policyData;
    } catch { /* use default */ }
    const { dbPath } = prepareRepoState(projectRoot, peerPolicy);
    if (!fs.existsSync(dbPath)) return undefined;
    const db = createDatabase(dbPath);
    try {
      const epics = new EpicStore(db).list();
      const sorted = [...epics].sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1
      );
      const last = sorted[sorted.length - 1];
      if (last) return { id: last.id, status: last.status, title: last.title };
    } finally {
      db.close();
    }
  } catch (err) {
    process.stderr.write(`[loom projects] warning: could not read epic data: ${(err as Error).message}\n`);
  }
  return undefined;
}

/**
 * `loom projects` — every loom-initialized repo on this machine, from
 * ~/.loom/projects.json. The registry self-heals (prunes missing dirs) on read.
 *
 * When `root` is provided, shows only that registered project and its latest epic.
 */
export function runProjects(root?: string, opts: ProjectsOptions = {}): void {
  const projects = new ProjectRegistry().list();

  if (root !== undefined) {
    const resolved = path.resolve(root);
    const entry = projects.find((p) => p.root === resolved);

    if (!entry) {
      console.error(`Project "${resolved}" is not registered with loom.`);
      process.exitCode = 1;
      return;
    }

    const latestEpic = loadLatestEpic(entry.root);

    if (opts.json) {
      const out = {
        projects: [{ ...entry, ...(latestEpic ? { latest_epic: latestEpic } : {}) }],
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
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ projects }, null, 2));
    return;
  }

  if (projects.length === 0) {
    console.log('  No loom projects registered on this machine.');
    return;
  }

  for (const p of projects) {
    console.log(`  ${p.root}`);
  }
}

export const spec: CommandDescription = {
  name: 'projects',
  summary: 'List loom-initialized repos on this machine',
  whenToUse: 'Use to see all repos that have been initialized with `loom init` on this machine.',
  arguments: [
    { name: 'project-root', type: 'string', required: false, description: 'Filter to a single registered project and its latest epic' },
  ],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit JSON: { projects: [...] }', changesOutputShape: true },
  ],
  output: {
    text: 'List of project root paths registered with loom',
    json: { supported: true, shape: '{ projects: { root: string }[] }' },
  },
  examples: [
    { command: 'loom projects', description: 'List all registered loom projects' },
    { command: 'loom projects --json', description: 'Emit the project list as JSON' },
    { command: 'loom projects /path/to/repo', description: 'Show a single registered project and its latest epic' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Projects listed successfully' },
    { code: 1, meaning: 'Specified project root not registered with loom' },
  ],
  errors: ['Project root not registered — run `loom init` in that directory first'],
  relationships: { prerequisites: [], nextSteps: ['project', 'status'] },
};
