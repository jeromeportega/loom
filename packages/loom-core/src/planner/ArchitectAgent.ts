import fs from 'node:fs';
import { z } from 'zod';
import type { EpicYaml } from '../types.js';
import type { LLMUsage } from '../llm/index.js';
import { addUsage, EMPTY_USAGE } from '../llm/index.js';
import type { PlannerContext } from './context.js';
import { PersonaLoader } from './PersonaLoader.js';
import { planningPaths } from './paths.js';
import { extractJsonBlock, trimToFirstHeading } from './util.js';
import { serializeEpic } from './epicSerializer.js';

const TechNotesEnvelopeSchema = z.object({
  tech_notes: z.record(z.string(), z.string()),
});

export interface ArchitectResult {
  architecturePath: string;
  architectureContent: string;
  /** Epics with tech_notes merged into each story. */
  epics: EpicYaml[];
  storiesEnriched: number;
  storiesMissingNotes: string[];
  /**
   * Epic-wide shared implementation contract (interfaces + ownership map),
   * produced only when ctx.sharedContract is on. Undefined otherwise. The
   * Planner persists it per-epic for worker-prompt injection at dispatch.
   */
  sharedContract?: string;
  usage: LLMUsage;
}

/**
 * Winston — the System Architect. Produces architecture.md and appends
 * per-story tech_notes to the epic YAML files, running fully headless.
 */
export class ArchitectAgent {
  constructor(private ctx: PlannerContext) {}

  async run(prdContent: string, epics: EpicYaml[]): Promise<ArchitectResult> {
    const persona = PersonaLoader.load('architect');
    const paths = planningPaths(this.ctx.planningRoot, this.ctx.runId);
    let usage: LLMUsage = { ...EMPTY_USAGE };

    const epicsJson = JSON.stringify({ epics }, null, 2);

    // ─── Task A: architecture document ───────────────────────────────────────
    const archResponse = await this.ctx.llm.complete({
      model: this.ctx.model,
      system: [{ text: persona.systemPrompt, cache: true }],
      messages: [
        {
          role: 'user',
          content:
            'Perform Headless task A: produce the architecture document.\n\n' +
            'PRD:\n---\n' +
            prdContent +
            '\n\nEPIC BREAKDOWN:\n---\n' +
            epicsJson,
        },
      ],
    });
    usage = addUsage(usage, archResponse.usage);
    const architectureContent = trimToFirstHeading(archResponse.text);

    fs.mkdirSync(paths.runDir, { recursive: true });
    fs.writeFileSync(paths.architecture, architectureContent + '\n');

    // ─── Task B: per-story tech_notes ────────────────────────────────────────
    const techNotes = await this.generateTechNotes(
      persona.systemPrompt,
      architectureContent,
      epicsJson
    );
    usage = addUsage(usage, techNotes.usage);

    // ─── Merge tech_notes into epics and rewrite YAML ────────────────────────
    let enriched = 0;
    const missing: string[] = [];
    for (const epic of epics) {
      for (const story of epic.stories) {
        const note = techNotes.map[story.id];
        if (note && note.trim().length > 0) {
          story.tech_notes = note.trim();
          enriched++;
        } else {
          missing.push(story.id);
        }
      }
      fs.writeFileSync(paths.epicFile(epic.epic_id), serializeEpic(epic));
    }

    // ─── Task C: epic-wide shared contract (opt-in) ──────────────────────────
    let sharedContract: string | undefined;
    if (this.ctx.sharedContract) {
      const contract = await this.generateSharedContract(
        persona.systemPrompt,
        architectureContent,
        epicsJson
      );
      usage = addUsage(usage, contract.usage);
      sharedContract = contract.text;
    }

    return {
      architecturePath: paths.architecture,
      architectureContent,
      epics,
      storiesEnriched: enriched,
      storiesMissingNotes: missing,
      sharedContract,
      usage,
    };
  }

  /**
   * Headless task C — the epic-wide shared contract (interfaces + ownership
   * map). Returns an empty string on a blank/unusable response so the planner
   * simply writes no contract file (injection then no-ops) rather than aborting
   * the run; the contract is alignment enrichment, not a hard dependency.
   */
  private async generateSharedContract(
    systemPrompt: string,
    architectureContent: string,
    epicsJson: string
  ): Promise<{ text: string; usage: LLMUsage }> {
    try {
      const response = await this.ctx.llm.complete({
        model: this.ctx.model,
        system: [{ text: systemPrompt, cache: true }],
        messages: [
          {
            role: 'user',
            content:
              'Perform Headless task C: produce the shared implementation contract.\n\n' +
              'ARCHITECTURE:\n---\n' +
              architectureContent +
              '\n\nEPIC BREAKDOWN:\n---\n' +
              epicsJson,
          },
        ],
      });
      return { text: trimToFirstHeading(response.text).trim(), usage: response.usage };
    } catch {
      // The contract is alignment enrichment, not a hard dependency. A provider
      // error here (rate limit, network, timeout) must NOT abort the whole
      // planning run and discard the already-persisted architecture + enriched
      // YAML from Tasks A and B — write no contract file and carry on.
      return { text: '', usage: { ...EMPTY_USAGE } };
    }
  }

  private async generateTechNotes(
    systemPrompt: string,
    architectureContent: string,
    epicsJson: string
  ): Promise<{ map: Record<string, string>; usage: LLMUsage }> {
    const response = await this.ctx.llm.complete({
      model: this.ctx.model,
      system: [{ text: systemPrompt, cache: true }],
      messages: [
        {
          role: 'user',
          content:
            'Perform Headless task B: produce per-story tech_notes JSON.\n\n' +
            'ARCHITECTURE:\n---\n' +
            architectureContent +
            '\n\nEPIC BREAKDOWN (provide a tech_notes entry for every story id):\n---\n' +
            epicsJson,
        },
      ],
    });

    try {
      const json = extractJsonBlock(response.text);
      const envelope = TechNotesEnvelopeSchema.parse(json);
      return { map: envelope.tech_notes, usage: response.usage };
    } catch {
      // tech_notes are advisory enrichment — a parse failure should not abort
      // the whole planning run. Return an empty map; stories keep no notes.
      return { map: {}, usage: response.usage };
    }
  }
}
