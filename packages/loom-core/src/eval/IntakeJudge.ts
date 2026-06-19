import { loadBundledPrompt } from '../planner/PersonaLoader.js';
import { extractJsonObject } from '../llm/extractJson.js';
import type { LLMClient } from '../llm/LLMClient.js';
import { IntakeJudgeResultSchema } from './intakeEvalTypes.js';
import type {
  IntakeVerdict,
  JudgeOutcome,
  IntakeJudgeLike,
  IntakeRunRecord,
} from './intakeEvalTypes.js';

export class IntakeJudge implements IntakeJudgeLike {
  constructor(private opts: { llm: LLMClient; model: string }) {}

  async judge(brief: string, verdict: IntakeVerdict): Promise<JudgeOutcome> {
    try {
      const systemPrompt = loadBundledPrompt('intake-judge');

      const userContent = [
        '## Brief',
        brief,
        '',
        '## Classifier verdict',
        JSON.stringify(verdict, null, 2),
        '',
        'Classify the brief and grade the classifier verdict.',
      ].join('\n');

      const response = await this.opts.llm.complete({
        model: this.opts.model,
        system: [{ text: systemPrompt, cache: true }],
        messages: [{ role: 'user', content: userContent }],
      });

      const result = IntakeJudgeResultSchema.parse(extractJsonObject(response.text));
      return { status: 'ok', result };
    } catch (err) {
      // Any failure (outage, parse error, validation error) → inconclusive.
      // This explicitly overrides SkillJudge's permissive-accept degradation (ADR-001).
      return {
        status: 'inconclusive',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Computes per-axis judge-vs-human agreement from run records.
 * Inconclusive outcomes increment the inconclusive counter and are excluded
 * from the agree/disagree denominator (FR-9, ADR-001).
 */
export function computeJudgeVsHumanAgreement(
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
    if (rec.judge.result[axis] === rec.case.label[axis]) {
      agree++;
    } else {
      disagree++;
    }
  }

  return { agree, disagree, inconclusive };
}
