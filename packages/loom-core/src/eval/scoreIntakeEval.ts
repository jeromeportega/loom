import { computeAxisAccuracy } from './runIntakeEval.js';
import { computeJudgeVsHumanAgreement } from './IntakeJudge.js';
import type {
  IntakeRunRecord,
  IntakeEvalReport,
  AxisReport,
  ConfusionMatrix,
  GateDecision,
} from './intakeEvalTypes.js';

const TYPE_LABELS: ReadonlyArray<string> = ['feature', 'bug', 'chore'];
const SIZE_LABELS: ReadonlyArray<string> = ['story', 'epic'];

const THRESHOLDS = {
  minScoredCases: 18,
  maxClassifierFailureRate: 0.10,
  maxJudgeInconclusiveRate: 0.10,
} as const;

function buildConfusionMatrix(
  records: IntakeRunRecord[],
  axis: 'type' | 'size',
): ConfusionMatrix {
  const labels = axis === 'type' ? [...TYPE_LABELS] : [...SIZE_LABELS];

  // Initialize all cells to 0 — ensures all labels appear even with count 0 (FR-10)
  const counts: Record<string, Record<string, number>> = {};
  for (const lab of labels) {
    counts[lab] = {};
    for (const pred of labels) {
      counts[lab][pred] = 0;
    }
  }

  for (const rec of records) {
    if (!rec.classifier.ok) continue;
    const labeled = rec.case.label[axis];
    const predicted = rec.classifier.verdict[axis];
    counts[labeled][predicted] += 1;
  }

  return { axis, labels, counts };
}

function buildJudgeVsClassifier(
  records: IntakeRunRecord[],
  axis: 'type' | 'size',
): { agree: number; disagree: number; inconclusive: number } {
  let agree = 0;
  let disagree = 0;
  let inconclusive = 0;

  for (const rec of records) {
    if (rec.judge.status === 'inconclusive') {
      inconclusive++;
      continue;
    }
    if (!rec.classifier.ok) continue;
    if (rec.judge.result[axis] === rec.classifier.verdict[axis]) {
      agree++;
    } else {
      disagree++;
    }
  }

  return { agree, disagree, inconclusive };
}

function buildDisagreements(
  records: IntakeRunRecord[],
  axis: 'type' | 'size',
): Array<{ caseId: string; labeled: string; predicted: string; judge: string; rationale: string }> {
  const result: Array<{ caseId: string; labeled: string; predicted: string; judge: string; rationale: string }> = [];

  for (const rec of records) {
    if (!rec.classifier.ok || rec.judge.status !== 'ok') continue;
    // Disagreement = judge label differs from human label (mirrors judgeVsHuman.disagree count).
    if (rec.judge.result[axis] !== rec.case.label[axis]) {
      result.push({
        caseId: rec.case.id,
        labeled: rec.case.label[axis],
        predicted: rec.classifier.verdict[axis],
        judge: rec.judge.result[axis],
        rationale: rec.judge.result.reason,
      });
    }
  }

  return result;
}

function buildDangerousConfusions(
  records: IntakeRunRecord[],
  axis: 'type' | 'size',
): Array<{ from: string; to: string; count: number; caseIds: string[] }> {
  // Only the size axis has a defined dangerous confusion (ADR-006, asymmetric-cost rule).
  // Epic labeled → story predicted is the costly under-sizing cell.
  if (axis !== 'size') return [];

  const caseIds: string[] = [];
  for (const rec of records) {
    if (!rec.classifier.ok) continue;
    if (rec.case.label.size === 'epic' && rec.classifier.verdict.size === 'story') {
      caseIds.push(rec.case.id);
    }
  }

  if (caseIds.length === 0) return [];
  return [{ from: 'epic', to: 'story', count: caseIds.length, caseIds }];
}

function buildVerdict(
  axis: 'type' | 'size',
  dangerousConfusions: Array<{ from: string; to: string; count: number; caseIds: string[] }>,
): { clearsBar: boolean; statement: string } {
  const totalDangerous = dangerousConfusions.reduce((sum, d) => sum + d.count, 0);
  const clearsBar = totalDangerous === 0;

  if (axis === 'size') {
    const count = dangerousConfusions.find(d => d.from === 'epic' && d.to === 'story')?.count ?? 0;
    const statement = count === 0
      ? `Size axis: 0 epic→story under-sizing confusions detected. Clears Phase 1 bar.`
      : `Size axis: ${count} epic→story under-sizing confusion(s) detected. Does NOT clear Phase 1 bar — costly under-sizing present.`;
    return { clearsBar, statement };
  } else {
    const statement = `Type axis: ${totalDangerous} dangerous confusion(s) detected. ${clearsBar ? 'Clears' : 'Does not clear'} Phase 1 bar.`;
    return { clearsBar, statement };
  }
}

function buildAxisReport(records: IntakeRunRecord[], axis: 'type' | 'size'): AxisReport {
  const accuracy = computeAxisAccuracy(records, axis);
  const confusion = buildConfusionMatrix(records, axis);
  const judgeVsClassifier = buildJudgeVsClassifier(records, axis);
  const judgeVsHuman = computeJudgeVsHumanAgreement(records, axis);
  const disagreements = buildDisagreements(records, axis);
  const dangerousConfusions = buildDangerousConfusions(records, axis);
  const verdict = buildVerdict(axis, dangerousConfusions);

  return { axis, accuracy, confusion, judgeVsClassifier, judgeVsHuman, disagreements, dangerousConfusions, verdict };
}

