/**
 * Production PMAgent for runtime reroute (epic-095 reroute rework, Stage 2).
 *
 * Implements the reroute `PMAgent.decompose` interface by calling the PM planning
 * persona over an LLM client to split ONE oversized story into N ≥ 2 sub-stories.
 * Returns sub-stories with PLACEHOLDER ids — the Supervisor re-stamps schema-valid
 * `story-NNN-MMM` ids and validates the sub-graph (validateSubStories) before
 * injection, so this agent is not trusted for id uniqueness/coverage; it only has
 * to produce well-formed Story objects that carry the required `provides` keys.
 */

import { z } from 'zod';
import type { LLMClient } from '../llm/index.js';
import { PersonaLoader } from '../planner/PersonaLoader.js';
import { extractJsonBlock } from '../planner/util.js';
import { StorySchema, type Story } from '../types.js';
import type { PMAgent } from './rerouteHandler.js';

const SubStoriesEnvelope = z.object({
  stories: z.array(StorySchema).min(2),
});

export interface ReroutePMAgentOptions {
  llm:   LLMClient;
  model: string;
}

export class ReroutePMAgent implements PMAgent {
  constructor(private opts: ReroutePMAgentOptions) {}

  async decompose(storySpec: string, fanOutPayload: string, coverageKeys: string[]): Promise<Story[]> {
    const persona = PersonaLoader.load('pm');

    const coverage =
      coverageKeys.length > 0
        ? `\n\nDownstream stories depend on these keys being PROVIDED by the re-split (the ` +
          `\`provides\` channel). Arrange for EXACTLY ONE sub-story to declare each of these keys ` +
          `in its \`provides\`: ${coverageKeys.map((k) => `\`${k}\``).join(', ')}.`
        : '';
    const fanOut = fanOutPayload.trim().length > 0
      ? `\n\nThe worker that hit the size limit reported: ${fanOutPayload.trim()}`
      : '';

    const instruction =
      'Headless reroute task: a single story turned out too large to implement safely in one ' +
      'worktree. Decompose it into 2–6 SMALLER, independently-implementable sub-stories that ' +
      'together deliver the SAME acceptance criteria. Each sub-story must be a JSON object matching ' +
      "the epic story schema (id, title, description, acceptance_criteria, estimated_complexity, " +
      "dependencies, and optional provides/requires/tech_notes). Use SIMPLE placeholder ids like " +
      '"sub-1","sub-2" — they will be reassigned. Express ordering BETWEEN sub-stories via ' +
      '`dependencies` referencing those placeholder ids. Keep each sub-story genuinely smaller than ' +
      'the original (split by module, layer, or file-group — not by trivial slices). Return ONLY a ' +
      'JSON object `{ "stories": [ ... ] }` with no prose.' +
      coverage +
      fanOut +
      `\n\n---\n\nThe oversized story:\n\n${storySpec}`;

    const response = await this.opts.llm.complete({
      model:   this.opts.model,
      system:  [{ text: persona.systemPrompt, cache: true }],
      messages: [{ role: 'user', content: instruction }],
    });

    let parsed: unknown;
    try {
      parsed = extractJsonBlock(response.text);
    } catch (err) {
      throw new Error(`ReroutePMAgent: PM output was not parseable JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const result = SubStoriesEnvelope.safeParse(parsed);
    if (!result.success) {
      throw new Error(`ReroutePMAgent: PM output did not match the sub-stories schema: ${result.error.message}`);
    }
    return result.data.stories;
  }
}
