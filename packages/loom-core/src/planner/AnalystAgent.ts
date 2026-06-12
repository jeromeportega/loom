import fs from 'node:fs';
import type { LLMUsage } from '../llm/index.js';
import type { PlannerContext } from './context.js';
import { PersonaLoader } from './PersonaLoader.js';
import { planningPaths } from './paths.js';
import { trimToFirstHeading } from './util.js';

export interface AnalystResult {
  briefPath: string;
  briefContent: string;
  usage: LLMUsage;
}

/**
 * Mary — the Business Analyst. Takes a raw brief string and produces a
 * structured project-brief.md, running fully headless.
 */
export class AnalystAgent {
  constructor(private ctx: PlannerContext) {}

  async run(brief: string): Promise<AnalystResult> {
    const persona = PersonaLoader.load('analyst');
    const paths = planningPaths(this.ctx.projectRoot, this.ctx.runId);

    const skills = this.ctx.skills ?? [];
    const skillsBlock = skills.length > 0
      ? '\n\n## Reference practices\n\nApply the following practices as lenses ' +
        'while you produce the brief — they are guidance to keep in mind, not ' +
        'separate deliverables:\n\n' +
        skills.map((body) => `--- PRACTICE ---\n\n${body}`).join('\n\n')
      : '';

    const response = await this.ctx.llm.complete({
      model: this.ctx.model,
      system: [{ text: persona.systemPrompt, cache: true }],
      messages: [
        {
          role: 'user',
          content:
            'Here is the brief to analyze. Produce the project brief document.' +
            `\n\n---\n\n${brief}${skillsBlock}`,
        },
      ],
    });

    const briefContent = trimToFirstHeading(response.text);
    fs.mkdirSync(paths.runDir, { recursive: true });
    fs.writeFileSync(paths.brief, briefContent + '\n');

    return {
      briefPath: paths.brief,
      briefContent,
      usage: response.usage,
    };
  }
}
