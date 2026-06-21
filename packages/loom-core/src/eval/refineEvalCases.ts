import type { IntakeEvalCase, RefinedCaseResult } from './intakeEvalTypes.js';
import type { BriefRefiner } from '../brief/BriefRefiner.js';

/**
 * Pre-processes each eval case through the production BriefRefiner (one call
 * per case, FR-2).  Returns a RefinedCaseResult for every input case — same N
 * and same order — so the side-by-side scoring stays aligned (ADR-005).
 *
 * ok:true  → brief replaced with refinement.refined_brief; label untouched (ADR-003).
 * ok:false → caseId preserved so the caller can synthesize a failure record.
 */
export async function refineEvalCases(
  cases: IntakeEvalCase[],
  refiner: BriefRefiner,
): Promise<RefinedCaseResult[]> {
  const results: RefinedCaseResult[] = [];
  for (const c of cases) {
    try {
      const refinement = await refiner.refine(c.brief);
      if (!refinement.refined_brief) {
        results.push({
          ok: false,
          caseId: c.id,
          reason: 'no_refined_brief',
          detail: `refiner returned no refined_brief for case "${c.id}"`,
        });
      } else {
        results.push({
          ok: true,
          case: { ...c, brief: refinement.refined_brief },
          qualityScore: refinement.quality_score,
        });
      }
    } catch (err) {
      results.push({
        ok: false,
        caseId: c.id,
        reason: 'refiner_error',
        detail: (err as Error).message,
      });
    }
  }
  return results;
}
