import { z } from 'zod';
import type { LLMClient } from '../llm/LLMClient.js';
import { buildIntakeSizingInstruction } from './intakePrompt.js';

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

// Forceful JSON-only directive. Even with explicit instructions models may wrap
// JSON in markdown fences or prefix with prose. The assistant prefill ('{') forces
// the model to begin the JSON object immediately; this contract makes the
// requirement maximally explicit in the system prompt.
export const INTAKE_OUTPUT_CONTRACT =
  'IMPORTANT: Respond with ONLY a raw JSON object. No markdown fences, no prose,\n' +
  'no preamble, no commentary. Your response must begin immediately with `{`.\n' +
  'The object must contain EXACTLY these fields:\n' +
  '  "type": "feature" | "bug" | "chore"\n' +
  '  "size": "story" | "epic"\n' +
  '  "confidence": "low" | "medium" | "high"\n' +
  '  "rationale": a string 1–280 characters explaining the classification';

const TYPE_INSTRUCTION = [
  'Feature: a new capability or an improvement to existing user-facing functionality.',
  'Bug: unintended behavior, a regression, or an error that affects correctness.',
  'Chore: maintenance, dependency updates, tooling, or cleanup with no user-visible change.',
];

// The assistant prefill begins the JSON object, guiding the model to continue
// from '{' rather than prepend prose or markdown fences.
const ASSISTANT_PREFILL = '{';

class TriageTimeoutError extends Error {
  constructor(ms: number) {
    super(`triage call exceeded ${ms}ms`);
    this.name = 'TriageTimeoutError';
  }
}

/**
 * Extracts a parseable JSON string from a raw LLM response. Handles:
 * - Pure JSON (passthrough)
 * - Markdown-fenced JSON (strips fences)
 * - Prose + embedded JSON (extracts first { … } block)
 * - Continuation text when the model continued from the assistant prefill '{'
 *   (no opening brace in the response; prepends it)
 */
function recoverJsonText(text: string): string {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  // No JSON object found — assume the text is a continuation from the assistant
  // prefill '{' and prepend it to form a complete JSON string.
  return ASSISTANT_PREFILL + trimmed;
}

export async function classifyIntake(
  brief: string,
  opts: { llm: LLMClient; model: string; timeoutMs?: number },
): Promise<ClassifyResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new TriageTimeoutError(timeoutMs)), timeoutMs);
  });

  const systemPrompt = [
    INTAKE_OUTPUT_CONTRACT,
    buildIntakeSizingInstruction(),
    ...TYPE_INSTRUCTION,
  ].filter(Boolean).join('\n\n');

  try {
    const response = await Promise.race([
      opts.llm.complete({
        model: opts.model,
        system: [{ text: systemPrompt }],
        messages: [
          { role: 'user', content: brief },
          { role: 'assistant', content: ASSISTANT_PREFILL },
        ],
        maxTokens: 400,
      }),
      timeoutPromise,
    ]);
    clearTimeout(timerId);

    let raw: unknown;
    try {
      raw = JSON.parse(recoverJsonText(response.text));
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
