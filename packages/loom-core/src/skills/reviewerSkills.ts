import { z } from 'zod';
import { registerSkill } from './types.js';
import { ReviewerOutput } from '../findings/schema.js';
import { SOURCE } from '../findings/sources.js';
import { SkillStore } from './SkillStore.js';
import { extractJsonBlock } from '../planner/util.js';
import type { LLMClient } from '../llm/LLMClient.js';

// Appended after the cached SKILL.md body to keep per-call instructions out
// of the static cache boundary (NFR-1).
const JSON_INSTRUCTIONS =
  'Respond ONLY with one ```json fenced block matching the schema. The ' +
  '`findings` array may be empty if the change is sound. Cite real files.';

/**
 * Replaces the import-time stub handlers for SOURCE.ADVERSARIAL and
 * SOURCE.EDGE_CASE with real LLM-backed handlers. Must be called before the
 * first reviewer invocation (ADR-001 ordering invariant). Idempotent —
 * calling again re-registers with the latest deps (useful in tests).
 */
export function registerReviewerSkills(deps: {
  llm: LLMClient;
  model: string;
  projectRoot: string;
}): void {
  const { llm, model, projectRoot } = deps;
  const anyInput = z.unknown();

  for (const name of [SOURCE.ADVERSARIAL, SOURCE.EDGE_CASE] as const) {
    const skillName = name;
    registerSkill({
      name: skillName,
      inputSchema: anyInput,
      outputSchema: ReviewerOutput,
      handler: async (input: unknown) => {
        const skillBody = new SkillStore({ projectRoot }).load(skillName) ?? '';
        const systemText = skillBody + '\n' + JSON_INSTRUCTIONS;
        const response = await llm.complete({
          model,
          system: [{ text: systemText, cache: true }],
          messages: [{ role: 'user', content: JSON.stringify(input) }],
        });
        const parsed = ReviewerOutput.parse(extractJsonBlock(response.text));
        return {
          findings: parsed.findings.map((f) => ({ ...f, source: skillName })),
        };
      },
    });
  }
}
