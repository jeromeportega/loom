import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLog } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface AuditOptions {
  story?: string;
  agent?: string;
  limit?: number;
  json?: boolean;
  /** Override the project root (defaults to process.cwd()). Avoids process.chdir() in tests. */
  projectRoot?: string;
}

/**
 * `loom audit` — recent audit_log entries. `--story` matches across every retry
 * attempt; `--agent` scopes to one agent; default is the most recent rows.
 */
export function runAudit(opts: AuditOptions = {}): void {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const audit = new AuditLog(db);
  const entries = opts.story
    ? audit.getByStory(opts.story, opts.limit ?? 50)
    : opts.agent
      ? audit.getByAgent(opts.agent, opts.limit ?? 50)
      : audit.recent(opts.limit ?? 20);

  if (opts.json) {
    console.log(JSON.stringify({ entries }, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log('  No audit entries found for that scope.');
    return;
  }

  for (const e of entries) {
    const mark = e.allowed === false ? '✗' : e.allowed === true ? '✓' : '·';
    const cmd = e.command ? `  ${e.command}` : '';
    console.log(`  ${e.timestamp}  ${mark} ${e.action}${cmd}`);
  }
}

export const spec: CommandDescription = {
  name: 'audit',
  summary: 'Show recent audit_log entries',
  whenToUse: 'Use to inspect what agents and the supervisor have done. Scope to a story or agent for focused forensics.',
  arguments: [],
  options: [
    { name: '--story', type: 'string', description: 'Story id to scope audit entries to (matches across retries)', changesOutputShape: false },
    { name: '--agent', type: 'string', description: 'Agent id to scope audit entries to', changesOutputShape: false },
    { name: '--limit', type: 'number', default: 20, description: 'Max rows to return (default 20)', changesOutputShape: false },
    { name: '--json', type: 'boolean', description: 'Emit JSON: { entries: [...] }', changesOutputShape: true },
  ],
  output: {
    text: 'Timestamped audit log entries with action, command, and allow/block indicator',
    json: { supported: true, shape: '{ entries: AuditEntry[] }' },
  },
  examples: [
    { command: 'loom audit', description: 'Show the 20 most recent audit entries' },
    { command: 'loom audit --story story-001-003', description: 'Scope to all entries for story-001-003' },
    { command: 'loom audit --limit 50 --json', description: 'Emit 50 entries as JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Entries printed successfully' },
    { code: 1, meaning: 'loom not initialized' },
  ],
  errors: ['loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['init'], nextSteps: ['traces', 'status'] },
};
