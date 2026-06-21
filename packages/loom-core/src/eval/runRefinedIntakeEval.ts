import type { RefinedCaseResult, IntakeEvalCase, IntakeRunRecord } from './intakeEvalTypes.js';
import { runIntakeEval } from './runIntakeEval.js';
import type { RunIntakeEvalDeps } from './runIntakeEval.js';

/**
 * Runs the unchanged runIntakeEval over the ok refined cases and synthesizes
 * failure records for any refiner miss.  Output order matches the input
 * `refined` array exactly (same N — ADR-005).
 *
 * ok cases:   build refined IntakeEvalCase (brief := refined_brief, label untouched)
 *             and relay to the UNCHANGED runIntakeEval so both classifier and judge
 *             see the refined text (ADR-004).
 *
 * ok:false cases: synthesize an IntakeRunRecord whose classifier is
 *             { ok:false, reason:'llm_error', detail:`refiner: ${reason}` }
 *             so existing failure-counting excludes-but-counts it (ADR-005).
 */
export async function runRefinedIntakeEval(
  refined: RefinedCaseResult[],
  deps: RunIntakeEvalDeps,
): Promise<IntakeRunRecord[]> {
  // Collect ok cases while tracking their original positions.
  const okPositions: number[] = [];
  const okCases: IntakeEvalCase[] = [];
  for (let i = 0; i < refined.length; i++) {
    const r = refined[i];
    if (r.ok) {
      okPositions.push(i);
      okCases.push(r.case);
    }
  }

  // Replay the UNCHANGED runIntakeEval over all ok refined cases.
  const okRecords =
    okCases.length > 0 ? await runIntakeEval(okCases, deps) : [];

  // Reconstruct the full output array in original order.
  const results: IntakeRunRecord[] = new Array(refined.length);
  let okIdx = 0;

  for (let i = 0; i < refined.length; i++) {
    const r = refined[i];
    if (r.ok) {
      results[i] = okRecords[okIdx++];
    } else {
      // ADR-005: synthesize a failure record so the set keeps the same N.
      // The classifier is ok:false so the scorer will exclude-but-count it;
      // the stub case fields are never read by the scorer for failed records.
      results[i] = {
        case: {
          id: r.caseId,
          source: 'anchor',
          brief: `[refiner-failure:${r.caseId}]`,
          label: { type: 'feature', size: 'story' },
          rationale: '',
        },
        classifier: {
          ok: false,
          reason: 'llm_error',
          detail: `refiner: ${r.reason}`,
        },
        judge: {
          status: 'inconclusive',
          detail: 'classifier_failure: llm_error',
        },
      };
    }
  }

  return results;
}
