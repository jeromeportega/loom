import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { MetricsStore } from '@loom-ai/core';
import type { RunMetricsRecord, PhaseMetricsRecord } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface CostOptions {
  run?: number;
  epic?: string;
  aggregate?: boolean;
  json?: boolean;
}

function fmtUsd(usd: number | undefined): string {
  if (usd === undefined || usd === 0) return '$0.000000';
  return `$${usd.toFixed(6)}`;
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function printRunBreakdown(run: RunMetricsRecord, phases: PhaseMetricsRecord[]): void {
  const scope = run.epicId ?? run.storyId ?? `run #${run.id}`;
  console.log(`Run #${run.id}  scope=${run.scope}  ${scope}`);
  if (run.outcome) console.log(`  outcome: ${run.outcome}`);
  if (run.startedAt) console.log(`  started: ${run.startedAt}`);
  if (run.intakeVerdict) console.log(`  intake:  ${run.intakeVerdict}${run.intakeKind ? ` (${run.intakeKind})` : ''}`);
  if (run.storyCount !== undefined) console.log(`  stories: ${run.storyCount}`);
  console.log(`  retries: ${run.retryCount}  clean=${run.cleanRetryCount}  recovery=${run.autoRecoveryCount}`);
  console.log(`  total:   cost=${fmtUsd(run.costUsd)}  tokens=${fmtTokens(run.billedTokensTotal)}  wall=${fmtMs(run.totalWallMs)}`);
  if (run.dispatchLatencyMs !== undefined) {
    console.log(`  dispatch latency: ${fmtMs(run.dispatchLatencyMs)}`);
  }

  if (phases.length > 0) {
    console.log('');
    console.log('  Phase            Model                   Cost        Tokens     Wall');
    console.log('  ─────────────────────────────────────────────────────────────────────');
    for (const p of phases) {
      const model = p.model ? p.model.padEnd(23) : '—'.padEnd(23);
      const phase = p.phase.padEnd(16);
      const cost = fmtUsd(p.costUsd).padStart(11);
      const tokens = fmtTokens(p.billedTokens).padStart(10);
      const wall = fmtMs(p.wallMs).padStart(9);
      console.log(`  ${phase} ${model} ${cost} ${tokens} ${wall}`);
    }
  }
}

function printAggregates(store: MetricsStore): void {
  const medians = store.medianPlanningCostByVerdict();
  const timeShare = store.timeShareByPhase();
  const retryCost = store.retryRecoveryCost();

  console.log('Median planning cost by intake verdict');
  if (medians.length === 0) {
    console.log('  (no data)');
  } else {
    for (const m of medians) {
      console.log(`  ${m.verdict.padEnd(8)} median=${fmtUsd(m.medianCostUsd)}  n=${m.n}`);
    }
  }

  console.log('');
  console.log('Time share by phase');
  if (timeShare.length === 0) {
    console.log('  (no data)');
  } else {
    const totalShare = timeShare.reduce((s, p) => s + p.share, 0);
    for (const p of timeShare) {
      const pct = (p.share * 100).toFixed(1).padStart(5);
      console.log(`  ${p.phase.padEnd(16)} ${pct}%  ${fmtMs(p.wallMs)}`);
    }
    if (Math.abs(totalShare - 1) > 0.01 && timeShare.length > 0) {
      console.log(`  (shares sum to ${(totalShare * 100).toFixed(1)}%)`);
    }
  }

  console.log('');
  console.log('Retry / auto-recovery cost (whole-run totals for imperfect runs)');
  console.log(`  retries:   tokens=${fmtTokens(retryCost.retryTokens)}  cost=${fmtUsd(retryCost.costUsd)}`);
  console.log(`  recovery:  tokens=${fmtTokens(retryCost.autoRecoveryTokens)}  cost=${fmtUsd(retryCost.autoRecoveryCostUsd)}`);
}

export function runCost(opts: CostOptions = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
    return;
  }

  const db = openProjectDatabase(projectRoot);
  const store = new MetricsStore(db);

  if (opts.aggregate) {
    if (opts.json) {
      const medians = store.medianPlanningCostByVerdict();
      const timeShare = store.timeShareByPhase();
      const retryCost = store.retryRecoveryCost();
      console.log(JSON.stringify({ medianPlanningCostByVerdict: medians, timeShareByPhase: timeShare, retryRecoveryCost: retryCost }, null, 2));
      return;
    }
    printAggregates(store);
    return;
  }

  if (opts.run !== undefined) {
    const run = store.getRun(opts.run);
    if (!run) {
      console.error(`No run found with id ${opts.run}.`);
      process.exit(1);
      return;
    }
    const phases = store.getPhases(run.id);
    if (opts.json) {
      console.log(JSON.stringify({ run: { ...run, phases } }, null, 2));
      return;
    }
    printRunBreakdown(run, phases);
    return;
  }

  // Default: list recent runs (optionally filtered by epic)
  const runs = store.listRuns(opts.epic ? { epicId: opts.epic } : undefined);

  if (runs.length === 0) {
    console.log('  No metrics recorded yet.');
    return;
  }

  if (opts.json) {
    const runsWithPhases = runs.map((r) => ({ ...r, phases: store.getPhases(r.id) }));
    console.log(JSON.stringify({ runs: runsWithPhases }, null, 2));
    return;
  }

  for (const run of runs) {
    const phases = store.getPhases(run.id);
    printRunBreakdown(run, phases);
    console.log('');
  }
}

export const spec: CommandDescription = {
  name: 'cost',
  summary: 'Show cost and timing breakdown for one run or cross-run aggregates',
  whenToUse: 'Use to inspect per-phase cost and time for a specific run, or to see cross-run aggregate statistics (median planning cost by intake verdict, time share by phase, retry/recovery costs). Strictly read-only — never mutates state.',
  arguments: [],
  options: [
    { name: '--run', type: 'number', description: 'Run id to show a single-run phase breakdown for', changesOutputShape: false },
    { name: '--epic', type: 'string', description: 'Epic id to scope the run list to', changesOutputShape: false },
    { name: '--aggregate', type: 'boolean', description: 'Show cross-run aggregate statistics computed at query time from raw rows (median planning cost by verdict, time share by phase, retry/recovery cost)', changesOutputShape: true },
    { name: '--json', type: 'boolean', description: 'Emit JSON output', changesOutputShape: true },
  ],
  output: {
    text: 'Per-phase cost, token, and wall-time table for each run; or aggregate statistics',
    json: { supported: true, shape: '{ run: RunMetricsRecord & { phases: PhaseMetricsRecord[] } } | { runs: [...] } | { medianPlanningCostByVerdict, timeShareByPhase, retryRecoveryCost }' },
  },
  examples: [
    { command: 'loom cost', description: 'Show cost and time breakdown for recent runs' },
    { command: 'loom cost --run 42', description: 'Show phase-level breakdown for run #42' },
    { command: 'loom cost --epic epic-001', description: 'Show all runs for epic-001' },
    { command: 'loom cost --aggregate', description: 'Show cross-run aggregate statistics' },
    { command: 'loom cost --aggregate --json', description: 'Emit aggregate statistics as JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Cost information shown successfully' },
    { code: 1, meaning: 'loom not initialized, or run id not found' },
  ],
  errors: [
    'loom is not initialized — run `loom init` first',
    'No run found with the specified id',
  ],
  relationships: { prerequisites: ['run'], nextSteps: ['audit', 'status', 'traces'] },
};
