import { z } from 'zod';
import type { LLMClient } from '../llm/LLMClient.js';
import { extractJsonObject } from '../llm/extractJson.js';
import { INTAKE_TIMEOUT_DEFAULT_MS, INTAKE_TIMEOUT_FLOOR_MS } from './intakeTimeout.js';

export const IntakeVerdictSchema = z.object({
  type:       z.enum(['feature', 'bug', 'chore']),
  size:       z.enum(['story', 'epic']),
  confidence: z.enum(['low', 'medium', 'high']),
  rationale:  z.string().min(1).max(280),
});
export type IntakeVerdict = z.infer<typeof IntakeVerdictSchema>;

export type ClassifyResult =
  | { ok: true;  verdict: IntakeVerdict }
  | { ok: false; reason: 'llm_error' | 'timeout' | 'invalid_output'; detail: string };

export const INTAKE_AUDIT_ACTION = 'intake_classified' as const;

// CLOSED-BOOK: no tools, no file access, no codebase lookup — classify from text alone.
const CLASSIFY_SYSTEM =
  '### TEXT CLASSIFIER — CLOSED-BOOK ###\n' +
  'You are a software-brief TEXT CLASSIFIER. This is a read-only classification task.\n\n' +
  'MANDATORY RULES:\n' +
  '1. DO NOT use any tools. DO NOT read files. DO NOT search the repository.\n' +
  '2. Classify ONLY from the brief text provided in this message. Never verify it against code.\n' +
  '3. Respond with ONLY a raw JSON object — no markdown fences, no prose, no explanation.\n\n' +
  'The JSON object MUST contain exactly these four fields:\n' +
  '- type: "feature" | "bug" | "chore"\n' +
  '- size: "story" | "epic"\n' +
  '- confidence: "low" | "medium" | "high"\n' +
  '- rationale: string (1–280 chars — base this solely on the brief text)\n' +
  'Do NOT wrap the object in backticks. Output the raw JSON and nothing else.';

class TriageTimeoutError extends Error {
  constructor(ms: number) {
    super(`triage call exceeded ${ms}ms`);
    this.name = 'TriageTimeoutError';
  }
}

export async function classifyIntake(
  brief: string,
  opts: { llm: LLMClient; model: string; timeoutMs?: number },
): Promise<ClassifyResult> {
  const effectiveTimeoutMs = Math.max(
    opts.timeoutMs ?? INTAKE_TIMEOUT_DEFAULT_MS,
    INTAKE_TIMEOUT_FLOOR_MS,
  );

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new TriageTimeoutError(effectiveTimeoutMs)), effectiveTimeoutMs);
  });

  try {
    const response = await Promise.race([
      opts.llm.complete({
        model: opts.model,
        system: [{ text: CLASSIFY_SYSTEM }],
        messages: [
          {
            role: 'user',
            // Prefix makes it unambiguous this is a classification task, not a coding
            // request — prevents claude -p from searching the repo to "implement" the brief.
            content: `Classify the following software brief as JSON. Do NOT implement it.\n\n## Brief\n\n${brief}`,
          },
          { role: 'assistant', content: '{' },
        ],
        maxTokens: 400,
      }),
      timeoutPromise,
    ]);
    clearTimeout(timerId);

    // Re-prepend the '{' consumed by the assistant prefill so the full JSON
    // object is available to the extractor.
    const fullText = '{' + response.text;

    let raw: unknown;
    try {
      raw = extractJsonObject(fullText);
    } catch (e) {
      return {
        ok: false,
        reason: 'invalid_output',
        detail: `JSON extraction failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const parsed = IntakeVerdictSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: 'invalid_output', detail: parsed.error.message };
    }

    return { ok: true, verdict: parsed.data };
  } catch (e) {
    clearTimeout(timerId);
    if (e instanceof TriageTimeoutError) {
      return { ok: false, reason: 'timeout', detail: e.message };
    }
    return {
      ok: false,
      reason: 'llm_error',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
