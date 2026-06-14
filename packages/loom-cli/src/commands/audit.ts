import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, AuditLog } from '@loom-ai/core';

export interface AuditOptions {
  story?: string;
  agent?: string;
  limit?: number;
  json?: boolean;
}

/**
 * `loom audit` — recent audit_log entries. `--story` matches across every retry
 * attempt; `--agent` scopes to one agent; default is the most recent rows.
 */
export function runAudit(opts: AuditOptions = {}): void {
  const loomDir = path.join(process.cwd(), '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openDatabase(loomDir);
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
