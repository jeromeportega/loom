import { z } from 'zod';
import type { LLMClient } from '../llm/index.js';
import { loadBundledPrompt } from '../planner/PersonaLoader.js';
import { extractJsonBlock } from '../planner/util.js';
import type { SkillManifest } from './SkillStore.js';

const FALLBACK_JUDGE_PROMPT =
  'You are a strict reviewer evaluating a candidate reusable skill.\n' +
  '\n' +
  'HARD REJECTION — check these first; they override any rubric score:\n' +
  '1. UNSAFE: Reject if the skill teaches or encourages a destructive operation\n' +
  '   (force-pushing, rewriting published history, deleting data without recovery,\n' +
  '   disabling safety checks or guardrails). Exception: a skill that mentions a\n' +
  '   dangerous command only to warn against it or show safe usage is NOT rejected.\n' +
  '2. NOT REUSABLE: Reject if the skill is narrowly tied to one repository\'s\n' +
  '   internals, a one-off task, or not applicable across different projects.\n' +
  'A polished, high-scoring candidate that fails either criterion is still rejected.\n' +
  '\n' +
  'RUBRIC (0–10, only if hard criteria pass — score each dimension 0-2):\n' +
  '- Concrete: names specific tools/commands/patterns, not vague advice.\n' +
  '- Transferable: useful on different future stories.\n' +
  '- Correct: technically sound and not misleading.\n' +
  '- Non-duplicate: does not substantially overlap existing skills.\n' +
  '- Well-formed: valid frontmatter, clear title, actionable instructions.\n' +
  '\n' +
  'Return ONLY a single fenced ```json block — no prose:\n' +
  '```json\n{"score": 0, "verdict": "reject", "reason": "one sentence"}\n```\n' +
  'verdict must be "accept" or "reject".\n\n' +
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
  /** Override prompt loader — used in tests to exercise the fallback path. */
  loadPrompt?: (name: string) => string;
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

    const loader = this.opts.loadPrompt ?? loadBundledPrompt;
    let promptTemplate: string;
    try {
      promptTemplate = loader('skill-judge');
    } catch (err) {
      console.warn('[SkillJudge] skill-judge bundled prompt unavailable, using built-in fallback:', err);
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
