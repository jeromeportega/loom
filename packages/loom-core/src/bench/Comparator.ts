import { BenchClassifier, type ClassifierOptions, type TaskClassification } from './Classifier.js';

/**
 * Per-task outcome change across two runs.
 *
 * - 'held'      — same harness status
 * - 'gained'    — A unresolved/empty → B resolved
 * - 'regressed' — A resolved → B unresolved/empty/errored
 * - 'shifted'   — both unresolved/empty but different status (e.g.
 *                 unresolved → empty-patch). Worth surfacing because
 *                 the failure shape changed even though the verdict
 *                 didn't.
 * - 'added'     — task in B but not A
 * - 'removed'   — task in A but not B
 */
export type ChangeKind =
  | 'held'
  | 'gained'
  | 'regressed'
  | 'shifted'
  | 'added'
  | 'removed';

export interface TaskComparison {
  instance_id: string;
  change: ChangeKind;
  a?: TaskClassification;
  b?: TaskClassification;
}

export interface RunComparison {
  a: { predictions_path: string };
  b: { predictions_path: string };
  tasks: TaskComparison[];
  summary: {
    resolved_a: number;
    resolved_b: number;
    delta: number;
    held: number;
    gained: number;
    regressed: number;
    shifted: number;
    added: number;
    removed: number;
  };
}

export interface ComparatorInputs {
  a: ClassifierOptions;
  b: ClassifierOptions;
}

/**
 * Two-run delta. Built on top of BenchClassifier so per-task tags
 * stay consistent with the standalone classify command. Output is
 * structured for both human reading (printed compactly) and machine
 * consumption (JSON).
 *
 * Surfaces what manual writeups have been doing by hand: which tasks
 * held, which regressed, which gained, which changed failure-mode
 * shape without changing the verdict. Replaces narrative prose with
 * mechanical comparison.
 */
export class BenchComparator {
  compare(inputs: ComparatorInputs): RunComparison {
    const classifier = new BenchClassifier();
    const aRun = classifier.classify(inputs.a);
    const bRun = classifier.classify(inputs.b);

    const aByID = new Map(aRun.tasks.map((t) => [t.instance_id, t]));
    const bByID = new Map(bRun.tasks.map((t) => [t.instance_id, t]));
    const all = new Set<string>([...aByID.keys(), ...bByID.keys()]);

    const tasks: TaskComparison[] = [];
    let held = 0;
    let gained = 0;
    let regressed = 0;
    let shifted = 0;
    let added = 0;
    let removed = 0;

    for (const id of [...all].sort()) {
      const a = aByID.get(id);
      const b = bByID.get(id);
      if (!a && b) {
        tasks.push({ instance_id: id, change: 'added', b });
        added += 1;
        continue;
      }
      if (a && !b) {
        tasks.push({ instance_id: id, change: 'removed', a });
        removed += 1;
        continue;
      }
      if (!a || !b) continue;

      const change = classifyChange(a, b);
      tasks.push({ instance_id: id, change, a, b });
      switch (change) {
        case 'held': held += 1; break;
        case 'gained': gained += 1; break;
        case 'regressed': regressed += 1; break;
        case 'shifted': shifted += 1; break;
        default: break;
      }
    }

    return {
      a: { predictions_path: inputs.a.predictionsPath },
      b: { predictions_path: inputs.b.predictionsPath },
      tasks,
      summary: {
        resolved_a: aRun.summary.resolved,
        resolved_b: bRun.summary.resolved,
        delta: bRun.summary.resolved - aRun.summary.resolved,
        held,
        gained,
        regressed,
        shifted,
        added,
        removed,
      },
    };
  }
}

function classifyChange(a: TaskClassification, b: TaskClassification): ChangeKind {
  const ax = a.harness_status;
  const bx = b.harness_status;
  if (ax === bx) {
    // Failure-mode tag could have shifted even if verdict didn't (e.g.
    // unresolved + under-editing → unresolved + over-engineering).
    // Don't tag as 'held' if the failure shape changed.
    if (ax !== 'resolved' && a.failure_mode !== b.failure_mode) return 'shifted';
    return 'held';
  }
  if (ax === 'resolved' && bx !== 'resolved') return 'regressed';
  if (ax !== 'resolved' && bx === 'resolved') return 'gained';
  // both non-resolved but different terminal status — empty-patch ↔
  // unresolved is a real shape change worth surfacing
  return 'shifted';
}
