import fs from 'node:fs';
import { z } from 'zod';
import type { EpicYaml } from '../types.js';
import type { LLMUsage } from '../llm/index.js';
import { EMPTY_USAGE } from '../llm/index.js';
import type { PlannerContext } from './context.js';
import { PersonaLoader } from './PersonaLoader.js';
import { planningPaths } from './paths.js';
import { extractJsonBlock } from './util.js';
import { serializeEpic } from './epicSerializer.js';

const TestPlanEnvelopeSchema = z.object({
  test_plan: z.record(z.string(), z.string()),
});

export interface QAResult {
  /** Epics with test_plan merged into each story (rewritten to YAML). */
  epics: EpicYaml[];
  storiesPlanned: number;
  storiesMissingPlan: string[];
  usage: LLMUsage;
}

/**
 * Tessa — the QA Test Architect. Runs after the Architect when
 * policy.agents.qa_planning='advisory'. Produces a concrete, risk-based
 * test_plan for every story and appends it to the epic YAML files so each
 * worker prompt carries an explicit definition of "verified". Fully headless.
 *
 * The plan is advisory enrichment, not a hard dependency: a blank/unusable LLM
 * response or a provider error writes no plans and leaves the architect's epics
 * untouched rather than aborting the already-completed planning run.
 */
export class QAAgent {
  constructor(private ctx: PlannerContext) {}

  async run(
    prdContent: string,
    architectureContent: string,
    epics: EpicYaml[]
  ): Promise<QAResult> {
    const paths = planningPaths(this.ctx.projectRoot, this.ctx.runId);
    const epicsJson = JSON.stringify({ epics }, null, 2);

    const { map, usage } = await this.generateTestPlans(
      prdContent,
      architectureContent,
      epicsJson
    );

    let planned = 0;
    const missing: string[] = [];
    for (const epic of epics) {
      let touched = false;
      for (const story of epic.stories) {
        const plan = map[story.id];
        if (plan && plan.trim().length > 0) {
          story.test_plan = plan.trim();
          planned++;
          touched = true;
        } else {
          missing.push(story.id);
        }
      }
      // Only rewrite YAML we actually enriched — a fully-empty map (soft
      // failure) leaves the architect's files byte-for-byte untouched.
      if (touched) {
        fs.writeFileSync(paths.epicFile(epic.epic_id), serializeEpic(epic, 'and QA (Tessa)'));
      }
    }

    return { epics, storiesPlanned: planned, storiesMissingPlan: missing, usage };
  }

  private async generateTestPlans(
    prdContent: string,
    architectureContent: string,
    epicsJson: string
  ): Promise<{ map: Record<string, string>; usage: LLMUsage }> {
    // Tokens consumed are reported even when the response can't be parsed, so
    // capture usage the moment the call returns and before any parse attempt.
    let responseUsage: LLMUsage = { ...EMPTY_USAGE };
    try {
      // Persona load lives INSIDE the soft-fail boundary: a missing/malformed
      // personas/qa.md or an unresolvable personas/ dir must not abort the run
      // and discard the brief/PRD/architecture already on disk — same contract
      // as a provider or parse failure below.
      const persona = PersonaLoader.load('qa');
      const response = await this.ctx.llm.complete({
        model: this.ctx.model,
        system: [{ text: persona.systemPrompt, cache: true }],
        messages: [
          {
            role: 'user',
            content:
              'Perform the headless task: produce a per-story test_plan JSON ' +
              '(an entry for every story id).\n\n' +
              'PRD:\n---\n' +
              prdContent +
              '\n\nARCHITECTURE:\n---\n' +
              architectureContent +
              '\n\nEPIC BREAKDOWN:\n---\n' +
              epicsJson,
          },
        ],
      });
      responseUsage = response.usage;
      const json = extractJsonBlock(response.text);
      const envelope = TestPlanEnvelopeSchema.parse(json);
      return { map: envelope.test_plan, usage: responseUsage };
    } catch {
      // Test plans are advisory enrichment — a persona-load, provider, or parse
      // failure writes no plans rather than aborting the run. The LLM tokens
      // (if the call completed) are still reported so cost tracking is accurate.
      return { map: {}, usage: responseUsage };
    }
  }
}
