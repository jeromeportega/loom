import { z } from 'zod';
import { registerSkill } from './types.js';
import { ReviewerOutput } from '../findings/schema.js';
import { SOURCE } from '../findings/sources.js';
import { SkillStore } from './SkillStore.js';
import { extractJsonBlock } from '../planner/util.js';
import type { LLMClient } from '../llm/LLMClient.js';

// Appended after the cached SKILL.md body to keep per-call instructions out
// of the static cache boundary (NFR-1). This block OVERRIDES whatever output
// format the ported SKILL.md body describes: the BMAD originals emit a
// different shape (severity:"critical", file/line/title/body), which fails the
// shared `ReviewerOutput` zod schema. Pin loom's exact schema here so the model
// emits findings the orchestrator can actually parse.
const JSON_INSTRUCTIONS = [
  '',
  '## Required output format (this OVERRIDES any output format described above)',
  'Respond with EXACTLY one ```json fenced code block and no prose outside it.',
  'It MUST match this schema exactly:',
  '{"findings": [{"severity": <one of "blocker"|"high"|"medium"|"low"|"info">, "category": "<short-word>", "location": {"file": "<repo-relative path>", "line": <integer, optional>}, "description": "<the finding>", "suggested_fix": "<optional string>"}]}',
  'Rules:',
  '- severity MUST be one of exactly: blocker, high, medium, low, info (NOT "critical", "error", "warning", "bug", or any other word).',
  '- category, location.file, and description are REQUIRED on every finding.',
  '- Do NOT emit a "source" field, a "title"/"body" field, or any field not in the schema above.',
  '- The findings array MAY be empty ({"findings": []}) if the change is sound.',
  '- Cite real repo-relative paths in location.file.',
].join('\n');

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
