import fs from 'node:fs';
import type { LLMClient } from '../llm/LLMClient.js';
import type { DecisionTrace } from '../state/DecisionTraceStore.js';
import type { AuditLogEntry } from '../types.js';
import { Lesson } from './lesson.js';
import { extractJsonBlock } from '../planner/util.js';

/** Re-exported alias matching the shared contract's AuditRow name. */
export type AuditRow = AuditLogEntry;

/** Epic-level telemetry sent to the LLM as the user message. */
export interface EpicTelemetry {
  epic_id: string;
  final_status: 'done' | 'failed';
  decision_traces: DecisionTrace[];
  agents: { story_id: string; review_summary: string | null; log_tail: string | null }[];
  audit_tail: AuditRow[];
}

export interface LessonExtractorOptions {
  llm: LLMClient;
  model: string;
  skillMdPath: string;
}

// Appended after the cached SKILL.md body to lock the output shape (mirrors
// reviewerSkills.ts JSON_INSTRUCTIONS pattern — keeps per-call instructions
// out of the static cache boundary while overriding BMAD-era schema drift).
const JSON_INSTRUCTIONS = [
  '',
  '## Required output format (this OVERRIDES any output format described above)',
  'Respond with EXACTLY one ```json fenced code block and no prose outside it.',
  'Return {"lessons": [...]} where each lesson MUST have:',
  '  category (string), observation (string), general_rule (string).',
  'Each lesson MAY also have: root_cause (string), evidence (string).',
  'Do NOT include epic_id, created_at, applied_as, or applied_ref — added by the handler.',
  'An empty array is valid: {"lessons": []}',
].join('\n');

export class LessonExtractor {
  private readonly llm: LLMClient;
  private readonly model: string;
  private readonly skillMdPath: string;

  constructor(opts: LessonExtractorOptions) {
    this.llm = opts.llm;
    this.model = opts.model;
    this.skillMdPath = opts.skillMdPath;
  }

  async extract(telemetry: EpicTelemetry): Promise<Lesson[]> {
    // Empty contract (FR-5): no telemetry data → skip LLM entirely.
    if (
      telemetry.decision_traces.length === 0 &&
      telemetry.agents.length === 0 &&
      telemetry.audit_tail.length === 0
    ) {
      return [];
    }

    const skillMd = fs.readFileSync(this.skillMdPath, 'utf8');
    const systemText = skillMd + '\n' + JSON_INSTRUCTIONS;
    const userContent = JSON.stringify(telemetry);

    const attempt = async (): Promise<Lesson[] | 'malformed'> => {
      const response = await this.llm.complete({
        model: this.model,
        system: [{ text: systemText, cache: true }],
        messages: [{ role: 'user', content: userContent }],
        maxTokens: 2048,
        nonAgentic: { excludeDynamicSections: true },
      });
      try {
        const raw = extractJsonBlock(response.text) as { lessons?: unknown[] };
        if (!Array.isArray(raw?.lessons)) return 'malformed';
        const now = new Date().toISOString();
        return raw.lessons.map((item) => {
          const stamped = {
            ...(item as Record<string, unknown>),
            epic_id: telemetry.epic_id,
            created_at: now,
            applied_as: null,
            applied_ref: null,
          };
          return Lesson.parse(stamped);
        });
      } catch {
        return 'malformed';
      }
    };

    const first = await attempt();
    if (first !== 'malformed') return first;

    // Exactly one repair attempt on malformed output (FR-4).
    const second = await attempt();
    if (second !== 'malformed') return second;

    throw new Error('LessonExtractor: model returned malformed output on both attempts');
  }
}
