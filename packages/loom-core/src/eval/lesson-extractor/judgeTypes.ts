export interface LessonExtractorJudgment {
  total_lessons: number;
  faithfulness: number;          // 0..1 — fraction grounded in telemetry
  usefulness: number;            // 0..1 — fraction actionable general rules
  coverage: 'full' | 'partial' | 'missing';
  hallucinated_lessons: number;  // ≤ total_lessons
  over_extraction: boolean;
  reason: string;
}
