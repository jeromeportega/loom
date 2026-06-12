import { BenchClassifier, type ClassifierOptions, type TaskClassification } from './Classifier.js';

/** One run's input set — predictions + (optional) report + (optional) tempdirs. */
export type RunInput = ClassifierOptions;

/** Per-task outcome distribution across K runs. */
export interface TaskVariance {
  instance_id: string;
  /** Counts of each harness_status seen across the K runs. */
  status_counts: Partial<Record<TaskClassification['harness_status'], number>>;
  /** Counts of each failure_mode seen. Undefined modes counted under '(unset)'. */
  mode_counts: Record<string, number>;
  /** Number of runs in which this task appeared. */
  runs_present: number;
  /**
   * Resolution rate as a fraction (0-1). Useful for the operator's
   * gut-check: "this task resolves 3/5 of the time" is the variance
   * the strategic pivot from intervention iteration to measurement
   * infrastructure was about.
   */
  resolution_rate: number;
}

export interface VarianceReport {
  runs: number;
  tasks: TaskVariance[];
  summary: {
    /** Tasks whose resolution rate is exactly 1.0 across all runs they appeared in. */
    consistently_resolved: number;
    /** Resolution rate exactly 0.0 across all runs they appeared in. */
    consistently_unresolved: number;
    /** Tasks with mixed outcomes — these are the variance source. */
    inconsistent: number;
    /** Mean of resolution_rate across all tasks. */
    mean_resolution_rate: number;
  };
}

/**
 * Quantifies the noise floor of the loom pipeline by aggregating
 * outcome counts across K parallel runs of the same task set. The
 * strategic motivation: Run 9, 10d, 10e, 10f all showed signs of high
 * variance masking intervention signal. With K runs of one config we
 * can SEE the variance instead of guessing at it.
 *
 * Usage (typical): operator runs the same bench config K times against
 * the same task file, collects the K predictions.json + K harness
 * report.json pairs, hands them to this analyzer. Output: which tasks
 * are consistently resolved, which are consistently unresolved, and
 * which flip — that last set is where the variance lives.
 */
export class BenchVariance {
  analyze(runs: RunInput[]): VarianceReport {
    if (runs.length === 0) {
      return {
        runs: 0,
        tasks: [],
        summary: {
          consistently_resolved: 0,
          consistently_unresolved: 0,
          inconsistent: 0,
          mean_resolution_rate: 0,
        },
      };
    }
    const classifier = new BenchClassifier();
    const perRun = runs.map((r) => classifier.classify(r));

    // Pivot: instance_id → array of TaskClassification across runs
    const byID = new Map<string, TaskClassification[]>();
    for (const run of perRun) {
      for (const task of run.tasks) {
        let arr = byID.get(task.instance_id);
        if (!arr) {
          arr = [];
          byID.set(task.instance_id, arr);
        }
        arr.push(task);
      }
    }

    const tasks: TaskVariance[] = [];
    for (const [instance_id, classifications] of [...byID.entries()].sort()) {
      const status_counts: TaskVariance['status_counts'] = {};
      const mode_counts: Record<string, number> = {};
      let resolved = 0;
      for (const c of classifications) {
        status_counts[c.harness_status] = (status_counts[c.harness_status] ?? 0) + 1;
        const mode = c.failure_mode ?? '(unset)';
        mode_counts[mode] = (mode_counts[mode] ?? 0) + 1;
        if (c.harness_status === 'resolved') resolved += 1;
      }
      tasks.push({
        instance_id,
        status_counts,
        mode_counts,
        runs_present: classifications.length,
        resolution_rate: resolved / classifications.length,
      });
    }

    let consistently_resolved = 0;
    let consistently_unresolved = 0;
    let inconsistent = 0;
    let mean = 0;
    for (const t of tasks) {
      if (t.resolution_rate === 1) consistently_resolved += 1;
      else if (t.resolution_rate === 0) consistently_unresolved += 1;
      else inconsistent += 1;
      mean += t.resolution_rate;
    }
    mean = tasks.length > 0 ? mean / tasks.length : 0;

    return {
      runs: runs.length,
      tasks,
      summary: {
        consistently_resolved,
        consistently_unresolved,
        inconsistent,
        mean_resolution_rate: mean,
      },
    };
  }
}
