import { z } from 'zod';
// IntakeClassifier.ts is a Phase-0 seam (already delivered); if it ever moves,
// this import will fail at compile time — do not suppress the error, fix the path.
import type { ClassifyResult, IntakeVerdict } from '../intake/IntakeClassifier.js';

export type { ClassifyResult, IntakeVerdict };

// --- Fixture case (story-021-001 authors the data; this is its shape) ---
export const IntakeEvalCaseSchema = z.object({
  id:           z.string(),                         // 'epic-007' | 'anchor-obvious-bug'
  source:       z.enum(['epic', 'anchor']),
  brief:        z.string().min(1),
  // provenance path for epic cases, e.g. '.loom/planning/epic-007/project-brief.md'.
  // For source:'anchor' cases the sentinel value is the string "anchor" (not a file path).
  brief_source: z.string().optional(),
  label: z.object({
    type: z.enum(['feature', 'bug', 'chore']),
    size: z.enum(['story', 'epic']),
  }),
  rationale:    z.string().min(1),
  /**
   * @deprecated Evidence only — the scorer MUST NOT read this field to determine size.
   * Use label.size as the ground truth (FR-3, ADR-004). This field is retained for
   * human reference only and may be absent on any case.
   */
  story_count:  z.number().int().optional(),
});
export const IntakeEvalSetSchema = z.object({ cases: z.array(IntakeEvalCaseSchema).min(1) });
export type IntakeEvalCase = z.infer<typeof IntakeEvalCaseSchema>;
export type IntakeEvalSet  = z.infer<typeof IntakeEvalSetSchema>;

// --- Judge result + outcome (shape pinned here; behavior lives in IntakeJudge.ts) ---
export const IntakeJudgeResultSchema = z.object({
  type:  z.enum(['feature', 'bug', 'chore']),       // judge's INDEPENDENT classification
  size:  z.enum(['story', 'epic']),
  grade: z.enum(['agree', 'disagree']),             // grades the classifier verdict + rationale
  reason: z.string().default(''),
});
export type IntakeJudgeResult = z.infer<typeof IntakeJudgeResultSchema>;

export type JudgeOutcome =
  | { status: 'ok';           result: IntakeJudgeResult }
  | { status: 'inconclusive'; detail: string };     // FR-9: outage/parse-fail → inconclusive, NEVER agreement

// --- Injection seam so runIntakeEval (002) need not import IntakeJudge (003) ---
export interface IntakeJudgeLike {
  judge(brief: string, verdict: IntakeVerdict): Promise<JudgeOutcome>;
}

// --- Per-case record + report (scorer/renderer in 004 consume these) ---
export interface IntakeRunRecord {
  case: IntakeEvalCase;
  classifier: ClassifyResult;   // exactly one classifier call per case (NFR-1, FR-4)
  judge: JudgeOutcome;          // exactly one judge call per case (NFR-1, FR-6)
}

export interface ConfusionMatrix {
  axis: 'type' | 'size';
  labels: string[];                                 // type: ['feature','bug','chore']; size: ['story','epic']
  counts: Record<string, Record<string, number>>;   // counts[labeled][predicted], RAW counts only (FR-10)
}

export interface AxisReport {
  axis: 'type' | 'size';
  accuracy: { correct: number; scored: number };    // exact-match vs human (FR-5)
  confusion: ConfusionMatrix;
  judgeVsClassifier: { agree: number; disagree: number; inconclusive: number };
  judgeVsHuman:      { agree: number; disagree: number; inconclusive: number };  // FR-7
  disagreements: Array<{ caseId: string; labeled: string; predicted: string; judge: string; rationale: string }>;
  dangerousConfusions: Array<{ from: string; to: string; count: number; caseIds: string[] }>;
  verdict: { clearsBar: boolean; statement: string };
}

export interface IntakeEvalReport {
  generatedFromCases: number;
  classifierModel: string;
  judgeModel: string;
  axes: AxisReport[];           // exactly one per axis: 'type', then 'size'
  inconclusiveJudgeCount: number;
  overall: {
    /**
     * @deprecated Use `gate.decision` as the authoritative go/no-go signal.
     * This field reflects only the per-axis quality bar (dangerous confusions)
     * and does not account for minimum scored-case thresholds or failure rates.
     * It may be `true` even when `gate.decision` is `'inconclusive'`.
     */
    proceed: boolean;
    statement: string;
  };
  // Fields below are read by the gate reporter — removing them is a breaking change.
  failureCounts: {
    classifier: Record<'llm_error' | 'timeout' | 'invalid_output', number>;
    /** Total inconclusive judge outcomes, including those caused by classifier failures. */
    judgeInconclusive: number;
  };
  scoredCases: number;          // cases with ok classifier AND conclusive judge
  gate: {
    decision: 'proceed' | 'do-not-proceed' | 'inconclusive';
    statement: string;
    minScoredCases: number;     // justified threshold; gate fails closed below this count
    maxFailureRate: number;     // justified threshold; gate fires inconclusive above this rate
  };
}
