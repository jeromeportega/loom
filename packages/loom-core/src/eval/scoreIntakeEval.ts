import { computeAxisAccuracy } from './runIntakeEval.js';
import { computeJudgeVsHumanAgreement } from './IntakeJudge.js';
import type {
  IntakeRunRecord,
  IntakeEvalReport,
  AxisReport,
  ConfusionMatrix,
} from './intakeEvalTypes.js';

// Gate thresholds — fail-closed (FR-9, FR-10).
//
// MIN_SCORED_CASES: A sample of fewer than 5 fully-graded cases (ok classifier +
// conclusive judge) is too small to estimate classifier quality reliably. At n=5
// a binomial CI still has wide error bars, but catastrophic failures (0% accuracy)
// show up immediately. Below this count the run is inconclusive regardless of results.
const MIN_SCORED_CASES = 5;
//
// MAX_FAILURE_RATE: If more than 25% of cases fail the classifier, or more than 25%
// of judge calls return inconclusive, the eval run itself is compromised. Above this
// rate the surviving cases may not be representative, so the gate reports inconclusive
// rather than drawing conclusions from a biased sample.
const MAX_FAILURE_RATE = 0.25;

const TYPE_LABELS: ReadonlyArray<string> = ['feature', 'bug', 'chore'];
const SIZE_LABELS: ReadonlyArray<string> = ['story', 'epic'];

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
    if (rec.judge.result[axis] !== rec.classifier.verdict[axis]) {
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

export interface ScoreIntakeEvalMeta {
  classifierModel?: string;
  judgeModel?: string;
}

function computeFailureCounts(records: IntakeRunRecord[]): IntakeEvalReport['failureCounts'] {
  const classifier = { llm_error: 0, timeout: 0, invalid_output: 0 };
  let judgeInconclusive = 0;

  for (const rec of records) {
    if (!rec.classifier.ok) {
      classifier[rec.classifier.reason]++;
    }
    if (rec.judge.status === 'inconclusive') {
      judgeInconclusive++;
    }
  }

  return { classifier, judgeInconclusive };
}

function computeGate(
  records: IntakeRunRecord[],
  scoredCases: number,
  failureCounts: IntakeEvalReport['failureCounts'],
  overallProceed: boolean,
  epicsUnderSized: number,
): IntakeEvalReport['gate'] {
  const total = records.length;
  const minScoredCases = MIN_SCORED_CASES;

  if (total === 0 || scoredCases < minScoredCases) {
    return {
      decision: 'inconclusive',
      statement: `Inconclusive: only ${scoredCases} successfully scored case(s) (minimum ${minScoredCases} required). Re-run with more cases.`,
      minScoredCases,
    };
  }

  const totalClassifierFailures =
    failureCounts.classifier.llm_error +
    failureCounts.classifier.timeout +
    failureCounts.classifier.invalid_output;
  const classifierFailureRate = totalClassifierFailures / total;
  const judgeInconclusiveRate = failureCounts.judgeInconclusive / total;

  if (classifierFailureRate > MAX_FAILURE_RATE) {
    const pct = Math.round(classifierFailureRate * 100);
    return {
      decision: 'inconclusive',
      statement: `Inconclusive: classifier failure rate ${pct}% exceeds ${Math.round(MAX_FAILURE_RATE * 100)}% threshold (${totalClassifierFailures}/${total} cases failed). Re-run to confirm.`,
      minScoredCases,
    };
  }

  if (judgeInconclusiveRate > MAX_FAILURE_RATE) {
    const pct = Math.round(judgeInconclusiveRate * 100);
    return {
      decision: 'inconclusive',
      statement: `Inconclusive: judge-inconclusive rate ${pct}% exceeds ${Math.round(MAX_FAILURE_RATE * 100)}% threshold (${failureCounts.judgeInconclusive}/${total} cases inconclusive). Re-run to confirm.`,
      minScoredCases,
    };
  }

  if (overallProceed) {
    return {
      decision: 'proceed',
      statement: `Proceed: classifier clears Phase 1 quality bar across ${scoredCases} scored case(s) with acceptable failure rates (classifier: ${totalClassifierFailures}/${total}, judge-inconclusive: ${failureCounts.judgeInconclusive}/${total}).`,
      minScoredCases,
    };
  }

  return {
    decision: 'do-not-proceed',
    statement: `Do-not-proceed: classifier failed Phase 1 quality bar — ${epicsUnderSized} epic→story under-sizing confusion(s) detected across ${scoredCases} scored case(s).`,
    minScoredCases,
  };
}

export function scoreIntakeEval(
  records: IntakeRunRecord[],
  meta: ScoreIntakeEvalMeta = {},
): IntakeEvalReport {
  const inconclusiveJudgeCount = records.filter(r => r.judge.status === 'inconclusive').length;

  const typeAxis = buildAxisReport(records, 'type');
  const sizeAxis = buildAxisReport(records, 'size');

  const proceed = typeAxis.verdict.clearsBar && sizeAxis.verdict.clearsBar;
  const epicsUnderSized = sizeAxis.dangerousConfusions.find(d => d.from === 'epic' && d.to === 'story')?.count ?? 0;
  const overallStatement = proceed
    ? `Classifier clears Phase 1 bar: 0 dangerous confusions on both axes across ${records.length} cases.`
    : `Classifier does NOT clear Phase 1 bar: ${epicsUnderSized} epic→story under-sizing confusion(s) detected across ${records.length} cases.`;

  const failureCounts = computeFailureCounts(records);
  const scoredCases = records.filter(r => r.classifier.ok && r.judge.status === 'ok').length;
  const gate = computeGate(records, scoredCases, failureCounts, proceed, epicsUnderSized);

  return {
    generatedFromCases: records.length,
    classifierModel: meta.classifierModel ?? 'unknown',
    judgeModel: meta.judgeModel ?? 'unknown',
    axes: [typeAxis, sizeAxis],
    inconclusiveJudgeCount,
    overall: { proceed, statement: overallStatement },
    failureCounts,
    scoredCases,
    gate,
  };
}
