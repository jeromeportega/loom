import { computeAxisAccuracy } from './runIntakeEval.js';
import { computeJudgeVsHumanAgreement } from './IntakeJudge.js';
import type {
  IntakeRunRecord,
  IntakeEvalReport,
  AxisReport,
  ConfusionMatrix,
} from './intakeEvalTypes.js';

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

  return {
    generatedFromCases: records.length,
    classifierModel: meta.classifierModel ?? 'unknown',
    judgeModel: meta.judgeModel ?? 'unknown',
    axes: [typeAxis, sizeAxis],
    inconclusiveJudgeCount,
    overall: { proceed, statement: overallStatement },
  };
}
