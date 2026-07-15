import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLog } from '@loom-ai/core';
import type { VerifyChainResult } from '@loom-ai/core';
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
    process.exitCode = 1;
    return;
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

export interface AuditVerifyOptions {
  json?: boolean;
  /** Override the project root (defaults to process.cwd()). Avoids process.chdir() in tests. */
  projectRoot?: string;
}

export function runAuditVerify(opts: AuditVerifyOptions = {}): void {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, reason: 'not-initialized' }));
    } else {
      console.error('loom is not initialized in this directory. Run `loom init` first.');
    }
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    try {
      const db = openProjectDatabase(projectRoot);
      try {
        const result = new AuditLog(db).verifyChain();
        console.log(JSON.stringify(result));
        if (!result.ok) {
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ ok: false, reason: 'error', detail }));
      process.exitCode = 1;
    }
    return;
  }

  try {
    const db = openProjectDatabase(projectRoot);
    try {
      const result = new AuditLog(db).verifyChain();
      if (result.ok) {
        console.log(`Chain intact — ${result.hashedRows} hashed rows`);
      } else {
        console.error(
          result.brokenAtId !== undefined
            ? `Chain broken at row ID ${result.brokenAtId}: ${result.reason}`
            : `Chain broken: ${result.reason}`
        );
        process.exitCode = 1;
      }
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Chain verification failed: ${msg}`);
    process.exitCode = 1;
  }
}

export const verifySpec: CommandDescription = {
  name: 'audit verify',
  summary: 'Verify audit log SHA-256 chain. Not tamper-proof if audit_chain_head is also rewritten.',
  whenToUse: 'Use after an incident to check whether audit_log rows have been edited, reordered, deleted (including tail truncation), or had unhashed rows inserted in the chained region. Exits 0 when intact, 1 when broken. The guarantee covers the chained region (rows from the anchor cutover onward) — pre-cutover legacy rows are not integrity-checked. Caveat: being an in-DB, unkeyed SHA-256 chain, it does not defend against an adversary with full DB write access who ALSO rewrites audit_chain_head; full resistance requires an external signed witness (planned).',
  arguments: [],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit VerifyChainResult as JSON (semver-stable output contract)', changesOutputShape: true },
  ],
  output: {
    text: 'Single-line pass/fail message: "Chain intact — N hashed rows" or "Chain broken at row ID <id>: <reason>"',
    json: { supported: true, shape: 'VerifyChainResult: { ok, hashedRows, legacyRows, fromId, toId, brokenAtId?, reason? }' },
  },
  examples: [
    { command: 'loom audit verify', description: 'Check the audit log chain and print a human-readable result' },
    { command: 'loom audit verify --json', description: 'Emit the full VerifyChainResult as JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Chain intact (or no hashed rows yet)' },
    { code: 1, meaning: 'Chain broken or loom not initialized' },
  ],
  errors: ['loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['init'], nextSteps: ['audit', 'traces'] },
};

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
