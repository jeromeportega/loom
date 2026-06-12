import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Per-task classification — harness verdict plus a heuristic failure-mode
 * tag when forensics are available. The tags are intentionally coarse;
 * they're the structured equivalent of the failure-mode language used in
 * runbook writeups (under-editing / over-engineering / analysis-only /
 * planner-cascade / reviewer-error). Heuristics are approximate, not
 * deterministic — they're for *visibility*, not for promote/revert
 * decisions on their own.
 */
export interface TaskClassification {
  instance_id: string;
  harness_status: 'resolved' | 'unresolved' | 'empty-patch' | 'errored' | 'unknown';
  failure_mode?:
    | 'under-editing'
    | 'over-engineering'
    | 'analysis-only'
    | 'planner-cascade'
    | 'reviewer-error';
  /** Bytes of model_patch in the predictions file (0 for empty patches). */
  patch_bytes: number;
  /** Number of stories the planner produced for this task. */
  story_count?: number;
  /** Aggregate tool-call counts from decision_traces, keyed by tool name. */
  tool_histogram?: Record<string, number>;
  /**
   * Path to the preserved bench tempdir, when --preserve-all / --preserve-failures
   * was on AND the tempdir was provided to the classifier. Without this,
   * failure-mode tags fall back to the patch-size heuristic only.
   */
  preserved_tempdir?: string;
  /** Free-form one-line bullets describing the basis for the classification. */
  evidence: string[];
}

export interface RunClassification {
  predictions_path: string;
  report_path?: string;
  tasks: TaskClassification[];
  summary: {
    total: number;
    resolved: number;
    unresolved: number;
    empty_patch: number;
    errored: number;
    failure_modes: Record<string, number>;
  };
}

/** SWE-bench harness report shape (subset). */
interface HarnessReport {
  resolved_ids?: string[];
  unresolved_ids?: string[];
  empty_patch_ids?: string[];
  error_ids?: string[];
}

/** Bench predictions file row. */
interface PredictionRow {
  instance_id: string;
  model_name_or_path?: string;
  model_patch?: string;
}

export interface ClassifierOptions {
  /** Absolute path to the bench predictions.json file. Required. */
  predictionsPath: string;
  /**
   * Optional path to the harness report (loom.loom-<runid>.json). When
   * absent, harness_status is 'unknown' and resolved-vs-unresolved can't
   * be reported; patch-bytes alone tell us empty-patch vs not.
   */
  reportPath?: string;
  /**
   * Optional map from instance_id → preserved tempdir path. Without this,
   * failure-mode tags fall back to the patch-size heuristic. With it,
   * the classifier reads each tempdir's loom.db to enrich the tags with
   * the worker's tool histogram + story shape.
   */
  tempdirs?: Record<string, string>;
}

/**
 * Reads bench predictions + harness report + (optionally) preserved
 * tempdirs and produces a structured RunClassification. The goal is to
 * replace the manual runbook-writeup pass with mechanical, repeatable
 * output — so cross-run comparisons are easy and failure-mode
 * distributions can be tracked over time.
 */
export class BenchClassifier {
  classify(opts: ClassifierOptions): RunClassification {
    const predictions = readPredictions(opts.predictionsPath);
    const report = opts.reportPath ? readReport(opts.reportPath) : undefined;
    const tasks: TaskClassification[] = [];

    for (const pred of predictions) {
      const harness_status = resolveHarnessStatus(pred.instance_id, report);
      const patch_bytes = (pred.model_patch ?? '').length;
      const tempdir = opts.tempdirs?.[pred.instance_id];
      const evidence: string[] = [];

      // Pull worker forensics from the preserved tempdir when available.
      let story_count: number | undefined;
      let tool_histogram: Record<string, number> | undefined;
      let any_review_errored = false;
      let first_story_failed_others_blocked = false;
      if (tempdir) {
        const stats = readTempdirStats(tempdir);
        story_count = stats.story_count;
        tool_histogram = stats.tool_histogram;
        any_review_errored = stats.any_review_errored;
        first_story_failed_others_blocked = stats.first_story_failed_others_blocked;
        evidence.push(
          `tempdir: ${tempdir}`,
          `stories: ${story_count}`,
          `tools: ${formatHistogram(tool_histogram)}`,
        );
        if (any_review_errored) evidence.push('review_status=errored on at least one story');
      } else {
        evidence.push(`patch_bytes: ${patch_bytes}`);
      }

      const failure_mode = classifyFailureMode({
        harness_status,
        patch_bytes,
        tool_histogram,
        any_review_errored,
        first_story_failed_others_blocked,
      });
      if (failure_mode) {
        evidence.push(`classification: ${failure_mode}`);
      }

      tasks.push({
        instance_id: pred.instance_id,
        harness_status,
        ...(failure_mode ? { failure_mode } : {}),
        patch_bytes,
        ...(story_count != null ? { story_count } : {}),
        ...(tool_histogram ? { tool_histogram } : {}),
        ...(tempdir ? { preserved_tempdir: tempdir } : {}),
        evidence,
      });
    }

    return {
      predictions_path: opts.predictionsPath,
      ...(opts.reportPath ? { report_path: opts.reportPath } : {}),
      tasks,
      summary: summarize(tasks),
    };
  }
}

function readPredictions(p: string): PredictionRow[] {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`predictions file must be a JSON array of {instance_id, ...} rows`);
  }
  return raw as PredictionRow[];
}

