import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, DecisionTraceStore } from '@loom-ai/core';

export interface TracesOptions {
  story?: string;
  agent?: string;
  epic?: string;
  limit?: number;
  json?: boolean;
}

/**
 * `loom traces` — worker reasoning captured to SQLite. Exactly one of
 * `--story` / `--agent` / `--epic` bounds the lookup.
 */
export function runTraces(opts: TracesOptions = {}): void {
  const loomDir = path.join(process.cwd(), '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const scopes = [opts.story, opts.agent, opts.epic].filter(Boolean);
  if (scopes.length !== 1) {
    console.error('Pass exactly one of --story, --agent, or --epic.');
    process.exit(1);
    return;
  }

  const db = openDatabase(loomDir);
  const store = new DecisionTraceStore(db);
  const traces = opts.agent
    ? store.getByAgent(opts.agent, opts.limit ?? 200)
    : opts.story
      ? store.getByStory(opts.story, opts.limit ?? 500)
      : store.getByEpic(opts.epic as string, opts.limit ?? 2000);

  if (opts.json) {
    console.log(JSON.stringify({ traces }, null, 2));
    return;
  }

  if (traces.length === 0) {
    console.log('  No decision traces found for that scope.');
    return;
  }

  for (const t of traces) {
    const subject = t.subject ? ` ${t.subject}` : '';
    console.log(`  ${t.timestamp}  [${t.kind}]${subject}`);
    if (t.rationale) {
      console.log(`      ${t.rationale.replace(/\n/g, '\n      ')}`);
    }
  }
}

export const spec: CommandDescription = {
  name: 'traces',
  summary: 'Show captured worker reasoning (decision traces)',
  whenToUse: 'Use to inspect the internal reasoning steps a worker recorded. Scope to exactly one of --story, --agent, or --epic for focused analysis.',
  arguments: [],
  options: [
    { name: '--story', type: 'string', description: 'Story id to scope traces to', changesOutputShape: false },
    { name: '--agent', type: 'string', description: 'Agent id to scope traces to', changesOutputShape: false },
    { name: '--epic', type: 'string', description: 'Epic id to scope traces to', changesOutputShape: false },
    { name: '--limit', type: 'number', description: 'Max rows to return', changesOutputShape: false },
    { name: '--json', type: 'boolean', description: 'Emit JSON: { traces: [...] }', changesOutputShape: true },
  ],
  output: {
    text: 'Formatted decision traces with timestamps and rationale',
    json: { supported: true, shape: '{ traces: DecisionTrace[] }' },
  },
  examples: [
    { command: 'loom traces --story story-001-003', description: 'Show all traces for story-001-003' },
    { command: 'loom traces --epic epic-001 --json', description: 'Emit all traces for epic-001 as JSON' },
    { command: 'loom traces --story story-001-003 --limit 10', description: 'Show the 10 most recent traces' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Traces shown successfully' },
    { code: 1, meaning: 'loom not initialized' },
  ],
  errors: ['loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['init'], nextSteps: ['audit', 'status'] },
};
