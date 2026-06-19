import { z } from 'zod';
import type { LLMClient } from '../llm/LLMClient.js';
import { INTAKE_TIMEOUT_DEFAULT_MS } from './intakeTimeout.js';

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
  'You are a software-brief classifier. Output ONLY a JSON object (no markdown, no prose) with exactly these fields:\n' +
  '- type: "feature" | "bug" | "chore"\n' +
  '- size: "story" | "epic"\n' +
  '- confidence: "low" | "medium" | "high"\n' +
  '- rationale: string (1–280 chars explaining the classification)';

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
  const timeoutMs = opts.timeoutMs ?? INTAKE_TIMEOUT_DEFAULT_MS;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new TriageTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    const response = await Promise.race([
      opts.llm.complete({
        model: opts.model,
        system: [{ text: CLASSIFY_SYSTEM }],
        messages: [{ role: 'user', content: brief }],
        maxTokens: 400,
      }),
      timeoutPromise,
    ]);
    clearTimeout(timerId);

    let raw: unknown;
    try {
      raw = JSON.parse(response.text);
    } catch (e) {
      return {
        ok: false,
        reason: 'invalid_output',
        detail: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
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
