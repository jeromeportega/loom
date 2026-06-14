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
