import type { CommandDescription } from '../describe/schema.js';
import { ProjectRegistry } from '@loom-ai/core';

export interface ProjectsOptions {
  json?: boolean;
}

/**
 * `loom projects` — every loom-initialized repo on this machine, from
 * ~/.loom/projects.json. The registry self-heals (prunes missing dirs) on read.
 */
export function runProjects(opts: ProjectsOptions = {}): void {
  const projects = new ProjectRegistry().list();

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
  arguments: [],
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
  ],
  exitCodes: [
    { code: 0, meaning: 'Projects listed successfully' },
  ],
  errors: [],
  relationships: { prerequisites: [], nextSteps: ['project', 'status'] },
};
