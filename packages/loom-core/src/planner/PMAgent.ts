import fs from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { EpicYamlSchema, type EpicYaml } from '../types.js';
import type { LLMUsage, LLMMessage } from '../llm/index.js';
import { addUsage, EMPTY_USAGE } from '../llm/index.js';
import type { PlannerContext } from './context.js';
import { PersonaLoader } from './PersonaLoader.js';
import { planningPaths, planningRelPaths, epicId } from './paths.js';
import { extractJsonBlock, trimToFirstHeading } from './util.js';
import { buildSizingConstraintBlock } from '../intake/routing.js';

const EpicsEnvelopeSchema = z.object({
  epics: z.array(EpicYamlSchema).min(1),
});

export interface PMResult {
  prdPath: string;
  prdContent: string;
  epics: EpicYaml[];
  epicPaths: string[];
  usage: LLMUsage;
}

/**
 * John — the Product Manager. Reads the analyst's brief and produces a PRD plus
 * a validated set of epic YAML files, running fully headless.
 */
export class PMAgent {
  constructor(private ctx: PlannerContext) {}

  /**
   * @param briefContent the analyst's brief
   * @param startEpicNumber number the first epic should take (for globally
   *   unique IDs across planning runs); defaults to 1.
   */
  async run(briefContent: string, startEpicNumber = 1): Promise<PMResult> {
    const persona = PersonaLoader.load('pm');
    const paths = planningPaths(this.ctx.planningRoot, this.ctx.runId);
    const rel = planningRelPaths(this.ctx.runId);
    let usage: LLMUsage = { ...EMPTY_USAGE };

    // ─── Task A: PRD ─────────────────────────────────────────────────────────
    const prdResponse = await this.ctx.llm.complete({
      model: this.ctx.model,
      system: [{ text: persona.systemPrompt, cache: true }],
      messages: [
        {
          role: 'user',
          content:
            'Perform Headless task A: produce the PRD. Here is the project brief:\n\n---\n\n' +
            briefContent,
        },
      ],
    });
    usage = addUsage(usage, prdResponse.usage);
    const prdContent = trimToFirstHeading(prdResponse.text);

    fs.mkdirSync(paths.runDir, { recursive: true });
    fs.writeFileSync(paths.prd, prdContent + '\n');

    // ─── Task B: epic/story breakdown (with one validation retry) ────────────
    const { epics, usage: epicUsage } = await this.generateEpics(
      persona.systemPrompt,
      briefContent,
      prdContent,
      startEpicNumber
    );
    usage = addUsage(usage, epicUsage);

    // Force prd_ref to the real run-relative path regardless of what the PM emitted.
    for (const epic of epics) {
      epic.prd_ref = rel.prd;
    }

    // ─── Write epic YAML files ───────────────────────────────────────────────
    fs.mkdirSync(paths.epicsDir, { recursive: true });
    const epicPaths: string[] = [];
    for (const epic of epics) {
      const file = paths.epicFile(epic.epic_id);
      fs.writeFileSync(file, serializeEpic(epic));
      epicPaths.push(file);
    }

    return { prdPath: paths.prd, prdContent, epics, epicPaths, usage };
  }

