import { z } from 'zod';
import type { LLMClient } from '../llm/index.js';
import { loadBundledPrompt } from '../planner/PersonaLoader.js';
import { extractJsonBlock } from '../planner/util.js';
import type { SkillManifest } from './SkillStore.js';

const FALLBACK_JUDGE_PROMPT =
  'You are a strict reviewer. Score a candidate skill 0–10 and decide accept/reject.\n' +
  'Return ONLY a single fenced ```json block:\n' +
  '```json\n{"score": 0, "verdict": "accept | reject", "reason": "one sentence"}\n```\n\n' +
  '{{CONTEXT}}';

const JudgeResultSchema = z.object({
  score: z.number(),
  verdict: z.enum(['accept', 'reject']),
  reason: z.string().default(''),
});

export interface JudgeResult {
  score: number;
  verdict: 'accept' | 'reject';
  reason: string;
}

export interface SkillJudgeOptions {
  llm: LLMClient;
  model: string;
}

/**
 * Scores a freshly generated candidate skill against a quality rubric before it
 * is allowed into the library. Best-effort: any failure (LLM error, unparseable
 * output) returns a permissive 'accept' — the judge can reject bad skills but
 * never blocks a run.
 */
export class SkillJudge {
  constructor(private opts: SkillJudgeOptions) {}

  async judge(
    skillMd: string,
    existingSkills: SkillManifest[]
  ): Promise<JudgeResult> {
    try {
      return await this.score(skillMd, existingSkills);
    } catch {
      return {
        score: 999,
        verdict: 'accept',
        reason: 'judge unavailable — defaulting to accept',
      };
    }
  }

  private async score(
    skillMd: string,
    existingSkills: SkillManifest[]
  ): Promise<JudgeResult> {
    const existingList =
      existingSkills.length > 0
        ? existingSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
        : '(none yet)';

    const context = [
      '## Candidate skill',
      skillMd,
      '',
      '## Existing skills in the library',
      existingList,
    ].join('\n');

    let promptTemplate: string;
    try {
      promptTemplate = loadBundledPrompt('skill-judge');
    } catch {
      promptTemplate = FALLBACK_JUDGE_PROMPT;
    }
    const prompt = promptTemplate.replace('{{CONTEXT}}', context);

    const response = await this.opts.llm.complete({
      model: this.opts.model,
      system: [{ text: prompt, cache: true }],
      messages: [{ role: 'user', content: 'Score the candidate skill now.' }],
      maxTokens: 512,
      nonAgentic: { excludeDynamicSections: true },
    });

    return JudgeResultSchema.parse(extractJsonBlock(response.text));
  }
}
