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
   * True when the tech_notes enrichment step genuinely FAILED — no attempt ever
   * parsed (provider errors / unparseable output after retries), as opposed to a
   * model that parsed cleanly but returned an empty map. The planning gate hard-
   * blocks on this; a valid-empty result is only a soft warning.
   */
  techNotesEnrichmentFailed: boolean;
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
      techNotesEnrichmentFailed: techNotes.failed,
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
  ): Promise<{ map: Record<string, string>; usage: LLMUsage; failed: boolean }> {
    // tech_notes drive worker execution quality, so an empty/unparseable result
    // is worth retrying: under resource contention a single call can come back
    // truncated or malformed, silently yielding zero enrichment. Retry the whole
    // call (a fresh attempt, not a continuation) on a provider error, a parse
    // failure, OR an empty map. Usage accrues across attempts.
    //
    // `failed` distinguishes a genuine enrichment FAILURE (no attempt ever parsed
    // — provider errors / unparseable output, the epic-086 contention scenario)
    // from a valid-but-empty result (the model parsed cleanly but returned no
    // notes). Only a true failure trips the downstream planning gate's hard block;
    // a valid-empty map is a soft warning — this keeps the gate from firing on a
    // model that legitimately returns `{}` while still catching the failure mode.
    const MAX_ATTEMPTS = 2;
    let usage: LLMUsage = { ...EMPTY_USAGE };
    let lastParsed: Record<string, string> | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await this.ctx.llm.complete({
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
      } catch {
        // Provider error (rate limit / network / timeout) — retry if budget remains.
        continue;
      }
      usage = addUsage(usage, response.usage);

      try {
        const json = extractJsonBlock(response.text);
        const envelope = TechNotesEnvelopeSchema.parse(json);
        lastParsed = envelope.tech_notes; // a successful parse (even if empty)
        if (Object.keys(envelope.tech_notes).length > 0) {
          return { map: envelope.tech_notes, usage, failed: false };
        }
        // Parsed but empty — retry for better coverage, but this is NOT a failure.
      } catch {
        // Parse failure — retry if budget remains.
      }
    }

    // Retries exhausted. failed=true ONLY when no attempt ever parsed successfully
    // (all provider errors / unparseable) — the case the gate hard-blocks.
    return { map: lastParsed ?? {}, usage, failed: lastParsed === null };
  }
}
