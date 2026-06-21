import { z } from 'zod';
import { loadBundledPrompt } from '../../planner/PersonaLoader.js';
import { extractJsonBlock } from '../../planner/util.js';
import type { BriefRefinement } from '../../brief/types.js';
import type { JudgeOutcome, JudgeDeps } from '../framework/types.js';
import type { BriefQualityCase, QualityBandType } from './caseSchema.js';
import type { BriefQualityJudgment } from './judgeTypes.js';
import { BANDS, BAND_TOLERANCE } from './bands.js';

// readiness_correct is omitted — computed deterministically after the LLM call
const BriefQualityLLMOutputSchema = z.object({
  critique_fidelity: z.enum(['faithful', 'partial', 'fabricated']),
  reason: z.string(),
});

export function scoreInBand(score: number, band: QualityBandType): boolean {
  if (score < 0) return false;
  const [lo, hi] = BANDS[band];
  return score >= lo - BAND_TOLERANCE && score <= hi + BAND_TOLERANCE;
}

// Load the persona once at module evaluation time — a missing file is a hard
// infrastructure error and must not be silently swallowed per invocation.
const JUDGE_SYSTEM_PROMPT = loadBundledPrompt('brief-quality-judge');

export async function judgeBriefQuality(
  c: BriefQualityCase,
  output: BriefRefinement,
  deps: JudgeDeps,
): Promise<JudgeOutcome<BriefQualityJudgment>> {
  try {
    const userContent = [
      '## Brief under evaluation',
      c.brief,
      '',
      '## Human label',
      `expected_ready: ${c.expected_ready}`,
      `expected_band: ${c.expected_band}`,
      `critique_themes: ${JSON.stringify(c.critique_themes)}`,
      '',
      '## BriefRefiner output',
      `ready: ${output.ready}`,
      `quality_score: ${output.quality_score}`,
      '',
      '### Critique',
      JSON.stringify(output.critique, null, 2),
      '',
      'Assess the BriefRefiner output and respond with the JSON object only.',
    ].join('\n');

    const response = await deps.llm.complete({
      model: deps.judgeModel,
      system: [{ text: JUDGE_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 512,
      nonAgentic: { excludeDynamicSections: true },
    });

    const parsed = BriefQualityLLMOutputSchema.parse(extractJsonBlock(response.text));
    const quality_in_band = scoreInBand(output.quality_score, c.expected_band);
    // readiness_correct is deterministic — BriefRefiner.ready must match the human label
    const readiness_correct = output.ready === c.expected_ready;

    const judgment: BriefQualityJudgment = {
      readiness_correct,
      quality_in_band,
      critique_fidelity: parsed.critique_fidelity,
      reason: parsed.reason,
    };

    return { status: 'ok', judgment };
  } catch (err) {
    return {
      status: 'inconclusive',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