/**
 * Pure gate function: decides the tri-state outcome given a completed (minus overall) report.
 * PROCEED is unreachable unless scored ≥ minScoredCases. The decision order is:
 *   1. scored < minScoredCases           → INCONCLUSIVE
 *   2. classifierFailureRate > threshold  → DO_NOT_PROCEED
 *   3. judgeInconclusiveRate > threshold  → INCONCLUSIVE
 *   4. any axis fails to clear bar        → DO_NOT_PROCEED
 *   5. else                               → PROCEED
 *
 * Priority rationale (ADR-013): step 1 (insufficient data) gates before failure-rate checks,
 * so a run with scored=0 always exits as INCONCLUSIVE even when the classifier failure rate
 * is 100%. This is intentional: when there is no data we cannot confirm the classifier is
 * broken — it may simply not have run. Steps 2 and 3 are ordered so a high classifier failure
 * rate (DO_NOT_PROCEED) takes precedence over a high judge inconclusive rate (INCONCLUSIVE),
 * because a broken classifier makes the judge signal unreliable.
 */
export function decideGate(
  report: Omit<IntakeEvalReport, 'overall'>,
): { decision: GateDecision; statement: string } {
  const { failureCounts, thresholds, inconclusiveJudgeCount, axes } = report;
  const { scored, total, timeout, invalid_output, llm_error } = failureCounts;
  const { minScoredCases, maxClassifierFailureRate, maxJudgeInconclusiveRate } = thresholds;

  const failureSummary = `timeout=${timeout}, invalid_output=${invalid_output}, llm_error=${llm_error}`;

  if (scored < minScoredCases) {
    return {
      decision: 'INCONCLUSIVE',
      statement: `INCONCLUSIVE: only ${scored} of ${total} case(s) scored (minimum ${minScoredCases} required). Failure breakdown: ${failureSummary}.`,
    };
  }

  // total >= scored >= minScoredCases is guaranteed at this point; the total === 0 branch is unreachable
  const classifierFailureRate = (total - scored) / total;
  if (classifierFailureRate > maxClassifierFailureRate) {
    const failedCount = total - scored;
    return {
      decision: 'DO_NOT_PROCEED',
      statement: `DO NOT PROCEED: classifier failure rate ${(classifierFailureRate * 100).toFixed(1)}% exceeds ${(maxClassifierFailureRate * 100).toFixed(1)}% threshold (${failedCount} of ${total} cases failed). Failure breakdown: ${failureSummary}.`,
    };
  }

  const judgeInconclusiveRate = scored > 0 ? inconclusiveJudgeCount / scored : 0;
  if (judgeInconclusiveRate > maxJudgeInconclusiveRate) {
    return {
      decision: 'INCONCLUSIVE',
      statement: `INCONCLUSIVE: judge inconclusive rate ${(judgeInconclusiveRate * 100).toFixed(1)}% exceeds ${(maxJudgeInconclusiveRate * 100).toFixed(1)}% threshold (${inconclusiveJudgeCount} of ${scored} scored cases inconclusive).`,
    };
  }

  const typeAxis = axes.find(a => a.axis === 'type');
  const sizeAxis = axes.find(a => a.axis === 'size');
  if (!typeAxis || !sizeAxis) throw new Error('decideGate: axes must include both "type" and "size" AxisReport entries');
  if (!typeAxis.verdict.clearsBar || !sizeAxis.verdict.clearsBar) {
    const failingAxes = [typeAxis, sizeAxis].filter(a => !a.verdict.clearsBar);
    const reasons = failingAxes.map(a => a.verdict.statement).join('; ');
    return {
      decision: 'DO_NOT_PROCEED',
      statement: `DO NOT PROCEED: axis bar(s) not cleared across ${scored} scored cases. ${reasons}`,
    };
  }

  const totalDangerous = axes.reduce((n, a) => n + a.dangerousConfusions.reduce((s, d) => s + d.count, 0), 0);
  return {
    decision: 'PROCEED',
    statement: `PROCEED: classifier clears Phase 1 bar — ${totalDangerous} dangerous confusions on both axes across ${scored} scored cases.`,
  };
}

export interface ScoreIntakeEvalMeta {
  classifierModel?: string;
  judgeModel?: string;
}

export function scoreIntakeEval(
  records: IntakeRunRecord[],
  meta: ScoreIntakeEvalMeta = {},
): IntakeEvalReport {
  // Only count inconclusive judges on scored (classifier.ok) records — classifier-failed records
  // always produce an inconclusive judge placeholder and must not inflate the rate numerator.
  const inconclusiveJudgeCount = records.filter(r => r.classifier.ok && r.judge.status === 'inconclusive').length;

  const failureCounts = {
    timeout:        records.filter(r => !r.classifier.ok && r.classifier.reason === 'timeout').length,
    invalid_output: records.filter(r => !r.classifier.ok && r.classifier.reason === 'invalid_output').length,
    llm_error:      records.filter(r => !r.classifier.ok && r.classifier.reason === 'llm_error').length,
    scored:         records.filter(r => r.classifier.ok).length,
    total:          records.length,
  };

  const thresholds = { ...THRESHOLDS };

  const typeAxis = buildAxisReport(records, 'type');
  const sizeAxis = buildAxisReport(records, 'size');

  const partialReport: Omit<IntakeEvalReport, 'overall'> = {
    generatedFromCases: records.length,
    classifierModel: meta.classifierModel ?? 'unknown',
    judgeModel: meta.judgeModel ?? 'unknown',
    axes: [typeAxis, sizeAxis],
    inconclusiveJudgeCount,
    failureCounts,
    thresholds,
  };

  const overall = decideGate(partialReport);

  return { ...partialReport, overall };
}
