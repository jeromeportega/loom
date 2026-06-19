import { classifyIntake, type ClassifyResult } from './IntakeClassifier.js';
import { applyConservativeTiebreak } from './intakePrompt.js';
import type { LLMClient } from '../llm/LLMClient.js';

/**
 * Composed entry-point for the intake pipeline. Calls classifyIntake then
 * applies the conservative tiebreak (ADR-006): low-confidence story → epic.
 * Production code must call this instead of classifyIntake alone.
 */
export async function classifyWithTiebreak(
  brief: string,
  opts: { llm: LLMClient; model: string; timeoutMs?: number },
): Promise<ClassifyResult> {
  const result = await classifyIntake(brief, opts);
  if (!result.ok) return result;
  return { ok: true, verdict: applyConservativeTiebreak(result.verdict) };
}