function readReport(p: string): HarnessReport {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as HarnessReport;
}

function resolveHarnessStatus(
  instance_id: string,
  report: HarnessReport | undefined,
): TaskClassification['harness_status'] {
  if (!report) return 'unknown';
  if (report.resolved_ids?.includes(instance_id)) return 'resolved';
  if (report.empty_patch_ids?.includes(instance_id)) return 'empty-patch';
  if (report.error_ids?.includes(instance_id)) return 'errored';
  if (report.unresolved_ids?.includes(instance_id)) return 'unresolved';
  return 'unknown';
}

/**
 * Reads one tempdir's loom.db and returns the aggregates the classifier
 * uses. Defensive — a missing or stale DB returns sensible defaults
 * rather than throwing, so a partial set of preserved tempdirs still
 * produces useful output.
 */
function readTempdirStats(tempdir: string): {
  story_count: number;
  tool_histogram: Record<string, number>;
  any_review_errored: boolean;
  first_story_failed_others_blocked: boolean;
} {
  const defaults = {
    story_count: 0,
    tool_histogram: {} as Record<string, number>,
    any_review_errored: false,
    first_story_failed_others_blocked: false,
  };
  const dbPath = path.join(tempdir, '.loom', 'loom.db');
  if (!fs.existsSync(dbPath)) return defaults;

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const agentsRaw = db
      .prepare('SELECT story_id, status, review_status FROM agents ORDER BY story_id')
      .all() as Array<{ story_id: string; status: string; review_status: string | null }>;
    const story_count = agentsRaw.length;
    const any_review_errored = agentsRaw.some((r) => r.review_status === 'errored');

    // Planner-cascade signal: story-001-001 failed AND every other story is blocked.
    const first = agentsRaw[0];
    const rest = agentsRaw.slice(1);
    const first_story_failed_others_blocked =
      story_count >= 2 &&
      first?.status === 'failed' &&
      rest.every((r) => r.status === 'blocked');

    const tool_histogram: Record<string, number> = {};
    const traces = db
      .prepare(
        "SELECT subject FROM decision_traces WHERE kind = 'tool_intent' AND subject IS NOT NULL",
      )
      .all() as Array<{ subject: string }>;
    for (const t of traces) {
      tool_histogram[t.subject] = (tool_histogram[t.subject] ?? 0) + 1;
    }

    return {
      story_count,
      tool_histogram,
      any_review_errored,
      first_story_failed_others_blocked,
    };
  } catch {
    return defaults;
  } finally {
    db?.close();
  }
}

/**
 * Heuristic failure-mode classifier. Order matters — earlier branches
 * are more specific signals. Each tag corresponds to a failure pattern
 * documented in the testing runbook; future tags should mirror those.
 */
function classifyFailureMode(args: {
  harness_status: TaskClassification['harness_status'];
  patch_bytes: number;
  tool_histogram?: Record<string, number>;
  any_review_errored: boolean;
  first_story_failed_others_blocked: boolean;
}): TaskClassification['failure_mode'] | undefined {
  if (args.harness_status === 'resolved') return undefined;

  // Reviewer-error: the reviewer crashed and the worker's commits may
  // have been salvaged or lost depending on the cascade-fix being in
  // place. Hard signal from the agents table.
  if (args.any_review_errored) return 'reviewer-error';

  // Planner-cascade: story-001-001 failed and the rest blocked on it.
  if (args.first_story_failed_others_blocked) return 'planner-cascade';

  // Analysis-only requires positive evidence from the tool histogram.
  // Without a tempdir we can't distinguish analysis-only from
  // planner-cascade or a worker crash, so we leave the failure_mode
  // unset and let the operator inspect via the harness 'empty-patch'
  // status alone.
  if (args.harness_status === 'empty-patch') {
    const editCalls = totalEditCalls(args.tool_histogram);
    if (editCalls !== undefined && editCalls <= 1) {
      return 'analysis-only';
    }
    return undefined;
  }

  if (args.harness_status === 'unresolved') {
    // Over-engineering: very large patch suggests algorithm replacement.
    // 30 KB is the rough threshold from django-11019's 458-line rewrite;
    // adjust as the corpus grows.
    if (args.patch_bytes >= 30_000) return 'over-engineering';
    return 'under-editing';
  }

  return undefined;
}

function totalEditCalls(h: Record<string, number> | undefined): number | undefined {
  if (!h) return undefined;
  return (h.Edit ?? 0) + (h.MultiEdit ?? 0) + (h.Write ?? 0);
}

function formatHistogram(h: Record<string, number>): string {
  return Object.entries(h)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
}

function summarize(tasks: TaskClassification[]): RunClassification['summary'] {
  const failure_modes: Record<string, number> = {};
  let resolved = 0;
  let unresolved = 0;
  let empty_patch = 0;
  let errored = 0;
  for (const t of tasks) {
    if (t.harness_status === 'resolved') resolved += 1;
    else if (t.harness_status === 'unresolved') unresolved += 1;
    else if (t.harness_status === 'empty-patch') empty_patch += 1;
    else if (t.harness_status === 'errored') errored += 1;
    if (t.failure_mode) {
      failure_modes[t.failure_mode] = (failure_modes[t.failure_mode] ?? 0) + 1;
    }
  }
  return {
    total: tasks.length,
    resolved,
    unresolved,
    empty_patch,
    errored,
    failure_modes,
  };
}
