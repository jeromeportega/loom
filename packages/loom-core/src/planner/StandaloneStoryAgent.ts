import { z } from 'zod';
import type { LLMUsage } from '../llm/index.js';
import { addUsage, EMPTY_USAGE } from '../llm/index.js';
import type { LLMMessage } from '../llm/LLMClient.js';
import type { PlannerContext } from './context.js';
import { StorySchema } from '../types.js';
import type { Story } from '../types.js';
import { extractJsonBlock } from './util.js';

/**
 * System prompt for the standalone story agent. Cached on first use (Invariant 3).
 * Self-contained: no persona file required, no PersonaLoader call.
 */
const SYSTEM_PROMPT = [
  'You are a Senior Software Engineer operating as a loom planning agent.',
  'Your role: turn a refined project brief into exactly ONE implementation-ready story definition.',
  'No PRD, no epic decomposition — one story, one JSON block.',
  '',
  '## Output format',
  '',
  'Return a single fenced ```json block containing ONE object with these fields:',
  '- "id": use the story id provided in the prompt — verbatim, no changes',
  '- "title": concise title, 5–100 characters',
  '- "description": clear description of what to build and why',
  '- "acceptance_criteria": array of at least 1 checkable, concrete criterion (each a full sentence)',
  '- "estimated_complexity": one of "trivial", "small", "medium", "large"',
  '- "dependencies": always []',
  '- "tech_notes": brief technical guidance — key files, approach, implementation constraints',
  '',
  '## Rules',
  '',
  '- Return ONLY the ```json block. No preamble, no prose after.',
  '- Do NOT produce a PRD. Do NOT decompose into multiple stories.',
  '- Every acceptance criterion must be observable and concretely checkable.',
  '- Base all content strictly on the brief. Never invent requirements the brief does not support.',
  '- "tech_notes" should guide the implementer — include it even if brief.',
].join('\n');

/**
 * Single-story planner agent for the standalone-story path (epic-047).
 * Reads the Analyst's refined brief and produces exactly ONE Story with no PRD
 * and no multi-story decomposition pass. Mirrors PMAgent's shape.
 *
 * Prompt caching is applied to the system prompt (Invariant 3).
 */
export class StandaloneStoryAgent {
  constructor(private ctx: PlannerContext) {}

  /**
   * @param refinedBrief - the Analyst's refined brief
   * @param storyId - derived by the caller (Planner.runStandalone) to avoid a
   *   transitive intake/ import from this module (physical-separation invariant)
   */
  async run(refinedBrief: string, storyId: string): Promise<{ story: Story; usage: LLMUsage }> {
    let usage: LLMUsage = { ...EMPTY_USAGE };
    let lastError = '';
    let lastResponse = '';

    const baseMsg =
      `Produce a single story definition in JSON.\n\n` +
      `Story id: "${storyId}"\n\n` +
      `PROJECT BRIEF:\n---\n${refinedBrief}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const messages: LLMMessage[] =
        attempt === 0
          ? [{ role: 'user', content: baseMsg }]
          : [
              { role: 'user', content: baseMsg },
              { role: 'assistant', content: lastResponse },
              {
                role: 'user',
                content:
                  `That output failed validation:\n${lastError}\n\n` +
                  'Return a corrected response — a single fenced ```json block only.',
              },
            ];

      const response = await this.ctx.llm.complete({
        model: this.ctx.model,
        system: [{ text: SYSTEM_PROMPT, cache: true }],
        messages,
      });
      usage = addUsage(usage, response.usage);
      lastResponse = response.text;

      try {
        const json = extractJsonBlock(response.text);
        const parsed = StorySchema.parse(json);
        // Enforce the derived id regardless of model compliance — the system
        // prompt asks the model to use it verbatim, but code-level enforcement
        // ensures the DB row and on-disk YAML are always consistent (ADR-001 §5).
        const story = parsed.id === storyId ? parsed : { ...parsed, id: storyId };
        return { story, usage };
      } catch (err) {
        lastError =
          err instanceof z.ZodError
            ? err.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
            : (err as Error).message;
      }
    }

    throw new Error(
      `StandaloneStoryAgent failed to produce a valid story after 2 attempts.\n` +
        `Last validation error:\n${lastError}`
    );
  }
}
