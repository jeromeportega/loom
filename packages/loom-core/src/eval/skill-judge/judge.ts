import { z } from 'zod';
import { loadBundledPrompt } from '../../planner/PersonaLoader.js';
import { extractJsonBlock } from '../../planner/util.js';
import type { JudgeResult } from '../../skills/SkillJudge.js';
import type { JudgeOutcome, JudgeDeps } from '../framework/types.js';
import type { SkillJudgeEvalCase } from './caseSchema.js';
import type { SkillJudgeJudgment } from './judgeTypes.js';
import { scoreInBand } from './bands.js';

const SkillJudgeLLMOutputSchema = z.object({
  independent_verdict: z.enum(['accept', 'reject']),
  band_defensible:     z.boolean(),
  reason:              z.string(),
});

const JUDGE_SYSTEM_PROMPT = loadBundledPrompt('skill-admissibility-judge');

export async function judgeSkillAdmissibility(
  c: SkillJudgeEvalCase,
  output: JudgeResult,
  deps: JudgeDeps,
): Promise<JudgeOutcome<SkillJudgeJudgment>> {
  try {
    const decision_correct = output.verdict === c.expected_decision;
    const band_in_range = scoreInBand(output.score, c.expected_band);

    const existingList =
      c.existing_skills.length > 0
        ? c.existing_skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
        : '(none)';

    const userContent = [
      '## Candidate skill',
      c.skill_md,
      '',
      '## Existing skills in the library',
      existingList,
      '',
      '## SkillJudge output',
      `score: ${output.score}`,
      `verdict: ${output.verdict}`,
      `reason: ${output.reason}`,
      '',
      '## Evaluation context',
      `expected_decision: ${c.expected_decision}`,
      `expected_band: ${c.expected_band}`,
      '',
      'Assess admissibility independently and grade the SkillJudge verdict. Respond with the JSON object only.',
    ].join('\n');

    const response = await deps.llm.complete({
      model: deps.judgeModel,
      system: [{ text: JUDGE_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 512,
      nonAgentic: { excludeDynamicSections: true },
    });

    const parsed = SkillJudgeLLMOutputSchema.parse(extractJsonBlock(response.text));

    const judgment: SkillJudgeJudgment = {
      decision_correct,
      band_in_range,
      independent_verdict: parsed.independent_verdict,
      band_defensible:     parsed.band_defensible,
      reason:              parsed.reason,
    };

    return { status: 'ok', judgment };
  } catch (err) {
    return {
      status: 'inconclusive',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
