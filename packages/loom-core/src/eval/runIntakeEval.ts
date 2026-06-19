import { classifyIntake } from '../intake/IntakeClassifier.js';
import type { LLMClient } from '../llm/LLMClient.js';
import type {
  IntakeEvalCase,
  IntakeJudgeLike,
  IntakeRunRecord,
} from './intakeEvalTypes.js';

export interface RunIntakeEvalDeps {
  llm: LLMClient;
  classifierModel: string;
  judgeModel: string; // reserved: story-021-003 will forward this to the real IntakeJudge constructor
  judge: IntakeJudgeLike;
}

/**
 * Runs the Phase 0 IntakeClassifier on every case, injecting the judge for
 * per-case grading. Exactly one classifier call and one judge call per case
 * (NFR-1, FR-4, FR-6). When the classifier fails, the judge field is set to
 * inconclusive without calling the judge (no verdict to grade).
 */
export async function runIntakeEval(
  cases: IntakeEvalCase[],
  deps: RunIntakeEvalDeps,
): Promise<IntakeRunRecord[]> {
  const records: IntakeRunRecord[] = [];

  for (const evalCase of cases) {
    // Exactly one classifier call per case (NFR-1, FR-4). Catch thrown exceptions
    // (network errors, API 500s) and convert them to {ok:false} so the run
    // continues for remaining cases rather than aborting mid-set.
    let classifier: Awaited<ReturnType<typeof classifyIntake>>;
    try {
      classifier = await classifyIntake(evalCase.brief, {
        llm: deps.llm,
        model: deps.classifierModel,
      });
    } catch (err) {
      classifier = {
        ok: false,
        reason: 'llm_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // Exactly one judge call per case when classifier succeeds (NFR-1, FR-6).
    // Classifier failure → inconclusive without calling the judge (no verdict to grade).
    const judge = classifier.ok
      ? await deps.judge.judge(evalCase.brief, classifier.verdict)
      : { status: 'inconclusive' as const, detail: `classifier_failure: ${classifier.reason}` };

    records.push({ case: evalCase, classifier, judge });
  }

  return records;
}

/**
 * Computes per-axis exact-match accuracy of classifier verdicts vs human labels.
 * Classifier failures are excluded from the scored count and never credited as
 * correct (FR-5).
 */
export function computeAxisAccuracy(
  records: IntakeRunRecord[],
  axis: 'type' | 'size',
): { correct: number; scored: number } {
  let correct = 0;
  let scored = 0;
  for (const rec of records) {
    if (!rec.classifier.ok) continue; // classifier failure: excluded (FR-5)
    const predicted = rec.classifier.verdict[axis];
    const labeled = rec.case.label[axis];
    scored++;
    if (predicted === labeled) correct++;
  }
  return { correct, scored };
}
