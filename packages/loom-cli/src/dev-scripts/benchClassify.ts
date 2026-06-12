import fs from 'node:fs';
import path from 'node:path';
import { BenchClassifier, type RunClassification, type TaskClassification } from '@loom-ai/core';

export interface BenchClassifyOptions {
  /** Path to the harness report (loom.loom-<runid>.json). */
  report?: string;
  /**
   * Either an explicit manifest file (preferred — written by future bench
   * runs) OR a glob/root scanned for preserved tempdirs. We accept both.
   */
  manifest?: string;
  /**
   * Newline-separated 'instance_id<TAB>tempdir' pairs supplied at the
   * command line. Lets the operator wire up Run 10e/f outputs without
   * a manifest file.
   */
  tempdirs?: string[];
  /** When true, emit JSON instead of the human-readable text report. */
  json?: boolean;
}

/**
 * `loom bench classify` — read a predictions.json + (optionally) a
 * harness report and preserved-tempdir set; print a structured per-task
 * classification with failure-mode tags.
 *
 * Visibility tool, not a measurement tool. The tags are heuristic; their
 * job is to make the failure-mode distribution mechanically reproducible
 * across runs instead of buried in narrative runbook prose.
 */
export function runBenchClassify(
  predictionsPath: string,
  opts: BenchClassifyOptions = {},
): void {
  if (!fs.existsSync(predictionsPath)) {
    console.error(`  predictions file not found: ${predictionsPath}`);
    process.exit(1);
  }

  const tempdirs = resolveTempdirs(opts);
  const classifier = new BenchClassifier();
  const result = classifier.classify({
    predictionsPath: path.resolve(predictionsPath),
    reportPath: opts.report ? path.resolve(opts.report) : undefined,
    tempdirs,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  printText(result);
}

/**
 * Builds the instance_id → tempdir map from any of:
 *   --tempdirs id=path[,id=path]... (CLI repeatable)
 *   --manifest <path>               (sidecar JSON written by future bench)
 */
function resolveTempdirs(opts: BenchClassifyOptions): Record<string, string> | undefined {
  const out: Record<string, string> = {};

  if (opts.manifest) {
    const manifestPath = path.resolve(opts.manifest);
    if (!fs.existsSync(manifestPath)) {
      console.error(`  manifest file not found: ${manifestPath}`);
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    if (Array.isArray(raw)) {
      // shape: [{ instance_id, tempdir }, ...]
      for (const row of raw as Array<{ instance_id?: string; tempdir?: string }>) {
        if (row.instance_id && row.tempdir) out[row.instance_id] = row.tempdir;
      }
    } else if (raw && typeof raw === 'object') {
      // shape: { instance_id: tempdir }
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
    }
  }

  for (const spec of opts.tempdirs ?? []) {
    for (const pair of spec.split(',')) {
      const [id, p] = pair.split('=', 2);
      if (id && p) out[id.trim()] = p.trim();
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function printText(result: RunClassification): void {
  console.log('');
  console.log(`  ${result.predictions_path}`);
  if (result.report_path) console.log(`  report: ${result.report_path}`);
  console.log(`  ${result.tasks.length} task(s)`);
  console.log('');

  const widthId = Math.max(
    ...result.tasks.map((t) => t.instance_id.length),
    20,
  );

  for (const t of result.tasks) {
    const mark = statusMark(t.harness_status);
    const tag = t.failure_mode ?? '';
    const size = t.patch_bytes > 0 ? `${(t.patch_bytes / 1024).toFixed(1)} KB` : '0 KB';
    const stories = t.story_count != null ? `${t.story_count}s` : '-';
    const tools = formatToolsTerse(t.tool_histogram);
    console.log(
      `  ${mark} ${t.instance_id.padEnd(widthId)}  ${t.harness_status.padEnd(11)} ` +
        `${tag.padEnd(18)}  ${size.padStart(9)}  ${stories.padStart(3)}  ${tools}`,
    );
  }

  console.log('');
  console.log(
    `  Resolution: ${result.summary.resolved}/${result.summary.total} ` +
      `(${((result.summary.resolved / Math.max(1, result.summary.total)) * 100).toFixed(0)}%)`,
  );
  if (result.summary.empty_patch > 0) {
    console.log(`  Empty patches: ${result.summary.empty_patch}`);
  }
  if (result.summary.errored > 0) {
    console.log(`  Errored: ${result.summary.errored}`);
  }
  if (Object.keys(result.summary.failure_modes).length > 0) {
    console.log('');
    console.log('  Failure modes:');
    const sorted = Object.entries(result.summary.failure_modes).sort((a, b) => b[1] - a[1]);
    for (const [mode, n] of sorted) {
      console.log(`    ${mode.padEnd(18)}  ${n}`);
    }
  }
  console.log('');
}

function statusMark(s: TaskClassification['harness_status']): string {
  if (s === 'resolved') return '✓';
  if (s === 'empty-patch') return '–';
  if (s === 'errored') return '!';
  if (s === 'unresolved') return '✗';
  return '?';
}

function formatToolsTerse(h: Record<string, number> | undefined): string {
  if (!h || Object.keys(h).length === 0) return '';
  // Show edit-class calls compactly when present — that's the load-bearing
  // distinction for the analysis-only mode.
  const edits = (h.Edit ?? 0) + (h.MultiEdit ?? 0);
  const writes = h.Write ?? 0;
  const bash = h.Bash ?? 0;
  return `B${bash}/E${edits}/W${writes}`;
}
