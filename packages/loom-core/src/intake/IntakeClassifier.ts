import { z } from 'zod';
import type { LLMClient } from '../llm/LLMClient.js';
import { extractJsonObject } from '../llm/extractJson.js';

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

const CLASSIFY_SYSTEM =
  'You are a software-brief classifier. You MUST respond with ONLY a raw JSON object — ' +
  'no markdown fences, no prose, no explanation before or after. ' +
  'The object MUST contain exactly these four fields:\n' +
  '- type: "feature" | "bug" | "chore"\n' +
  '- size: "story" | "epic"\n' +
  '- confidence: "low" | "medium" | "high"\n' +
  '- rationale: string (1–280 chars explaining the classification)\n' +
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
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new TriageTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    const response = await Promise.race([
      opts.llm.complete({
        model: opts.model,
        system: [{ text: CLASSIFY_SYSTEM }],
        messages: [
          { role: 'user', content: brief },
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
