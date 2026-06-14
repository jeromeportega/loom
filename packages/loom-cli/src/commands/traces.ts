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
