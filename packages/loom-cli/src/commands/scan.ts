import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  PolicyEngine,
  createLLMClient,
  modelFor,
  AuditLog,
  runScan,
  OpportunityStore,
  ProjectRegistry,
} from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';
import type { LLMClient, SignalScanner } from '@loom-ai/core';
import type { OpportunityRecord } from '@loom-ai/core';

export interface ScanOptions {
  /** JSON output mode — emits structured { opportunities: OpportunityRecord[] }. */
  json?: boolean;
  /** Test seam — inject a stub LLMClient. Production callers omit this. */
  llm?: LLMClient;
  /** Test seam — inject scanners. Production uses defaultScanners(). */
  scanners?: SignalScanner[];
  /** Target the named registered project (absolute path). */
  project?: string;
}

/**
 * `loom scan` — runs the signal scan pipeline end-to-end and prints the
 * ranked opportunity board. Mirrors runEpic in structure:
 *   1. Require loom init
 *   2. Load policy
 *   3. Build LLM client
 *   4. runScan() — scanners → signals → LLM clustering → opportunities
 *   5. Print ranked board (or JSON when --json)
 *
 * Also exposed as `loom opportunities` (alias).
 */
export async function runScanCommand(opts: ScanOptions = {}): Promise<void> {
  let projectRoot = process.cwd();
  let loomDir = path.join(projectRoot, '.loom');

  if (opts.project) {
    const resolved = path.resolve(opts.project);
    const known = new ProjectRegistry().list();
    if (!known.some((p) => p.root === resolved)) {
      console.error(`Project not registered: ${resolved}`);
      process.exitCode = 1;
      return;
    }
    projectRoot = resolved;
    loomDir = path.join(resolved, '.loom');
  }

  // When no LLM is injected (production path), a policy.yaml is required to
  // configure the LLM backend. Test callers inject opts.llm directly so they
  // don't need a policy file.
  if (!opts.llm && !fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const policy = PolicyEngine.load(loomDir).policyData;
  const db = openProjectDatabase(projectRoot);
  const auditLog = new AuditLog(db);

  let llm: LLMClient;
  if (opts.llm) {
    llm = opts.llm;
  } else {
    try {
      llm = createLLMClient(policy.agents.llm_backend);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
      return;
    }
  }

  const model = modelFor(policy, 'planning');

  if (!opts.json) {
    console.log('\n  Scanning signals and clustering opportunities…\n');
  }

  let result;
  try {
    result = await runScan({
      db,
      projectRoot,
      llm,
      model,
      auditLog,
      scanners: opts.scanners,
    });
  } catch (err) {
    console.error('\n  Scan failed:', (err as Error).message);
    process.exit(1);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ opportunities: result.opportunities }, null, 2));
    return;
  }

  console.log(
    `  Scan complete — ${result.signalsObserved} signals observed, ` +
    `${result.signalsStaled} staled, ` +
    `${result.opportunities.length} opportunities.\n`
  );

  if (result.opportunities.length === 0) {
    console.log('  No opportunities found.\n');
    return;
  }

  printBoard(result.opportunities);
}

/**
 * Prints the ranked opportunity board to stdout.
 */
export function printBoard(opportunities: OpportunityRecord[]): void {
  const open = opportunities.filter(o => o.status === 'open');
  if (open.length === 0) {
    console.log('  No open opportunities.\n');
    return;
  }

  for (const opp of open) {
    const score = opp.score.toFixed(2);
    const signals = opp.signal_count;
    console.log(`  #${opp.rank}  ${opp.title}`);
    console.log(`       score: ${score}  ·  signals: ${signals}`);
    console.log(`       ${opp.rationale}`);
    if (opp.evidence.length > 0) {
      const links = opp.evidence.map(e => `${e.title} (${e.url})`).join(', ');
      console.log(`       evidence: ${links}`);
    }
    console.log('');
  }
}

/**
 * `loom opportunities` — alias that reads from the existing store without
 * triggering a new scan. Useful for viewing the current board without
 * spending an LLM call.
 */
export function runOpportunitiesCommand(opts: { json?: boolean } = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');

  if (!fs.existsSync(loomDir)) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const store = new OpportunityStore(db);
  const opportunities = store.listRanked();

  if (opts.json) {
    console.log(JSON.stringify({ opportunities }, null, 2));
    return;
  }

  if (opportunities.length === 0) {
    console.log('\n  No opportunities found. Run `loom scan` to discover them.\n');
    return;
  }

  console.log(`\n  Opportunity board (${opportunities.length} total):\n`);
  printBoard(opportunities);
}

export const spec: CommandDescription = {
  name: 'scan',
  summary: 'Scan for opportunities and produce a ranked board',
  whenToUse: 'Use to discover technical debt, test gaps, and improvement opportunities in the current project. Makes one LLM call; stores results for `loom opportunities` and `loom propose`.',
  arguments: [],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit structured JSON output', changesOutputShape: true },
    { name: '--project', type: 'string', description: 'Target the named registered project (absolute path)', changesOutputShape: false },
  ],
  output: {
    text: 'Ranked opportunity board with descriptions and scores',
    json: { supported: true, shape: '{ opportunities: OpportunityRecord[] }' },
  },
  examples: [
    { command: 'loom scan', description: 'Scan the current project for opportunities' },
    { command: 'loom scan --json', description: 'Emit scan results as JSON' },
    { command: 'loom scan --project /path/to/repo', description: 'Scan a specific registered project' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Scan completed and board produced' },
    { code: 1, meaning: 'loom not initialized, project not found, or LLM error' },
  ],
  errors: ['loom is not initialized — run `loom init` first', 'Project not registered', 'ANTHROPIC_API_KEY not set'],
  relationships: { prerequisites: ['init'], nextSteps: ['opportunities', 'propose'] },
};

export const specOpportunities: CommandDescription = {
  name: 'opportunities',
  summary: 'Show the current opportunity board (no new scan)',
  whenToUse: 'Use after `loom scan` to view the stored opportunity board without making another LLM call.',
  arguments: [],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit structured JSON output', changesOutputShape: true },
  ],
  output: {
    text: 'Ranked opportunity board from the most recent scan',
    json: { supported: true, shape: '{ opportunities: OpportunityRecord[] }' },
  },
  examples: [
    { command: 'loom opportunities', description: 'Show the current opportunity board' },
    { command: 'loom opportunities --json', description: 'Emit the board as JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Board shown successfully' },
    { code: 1, meaning: 'loom not initialized' },
  ],
  errors: ['loom is not initialized — run `loom init` first', 'No scan results — run `loom scan` first'],
  relationships: { prerequisites: ['scan'], nextSteps: ['propose', 'epic'] },
};
