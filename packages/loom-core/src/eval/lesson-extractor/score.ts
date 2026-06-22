import { coreMetrics } from '../framework/coreMetrics.js';
import type { RunRecord, CoreMetrics, EvalThresholds } from '../framework/types.js';
import type { Lesson } from '../../findings/lesson.js';
import type { LessonExtractorJudgment } from './judgeTypes.js';

export interface LessonExtractorMetrics extends CoreMetrics {
  faithfulness: number;
  usefulness: number;
  coverage: number;           // full=1 / partial=0.5 / missing=0, averaged
  hallucinationRate: number;  // Σ hallucinated_lessons / Σ total_lessons over scored cases
  overExtractionRate: number; // fraction of scored cases with over_extraction === true
}

export const LESSON_EXTRACTOR_THRESHOLDS: EvalThresholds = {
  minScoredCases:           2,    // ADR-006: floor=2 (grows with fixture set)
  maxGateFailureRate:       0.25,
  maxJudgeInconclusiveRate: 0.25,
};

type ScoredRecord = RunRecord<Lesson[], LessonExtractorJudgment> & {
  gate:  { status: 'ok'; output: Lesson[] };
  judge: { status: 'ok'; judgment: LessonExtractorJudgment };
};

function coverageScore(c: 'full' | 'partial' | 'missing'): number {
  if (c === 'full')    return 1;
  if (c === 'partial') return 0.5;
  return 0;
}

export function scoreLessonExtractor(
  records: RunRecord<Lesson[], LessonExtractorJudgment>[],
): LessonExtractorMetrics {
  const base = coreMetrics(records);

  const scored = records.filter(
    (r): r is ScoredRecord => r.gate.status === 'ok' && r.judge.status === 'ok',
  );

  if (scored.length === 0) {
    return {
      ...base,
      faithfulness:      0,
      usefulness:        0,
      coverage:          0,
      hallucinationRate: 0,
      overExtractionRate: 0,
    };
  }

  let sumFaithfulness = 0;
  let sumUsefulness = 0;
  let sumCoverage = 0;
  let sumHallucinated = 0;
  let sumTotalLessons = 0;
  let overExtractionCount = 0;

  for (const r of scored) {
    const j = r.judge.judgment;
    sumFaithfulness += j.faithfulness;
    sumUsefulness += j.usefulness;
    sumCoverage += coverageScore(j.coverage);
    sumHallucinated += j.hallucinated_lessons;
    sumTotalLessons += j.total_lessons;
    if (j.over_extraction) overExtractionCount++;
  }

  const n = scored.length;

  return {
    ...base,
    faithfulness:      sumFaithfulness / n,
    usefulness:        sumUsefulness / n,
    coverage:          sumCoverage / n,
    hallucinationRate: sumTotalLessons === 0 ? 0 : sumHallucinated / sumTotalLessons,
    overExtractionRate: overExtractionCount / n,
  };
}

// ADR-007: quality bars; called by decide() after structural checks pass
export function lessonExtractorVerdict(m: LessonExtractorMetrics): 'proceed' | 'do-not-proceed' {
  if (m.faithfulness < 0.80)     return 'do-not-proceed';
  if (m.usefulness < 0.70)       return 'do-not-proceed';
  if (m.coverage < 0.70)         return 'do-not-proceed';
  if (m.hallucinationRate > 0.10) return 'do-not-proceed';
  return 'proceed';
}
