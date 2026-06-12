import fs from 'node:fs';
import path from 'node:path';
import { BenchVariance, type RunInput, type VarianceReport } from '@loom-ai/core';

export interface BenchVarianceOptions {
  /**
   * Parallel arrays. The k-th predictions file pairs with the k-th
   * report file. Reports are optional; without them harness_status is
   * 'unknown' and resolution rate can't be computed.
   */
  predictions: string[];
  reports?: string[];
  /** Optional sidecar manifests, parallel-indexed with predictions. */
  manifests?: string[];
  json?: boolean;
}

/**
 * `loom bench variance` — outcome distribution across K runs of the
 * same task set. Quantifies the noise floor that's been masking
 * intervention signals in the bench loop. Operator runs the bench K
 * times with the same config, hands the K predictions + K reports to
 * this analyzer; output: which tasks are consistently resolved, which
 * flip, and the mean resolution rate.
 */
export function runBenchVariance(opts: BenchVarianceOptions): void {
  if (opts.predictions.length === 0) {
    console.error('  --predictions requires at least one file');
    process.exit(1);
  }
  const reports = opts.reports ?? [];
  if (reports.length > 0 && reports.length !== opts.predictions.length) {
    console.error(
      `  --reports count (${reports.length}) must match --predictions count (${opts.predictions.length}) when provided`,
    );
    process.exit(1);
  }
  const manifests = opts.manifests ?? [];

  const runs: RunInput[] = opts.predictions.map((p, i) => ({
    predictionsPath: path.resolve(p),
    reportPath: reports[i] ? path.resolve(reports[i]) : undefined,
    tempdirs: manifests[i] ? readManifest(manifests[i]) : undefined,
  }));

  const result = new BenchVariance().analyze(runs);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  printText(result);
}

function readManifest(p: string): Record<string, string> | undefined {
  if (!fs.existsSync(p)) return undefined;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const row of raw as Array<{ instance_id?: string; tempdir?: string }>) {
      if (row.instance_id && row.tempdir) out[row.instance_id] = row.tempdir;
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function printText(r: VarianceReport): void {
  console.log('');
  console.log(`  ${r.runs} run(s) analyzed`);
  console.log(
    `  consistently resolved: ${r.summary.consistently_resolved}   ` +
      `consistently unresolved: ${r.summary.consistently_unresolved}   ` +
      `INCONSISTENT: ${r.summary.inconsistent}`,
  );
  console.log(`  mean resolution rate: ${(r.summary.mean_resolution_rate * 100).toFixed(1)}%`);
  console.log('');

  const idWidth = Math.max(...r.tasks.map((t) => t.instance_id.length), 20);
  // Sort: most inconsistent first (resolution_rate closest to 0.5),
  // because that's where the variance signal is concentrated.
  const sorted = [...r.tasks].sort((a, b) => {
    const distA = Math.abs(a.resolution_rate - 0.5);
    const distB = Math.abs(b.resolution_rate - 0.5);
    return distA - distB;
  });

  for (const t of sorted) {
    const rate = (t.resolution_rate * 100).toFixed(0) + '%';
    const statuses = formatCounts(t.status_counts);
    const modes = formatCounts(t.mode_counts).replace(/\(unset\):\d+/g, '').trim();
    const marker = t.resolution_rate === 1 ? '✓' : t.resolution_rate === 0 ? '✗' : '~';
    console.log(
      `  ${marker} ${t.instance_id.padEnd(idWidth)}  ${rate.padStart(5)}  ` +
        `[${t.runs_present}x]  ${statuses}${modes ? '  | ' + modes : ''}`,
    );
  }
  console.log('');
}

function formatCounts(c: Record<string, number>): string {
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
}