  private async generateEpics(
    systemPrompt: string,
    briefContent: string,
    prdContent: string,
    startEpicNumber: number
  ): Promise<{ epics: EpicYaml[]; usage: LLMUsage }> {
    const firstId = epicId(startEpicNumber);
    // Mirrors the skillsBlock pattern in AnalystAgent: build the optional block
    // first and append it to the base message. When routing is absent the message
    // is byte-identical to the legacy baseline (NFR-1).
    const sizingBlock = this.ctx.routing
      ? buildSizingConstraintBlock(this.ctx.routing)
      : '';
    const baseUserMsg =
      'Perform Headless task B: produce the epic/story breakdown JSON.\n\n' +
      `IMPORTANT: number epics sequentially starting at "${firstId}". ` +
      `The first epic is "${firstId}", the next "${epicId(startEpicNumber + 1)}", and so on. ` +
      `Each story id uses its epic's number — e.g. the stories of "${firstId}" are ` +
      `"story-${firstId.slice(5)}-001", "story-${firstId.slice(5)}-002", etc.\n\n` +
      'PROJECT BRIEF:\n---\n' +
      briefContent +
      '\n\nPRD:\n---\n' +
      prdContent +
      sizingBlock;

    let usage: LLMUsage = { ...EMPTY_USAGE };
    let lastError = '';
    let lastResponse = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const messages: LLMMessage[] = [{ role: 'user', content: baseUserMsg }];
      if (lastError) {
        messages.push({ role: 'assistant', content: lastResponse });
        messages.push({
          role: 'user',
          content:
            `That output failed validation:\n${lastError}\n\n` +
            'Return a corrected response — a single fenced ```json block only.',
        });
      }

      const response = await this.ctx.llm.complete({
        model: this.ctx.model,
        system: [{ text: systemPrompt, cache: true }],
        messages,
      });
      usage = addUsage(usage, response.usage);
      lastResponse = response.text;

      try {
        const json = extractJsonBlock(response.text);
        const envelope = EpicsEnvelopeSchema.parse(json);
        // Cross-reference checks the schema cannot express: epic numbering and
        // dependency integrity. A failure here feeds back into the retry.
        const semanticError = validateEpicSet(envelope.epics, startEpicNumber);
        if (semanticError) {
          lastError = semanticError;
          continue;
        }
        return { epics: envelope.epics, usage };
      } catch (err) {
        lastError =
          err instanceof z.ZodError
            ? err.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
            : (err as Error).message;
      }
    }

    throw new Error(
      `PM agent failed to produce a valid epic breakdown after 2 attempts.\n` +
        `Last validation error:\n${lastError}`
    );
  }
}

/**
 * Validates cross-references the zod schema cannot express:
 *  - epic ids are sequential starting at the assigned start number
 *  - every story `dependencies` entry references a real story in this run
 * Returns an error string for the retry feedback, or null if the set is sound.
 */
export function validateEpicSet(
  epics: EpicYaml[],
  startEpicNumber: number
): string | null {
  const problems: string[] = [];

  // Epic numbering must be sequential from startEpicNumber.
  epics.forEach((epic, i) => {
    const expected = epicId(startEpicNumber + i);
    if (epic.epic_id !== expected) {
      problems.push(
        `  epic[${i}] id is "${epic.epic_id}" but must be "${expected}" ` +
          `(epics are numbered sequentially from ${epicId(startEpicNumber)})`
      );
    }
  });

  // Dependencies must reference a story that exists in this planning run.
  const allStoryIds = new Set<string>();
  const deps = new Map<string, string[]>();
  for (const epic of epics) {
    for (const story of epic.stories) {
      allStoryIds.add(story.id);
      deps.set(story.id, story.dependencies);
    }
  }
  for (const [storyId, storyDeps] of deps) {
    for (const dep of storyDeps) {
      if (!allStoryIds.has(dep)) {
        problems.push(
          `  story "${storyId}" depends on "${dep}", which is not a story ` +
            `in this plan — every dependency must reference a real story id`
        );
      }
      if (dep === storyId) {
        problems.push(`  story "${storyId}" lists itself as a dependency`);
      }
    }
  }

  // A dependency cycle would deadlock the Epic 3 supervisor — reject it.
  const cycle = findDependencyCycle(deps);
  if (cycle) {
    problems.push(`  dependency cycle detected: ${cycle.join(' -> ')}`);
  }

  return problems.length > 0 ? problems.join('\n') : null;
}

/** Returns the first dependency cycle as a path, or null if the graph is acyclic. */
function findDependencyCycle(deps: Map<string, string[]>): string[] | null {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  const dfs = (node: string, path: string[]): string[] | null => {
    state.set(node, VISITING);
    path.push(node);
    for (const next of deps.get(node) ?? []) {
      if (!deps.has(next)) continue; // dangling dep — reported separately
      if (state.get(next) === VISITING) {
        return [...path.slice(path.indexOf(next)), next];
      }
      if (state.get(next) === undefined) {
        const found = dfs(next, path);
        if (found) return found;
      }
    }
    path.pop();
    state.set(node, DONE);
    return null;
  };

  for (const node of deps.keys()) {
    if (state.get(node) === undefined) {
      const found = dfs(node, []);
      if (found) return found;
    }
  }
  return null;
}

function serializeEpic(epic: EpicYaml): string {
  const header =
    '# Generated by loom — PM persona (John)\n' +
    '# Validated against schemas/epic.schema.yaml\n';
  return header + yaml.dump(epic, { lineWidth: 100, noRefs: true });
}
