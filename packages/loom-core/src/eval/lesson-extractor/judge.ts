import { z } from 'zod';
import { loadBundledPrompt } from '../../planner/PersonaLoader.js';
import { extractJsonBlock } from '../../planner/util.js';
import type { Lesson } from '../../findings/lesson.js';
import type { JudgeOutcome, JudgeDeps } from '../framework/types.js';
import type { LessonExtractorCase } from './caseSchema.js';
import type { LessonExtractorJudgment } from './judgeTypes.js';

const LessonExtractorLLMOutputSchema = z.object({
  total_lessons:        z.number().int().nonnegative(),
  faithfulness:         z.number().min(0).max(1),
  usefulness:           z.number().min(0).max(1),
  coverage:             z.enum(['full', 'partial', 'missing']),
  hallucinated_lessons: z.number().int().nonnegative(),
  over_extraction:      z.boolean(),
  reason:               z.string().min(1),
}).superRefine((d, ctx) => {
  if (d.hallucinated_lessons > d.total_lessons) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `hallucinated_lessons (${d.hallucinated_lessons}) must not exceed total_lessons (${d.total_lessons})`,
    });
  }
});

const JUDGE_SYSTEM_PROMPT = loadBundledPrompt('lesson-extractor-judge');

export async function judgeLessonExtraction(
  c: LessonExtractorCase,
  output: Lesson[],
  deps: JudgeDeps,
): Promise<JudgeOutcome<LessonExtractorJudgment>> {
  try {
    const userContent = [
      '## Rubric',
      `expected_themes: ${JSON.stringify(c.rubric.expected_themes)}`,
      `over_extraction_traps: ${JSON.stringify(c.rubric.over_extraction_traps)}`,
      '',
      '## Extracted lessons',
      JSON.stringify(output, null, 2),
      '',
      'Score the extracted lessons against the rubric. Respond with the JSON object only.',
    ].join('\n');

    const response = await deps.llm.complete({
      model:    deps.judgeModel,
      system:   [{ text: JUDGE_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 512,
      nonAgentic: { excludeDynamicSections: true },
    });

    const parsed = LessonExtractorLLMOutputSchema.parse(extractJsonBlock(response.text));

    const judgment: LessonExtractorJudgment = {
      total_lessons:        parsed.total_lessons,
      faithfulness:         parsed.faithfulness,
      usefulness:           parsed.usefulness,
      coverage:             parsed.coverage,
      hallucinated_lessons: parsed.hallucinated_lessons,
      over_extraction:      parsed.over_extraction,
      reason:               parsed.reason,
    };

    return { status: 'ok', judgment };
  } catch (err) {
    return {
      status: 'inconclusive',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
