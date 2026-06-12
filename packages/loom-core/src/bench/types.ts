import { z } from 'zod';

/**
 * One SWE-bench task row, narrowed to the four fields loom actually uses.
 * The published dataset has additional fields (patch, test_patch,
 * FAIL_TO_PASS, PASS_TO_PASS, environment_setup_commit, version) — the
 * official scorer reads them from its own copy of the dataset, not from
 * predictions.json, so loom does not need to validate or pass them
 * through.
 *
 * Note: the HuggingFace dataset-server response encodes array-valued
 * columns as JSON strings, which is why declaring optional `z.array`
 * fields on them would reject real HF data. Dropping them entirely sidesteps
 * the issue and keeps the schema robust to upstream shape drift.
 */
export const SweBenchTaskSchema = z
  .object({
    instance_id: z.string().min(1),
    repo: z.string().min(1),
    base_commit: z.string().min(7),
    problem_statement: z.string().min(1),
  })
  .passthrough();
export type SweBenchTask = z.infer<typeof SweBenchTaskSchema>;

/**
 * The shape the official SWE-bench harness consumes via `--predictions_path`.
 * `model_patch` is the unified diff loom's workers produced. An empty
 * patch is a valid prediction (it just won't resolve any tasks).
 */
export interface SweBenchPrediction {
  instance_id: string;
  model_patch: string;
  model_name_or_path: string;
}

/**
 * One task's outcome from the runner. The harness writes `predictions.json`
 * from the successful runs; `error` is non-empty when the task failed before
 * loom could produce a patch (clone, init, planning crash).
 */
export interface SweBenchTaskResult {
  instanceId: string;
  /** Empty when error is set; non-empty when loom produced anything. */
  patch: string;
  /** Story-branch commits loom made, for debugging. */
  commitCount: number;
  /** Wall-clock time spent on the task, ms. */
  durationMs: number;
  /** Set when the task failed before loom produced a patch. */
  error?: string;
  /**
   * Absolute path to the preserved tempdir when `preserveFailures` is on
   * AND this task failed (errored or empty patch). Operator can `cd` in
   * to inspect the worker state — particularly useful for "Worker exited
   * with code 1 and made no commits" mysteries where the worktree state
   * is the only forensic evidence.
   */
  preservedPath?: string;
}

export interface SweBenchReport {
  suite: 'swe-bench-lite';
  total: number;
  /** Tasks where loom produced a non-empty patch (NOT a resolution-rate). */
  produced: number;
  failed: number;
  results: SweBenchTaskResult[];
}
