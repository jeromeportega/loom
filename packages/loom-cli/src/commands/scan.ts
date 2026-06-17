import fs from 'node:fs';
import path from 'node:path';
import {
  openDatabase,
  PolicyEngine,
  createLLMClient,
  modelFor,
  AuditLog,
  runScan,
  OpportunityStore,
  ProjectRegistry,
} from '@loom-ai/core';
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
      process.exit(1);
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
  const db = openDatabase(loomDir);
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

  const db = openDatabase(loomDir);
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
