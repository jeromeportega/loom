import type {
  GateEvalConsumer,
  GateOutcome,
  JudgeOutcome,
  GateDeps,
  JudgeDeps,
  RunRecord,
} from '../framework/types.js';
import type { Lesson } from '../../findings/lesson.js';
import type { LessonExtractorCase } from './caseSchema.js';
import type { LessonExtractorJudgment } from './judgeTypes.js';
import type { LessonExtractorMetrics } from './score.js';
import { loadLessonExtractorCases } from './loadCases.js';
import { runLessonExtractorGate } from './runGate.js';
import { judgeLessonExtraction } from './judge.js';
import { scoreLessonExtractor, lessonExtractorVerdict, LESSON_EXTRACTOR_THRESHOLDS } from './score.js';

export function createLessonExtractorConsumer(opts: { projectRoot: string }):
  GateEvalConsumer<LessonExtractorCase, Lesson[], LessonExtractorJudgment, LessonExtractorMetrics> {
  return {
    loadCases(fixturePath?: string): LessonExtractorCase[] {
      return loadLessonExtractorCases(fixturePath);
    },

    async runGate(c: LessonExtractorCase, deps: GateDeps): Promise<GateOutcome<Lesson[]>> {
      return runLessonExtractorGate(c, deps, { projectRoot: opts.projectRoot });
    },

    async judge(
      c: LessonExtractorCase,
      output: Lesson[],
      deps: JudgeDeps,
    ): Promise<JudgeOutcome<LessonExtractorJudgment>> {
      return judgeLessonExtraction(c, output, deps);
    },

    score(records: RunRecord<Lesson[], LessonExtractorJudgment>[]): LessonExtractorMetrics {
      return scoreLessonExtractor(records);
    },

    verdict: lessonExtractorVerdict,

    thresholds: LESSON_EXTRACTOR_THRESHOLDS,
  };
}
