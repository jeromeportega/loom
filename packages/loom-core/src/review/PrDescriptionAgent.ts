import type { LLMClient, LLMUsage } from '../llm/index.js';
import { SkillStore } from '../skills/index.js';
import type { ReviewStoryContext } from './types.js';

export interface PrDescriptionAgentOptions {
  projectRoot: string;
  llm: LLMClient;
  /** Model id — defaults to the policy planning-tier model. */
  model: string;
}

export interface PrDescriptionInput {
  /** Free-form headline for the PR (epic title or single-story title). */
  title: string;
  /** Per-story context — what was built. */
  stories: ReviewStoryContext[];
  /** `git diff --stat` output for the work. */
  diffStat: string;
  /** `git log --oneline` for the work. */
  commitLog: string;
}

export interface PrDescriptionResult {
  description: string;
  usage: LLMUsage;
}

const FALLBACK_SYSTEM =
  'You are a senior engineer writing a PR description that respects the ' +
  'reviewer\'s time. Lead with the user-visible outcome. Call out files to ' +
  'review first, risky changes, what reviewers can skim, testing notes, and ' +
  'open questions. Be concrete and plain. Start at the first `#` heading; no ' +
  'preamble.';

/**
 * Generates a PR body from a diff + commit log + story context. Uses the
 * bundled `loom-pr-description` skill as the system prompt — falls back to
 * an inline prompt if the skill is missing.
 */
export class PrDescriptionAgent {
  constructor(private opts: PrDescriptionAgentOptions) {}

  async generate(input: PrDescriptionInput): Promise<PrDescriptionResult> {
    const skillStore = new SkillStore({ projectRoot: this.opts.projectRoot });
    const system = skillStore.load('loom-pr-description') ?? FALLBACK_SYSTEM;

    const storyBlock = input.stories
      .map(
        (s) =>
          `### ${s.storyId} — ${s.title}\n\n${s.description}\n\n` +
          `**Acceptance criteria:**\n` +
          s.acceptanceCriteria.map((ac) => `- ${ac}`).join('\n')
      )
      .join('\n\n---\n\n');

    const userContent = [
      `# ${input.title}`,
      '',
      '## Stories',
      '',
      storyBlock,
      '',
      '## File changes (git diff --stat)',
      '',
      '```',
      input.diffStat.trim() || '(empty)',
      '```',
      '',
      '## Commits',
      '',
      '```',
      input.commitLog.trim() || '(empty)',
      '```',
      '',
      'Write the PR description now. Output only the description.',
    ].join('\n');

    const response = await this.opts.llm.complete({
      model: this.opts.model,
      system: [{ text: system, cache: true }],
      messages: [{ role: 'user', content: userContent }],
    });

    return {
      description: response.text.trim(),
      usage: response.usage,
    };
  }
}
