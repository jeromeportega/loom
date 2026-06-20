import type { SelfAssessment, SignalLevel } from '../types.js';
import { extractJsonObject } from './jsonExtract.js';

/** The marker a worker emits to self-rate its completed work (B1). */
export const SELF_ASSESSMENT_MARKER = 'LOOM_SELF_ASSESSMENT';

const LEVELS: readonly SignalLevel[] = ['low', 'medium', 'high'];

function asLevel(v: unknown): SignalLevel | undefined {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
    ? (v as SignalLevel)
    : undefined;
}

/**
 * Extracts the worker's self-assessment from its output. The worker is asked to
 * end with a single line `LOOM_SELF_ASSESSMENT { ... json ... }`. We scan for the
 * LAST occurrence (the model may echo the format while reasoning; the final
 * emission is the real one) and parse the JSON object that follows the marker.
 *
 * Returns undefined when the marker is absent or malformed — the caller treats
 * that as "no signal", which the tier resolver maps to low confidence (fail
 * safe: review more, not less). Never throws.
 */
export function parseSelfAssessment(output: string): SelfAssessment | undefined {
  if (!output) return undefined;

  const lastIdx = output.lastIndexOf(SELF_ASSESSMENT_MARKER);
  if (lastIdx === -1) return undefined;

  const afterMarker = output.slice(lastIdx + SELF_ASSESSMENT_MARKER.length);
  const jsonStr = extractJsonObject(afterMarker);
  if (jsonStr === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const obj = parsed as Record<string, unknown>;
  const confidence = asLevel(obj.confidence);
  const complexity = asLevel(obj.complexity);
  // Confidence is the load-bearing field for the tier resolver; require it.
  if (!confidence) return undefined;

  return {
    confidence,
    complexity: complexity ?? 'medium',
    ...(typeof obj.note === 'string' && obj.note.trim().length > 0
      ? { note: obj.note.trim() }
      : {}),
  };
}

/**
 * The instruction block appended to a worker's implement prompt (gated on
 * adaptive cost control) telling it to end with the self-assessment marker.
 */
export function selfAssessmentInstruction(): string {
  return (
    '\n\n### Final step — self-assessment (required)\n' +
    'After you have finished the implementation and committed your work, end your ' +
    'final message with EXACTLY one line in this format (and nothing after it):\n\n' +
    `${SELF_ASSESSMENT_MARKER} {"confidence":"low|medium|high","complexity":"low|medium|high","note":"<one short phrase>"}\n\n` +
    '- `confidence`: how confident you are the work is correct and complete against ' +
    'the acceptance criteria.\n' +
    '- `complexity`: how complex the change turned out to be.\n' +
    'Be honest — loom uses this only to decide how much review effort to spend; it ' +
    'never changes whether your work is accepted. Under-rating risk just wastes review.'
  );
}
