import fs from 'node:fs';
import path from 'node:path';
import {
  BenchComparator,
  type RunComparison,
  type TaskComparison,
  type TaskClassification,
} from '@loom-ai/core';

export interface BenchCompareOptions {
  /** Harness report for run A. */
  reportA?: string;
  reportB?: string;
  /** Comma-separated instance_id=tempdir pairs for run A (and B). */
  tempdirsA?: string[];
  tempdirsB?: string[];
  /** Manifest sidecars for either run (preferred over --tempdirs when present). */
  manifestA?: string;
  manifestB?: string;
  json?: boolean;
}

/**
 * `loom bench compare <a-predictions> <b-predictions>` — per-task
 * change report between two bench runs. Surfaces held / gained /
 * regressed / shifted at a glance, replacing the manual comparison
 * pass in runbook writeups.
 */
export function runBenchCompare(
  aPredictions: string,
  bPredictions: string,
  opts: BenchCompareOptions = {},
): void {
  if (!fs.existsSync(aPredictions)) {
    console.error(`  predictions file not found: ${aPredictions}`);
    process.exit(1);
  }
  if (!fs.existsSync(bPredictions)) {
    console.error(`  predictions file not found: ${bPredictions}`);
    process.exit(1);
  }

  const result = new BenchComparator().compare({
    a: {
      predictionsPath: path.resolve(aPredictions),
      reportPath: opts.reportA ? path.resolve(opts.reportA) : undefined,
      tempdirs: collectTempdirs(opts.manifestA, opts.tempdirsA),
    },
    b: {
      predictionsPath: path.resolve(bPredictions),
      reportPath: opts.reportB ? path.resolve(opts.reportB) : undefined,
      tempdirs: collectTempdirs(opts.manifestB, opts.tempdirsB),
    },
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  printText(result);
}

function collectTempdirs(
  manifest: string | undefined,
  pairs: string[] | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (manifest && fs.existsSync(manifest)) {
    const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as unknown;
    if (Array.isArray(raw)) {
      for (const row of raw as Array<{ instance_id?: string; tempdir?: string }>) {
        if (row.instance_id && row.tempdir) out[row.instance_id] = row.tempdir;
      }
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
    }
  }
  for (const spec of pairs ?? []) {
    for (const pair of spec.split(',')) {
      const [id, p] = pair.split('=', 2);
      if (id && p) out[id.trim()] = p.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function printText(result: RunComparison): void {
  const s = result.summary;
  console.log('');
  console.log(`  A: ${result.a.predictions_path}`);
  console.log(`  B: ${result.b.predictions_path}`);
  console.log('');
  console.log(
    `  Resolution: ${s.resolved_a} → ${s.resolved_b}  ` +
      `(${s.delta >= 0 ? '+' : ''}${s.delta})`,
  );
  console.log(
    `  held ${s.held}  gained ${s.gained}  regressed ${s.regressed}` +
      `  shifted ${s.shifted}` +
      (s.added > 0 ? `  added ${s.added}` : '') +
      (s.removed > 0 ? `  removed ${s.removed}` : ''),
  );
  console.log('');

  // Per-task lines — show regressions and gains first (the load-bearing
  // signal), then shifted, then held.
  const ordered = [...result.tasks].sort((x, y) => {
    const rank = (k: TaskComparison['change']): number =>
      k === 'regressed' ? 0 : k === 'gained' ? 1 : k === 'shifted' ? 2 : k === 'added' ? 3 : k === 'removed' ? 4 : 5;
    return rank(x.change) - rank(y.change);
  });

  const idWidth = Math.max(...result.tasks.map((t) => t.instance_id.length), 20);
  for (const t of ordered) {
    const a = t.a;
    const b = t.b;
    const tag = t.change.toUpperCase().padEnd(9);
    let detail = '';
    if (a && b) {
      detail = `${shortDescribe(a)} → ${shortDescribe(b)}`;
    } else if (b) {
      detail = `(added) ${shortDescribe(b)}`;
    } else if (a) {
      detail = `(removed) ${shortDescribe(a)}`;
    }
    console.log(`  ${tag} ${t.instance_id.padEnd(idWidth)}  ${detail}`);
  }
  console.log('');
}

function shortDescribe(t: TaskClassification): string {
  const parts: string[] = [t.harness_status];
  if (t.failure_mode) parts.push(t.failure_mode);
  if (t.patch_bytes > 0) parts.push(`${(t.patch_bytes / 1024).toFixed(1)}KB`);
  return parts.join('/');
}
