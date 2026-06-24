import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import nodePath from 'node:path';
import { AuditLog, PolicyEngine, resolveLoomHomePath, RetrievalService, RetrievalRefused } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseLines(raw: string): [number, number] {
  const parts = raw.split(':');
  if (parts.length !== 2) {
    throw new Error(`--lines must be in the format <start>:<end>, got: ${raw}`);
  }
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
    throw new Error(`--lines values must be integers, got: ${raw}`);
  }
  const start = parseInt(parts[0], 10);
  const end = parseInt(parts[1], 10);
  if (start < 1 || end < start) {
    throw new Error(`--lines values must be positive integers with start <= end, got: ${raw}`);
  }
  return [start, end];
}

function buildService(projectRoot: string, db: ReturnType<typeof openProjectDatabase>): RetrievalService {
  const loomDir = nodePath.join(projectRoot, '.loom');
  const policy = PolicyEngine.load(loomDir).policyData;
  const loomHome = resolveLoomHomePath(projectRoot, policy);
  const audit = new AuditLog(db);
  return new RetrievalService(loomHome, policy, audit);
}

// ── loom retrieve search ──────────────────────────────────────────────────────

export interface RetrieveSearchOptions {
  repo: string;
  query: string;
  glob?: string;
  /** Override process.cwd(); used by tests to inject a known-clean directory. */
  cwd?: string;
}

export async function runRetrieveSearch(opts: RetrieveSearchOptions): Promise<void> {
  const projectRoot = opts.cwd ?? process.cwd();
  const loomDir = nodePath.join(projectRoot, '.loom');
  if (!fs.existsSync(nodePath.join(loomDir, 'policy.yaml'))) {
    process.stderr.write('loom is not initialized in this directory. Run `loom init` first.\n');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  try {
    let svc: RetrievalService;
    try {
      svc = buildService(projectRoot, db);
    } catch (err) {
      process.stderr.write(`Failed to initialize: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    try {
      const result = svc.search({ kind: 'search', slug: opts.repo, query: opts.query, pathGlob: opts.glob });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (err) {
      if (err instanceof RetrievalRefused) {
        process.stderr.write(JSON.stringify({ rule: err.rule, reason: err.reason }) + '\n');
        process.exit(1);
      }
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

// ── loom retrieve read ────────────────────────────────────────────────────────

export interface RetrieveReadOptions {
  repo: string;
  filePath: string;
  lines?: string;
  /** Override process.cwd(); used by tests to inject a known-clean directory. */
  cwd?: string;
}

export async function runRetrieveRead(opts: RetrieveReadOptions): Promise<void> {
  // Validate --lines early so the error is clear before touching the fs.
  let lines: [number, number] | undefined;
  if (opts.lines !== undefined) {
    try {
      lines = parseLines(opts.lines);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  const projectRoot = opts.cwd ?? process.cwd();
  const loomDir = nodePath.join(projectRoot, '.loom');
  if (!fs.existsSync(nodePath.join(loomDir, 'policy.yaml'))) {
    process.stderr.write('loom is not initialized in this directory. Run `loom init` first.\n');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  try {
    let svc: RetrievalService;
    try {
      svc = buildService(projectRoot, db);
    } catch (err) {
      process.stderr.write(`Failed to initialize: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    try {
      const result = svc.read({ kind: 'read', slug: opts.repo, path: opts.filePath, lines });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (err) {
      if (err instanceof RetrievalRefused) {
        process.stderr.write(JSON.stringify({ rule: err.rule, reason: err.reason }) + '\n');
        process.exit(1);
      }
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

// ── CommandDescription specs ──────────────────────────────────────────────────

export const specSearch: CommandDescription = {
  name: 'retrieve search',
  summary: 'Search a registered sibling repository for a symbol or pattern',
  whenToUse: 'Use to pull a bounded set of matches from a sibling repo. Cross-repo retrieval must be enabled (cross_repo.enabled=true).',
  audience: 'internal',
  arguments: [],
  options: [
    { name: '--repo', type: 'string', description: '(required) Slug of the registered repository to search', changesOutputShape: false },
    { name: '--query', type: 'string', description: '(required) Fixed string to search for (git grep -F)', changesOutputShape: false },
    { name: '--glob', type: 'string', description: 'Optional path glob to restrict the search (e.g. "*.ts")', changesOutputShape: false },
  ],
  output: {
    text: 'JSON-serialized SearchResult printed to stdout; { rule, reason } to stderr on refusal',
    json: { supported: true, shape: 'SearchResult | { rule: string; reason: string }' },
  },
  examples: [
    { command: 'loom retrieve search --repo payments-api --query PaymentGateway', description: 'Find PaymentGateway across all files in the payments-api repo' },
    { command: 'loom retrieve search --repo payments-api --query PaymentGateway --glob "*.ts"', description: 'Narrow search to TypeScript files only' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Search completed; JSON result printed to stdout' },
    { code: 1, meaning: 'Refusal (unregistered slug, disabled policy, secret path) or missing --repo/--query' },
  ],
  errors: [
    'cross_repo.disabled — cross-repo retrieval is not enabled in policy.yaml',
    'cross_repo.unregistered — slug not found in workspace manifest',
    'loom is not initialized — run `loom init` first',
  ],
  relationships: { prerequisites: ['init'], nextSteps: ['retrieve read'] },
};

export const specRead: CommandDescription = {
  name: 'retrieve read',
  summary: 'Read a bounded file slice from a registered sibling repository',
  whenToUse: 'Use to pull a specific file (or line range) from a sibling repo as context. Cross-repo retrieval must be enabled (cross_repo.enabled=true).',
  audience: 'internal',
  arguments: [],
  options: [
    { name: '--repo', type: 'string', description: '(required) Slug of the registered repository to read from', changesOutputShape: false },
    { name: '--path', type: 'string', description: '(required) Relative file path within the repository', changesOutputShape: false },
    { name: '--lines', type: 'string', description: 'Optional line range as <start>:<end> (e.g. "10:50")', changesOutputShape: false },
  ],
  output: {
    text: 'JSON-serialized ReadResult printed to stdout; { rule, reason } to stderr on refusal',
    json: { supported: true, shape: 'ReadResult | { rule: string; reason: string }' },
  },
  examples: [
    { command: 'loom retrieve read --repo payments-api --path src/gateway.ts', description: 'Read the full gateway.ts file from the payments-api repo' },
    { command: 'loom retrieve read --repo payments-api --path src/gateway.ts --lines 1:50', description: 'Read the first 50 lines of gateway.ts' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Read completed; JSON result printed to stdout' },
    { code: 1, meaning: 'Refusal (unregistered slug, disabled policy, file too large, secret) or missing --repo/--path' },
  ],
  errors: [
    'cross_repo.disabled — cross-repo retrieval is not enabled in policy.yaml',
    'cross_repo.unregistered — slug not found in workspace manifest',
    'cross_repo.file_too_large — file exceeds maxFileBytes bound',
    'cross_repo.secret_excluded — path matches a secret glob',
    'loom is not initialized — run `loom init` first',
  ],
  relationships: { prerequisites: ['init', 'retrieve search'], nextSteps: [] },
};
