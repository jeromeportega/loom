/**
 * Token accounting for worker-context distillation (story-005).
 *
 * The compression target (`distilled <= 0.55 * source`) and the telemetry rows
 * are driven by a token count over both the raw and distilled context. The
 * Anthropic SDK does not ship a local tokenizer — the cache-telemetry path
 * (ClaudeCodeWorker, CursorAgentWorker) reads `input_tokens` straight off the
 * API `usage` block, which is unavailable here (we have no response, only the
 * text). So we approximate with the same heuristic the agentskills spec check
 * uses (`spec.ts`: ~4 characters per token).
 *
 * Both the numerator and denominator of the compression ratio use this one
 * function, so the ratio is internally consistent even though the absolute
 * counts are estimates. Whitespace and decorative characters the distiller
 * strips genuinely reduce the character count, so the proxy tracks real
 * compression.
 */

/** Average characters per token — the heuristic shared with `skills/spec.ts`. */
export const CHARS_PER_TOKEN = 4;

/**
 * Approximate the token count of a string. Deterministic and offline: collapses
 * runs of whitespace to a single space (a real tokenizer does not bill one token
 * per newline of indentation) then divides the remaining length by
 * {@link CHARS_PER_TOKEN}. Empty / whitespace-only input is 0 tokens.
 */
export function countTokens(text: string): number {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return 0;
  return Math.ceil(normalized.length / CHARS_PER_TOKEN);
}
