import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { EpicStore } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface ArtifactsOptions {
  json?: boolean;
  /** Print one body to stdout: brief | prd | architecture | epic_yaml. */
  section?: string;
}

const SECTIONS = ['brief', 'prd', 'architecture', 'epic_yaml'] as const;

/**
 * `loom artifacts <epic-id>` — the brief / PRD / architecture / epic YAML for an
 * epic. Default lists which exist; `--section` prints one body; `--json` returns
 * all bodies. Missing files surface as null, not errors.
 */
export function runArtifacts(epicId: string, opts: ArtifactsOptions = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const epic = new EpicStore(db).get(epicId);
  if (!epic) {
    console.error(`Epic "${epicId}" not found.`);
    process.exit(1);
    return;
  }

  const readMaybe = (rel: string | null | undefined): string | null => {
    if (!rel) return null;
    const abs = path.join(projectRoot, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  };

  const brief = readMaybe(epic.brief_path);
  const prd = readMaybe(epic.prd_path);
  const epic_yaml = readMaybe(epic.yaml_path);
  const architecture = epic.brief_path
    ? readMaybe(path.join(path.dirname(epic.brief_path), 'architecture.md'))
    : null;
  const bodies: Record<(typeof SECTIONS)[number], string | null> = { brief, prd, architecture, epic_yaml };

  if (opts.section) {
    const key = (opts.section === 'arch' ? 'architecture' : opts.section) as (typeof SECTIONS)[number];
    if (!SECTIONS.includes(key)) {
      console.error(`--section must be one of: ${SECTIONS.join(' | ')}`);
      process.exit(1);
      return;
    }
    const body = bodies[key];
    if (body == null) {
      console.error(`No ${key} artifact recorded for ${epicId}.`);
      process.exit(1);
      return;
    }
    process.stdout.write(body.endsWith('\n') ? body : body + '\n');
    return;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          epic_id: epicId,
          paths: { brief: epic.brief_path, prd: epic.prd_path, epic_yaml: epic.yaml_path },
          brief,
          prd,
          architecture,
          epic_yaml,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`  Planning artifacts for ${epicId}:`);
  for (const key of SECTIONS) {
    console.log(`    ${bodies[key] != null ? '✓' : '·'} ${key}`);
  }
  console.log('');
  console.log(`  --section <${SECTIONS.join('|')}> prints one body; --json returns all.`);
}

export const spec: CommandDescription = {
  name: 'artifacts',
  summary: "Show an epic's planning artifacts",
  whenToUse: 'Use to inspect the brief, PRD, architecture note, and epic YAML produced by `loom epic` for a given epic.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic id (e.g. epic-001)' },
  ],
  options: [
    { name: '--section', type: 'enum', description: 'Print one body: brief | prd | architecture | epic_yaml', changesOutputShape: true },
    { name: '--json', type: 'boolean', description: 'Emit JSON with paths and all artifact bodies', changesOutputShape: true },
  ],
  output: {
    text: 'Formatted planning artifact sections',
    json: { supported: true, shape: '{ brief, prd, architecture, epic_yaml, paths }' },
  },
  examples: [
    { command: 'loom artifacts epic-001', description: 'Show all planning artifacts for epic-001' },
    { command: 'loom artifacts epic-001 --section prd', description: 'Print only the PRD body' },
    { command: 'loom artifacts epic-001 --json', description: 'Emit JSON with all artifact bodies and paths' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Artifacts printed successfully' },
    { code: 1, meaning: 'Epic not found or loom not initialized' },
  ],
  errors: ['Epic not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['epic', 'approve'], nextSteps: ['run', 'status'] },
};
