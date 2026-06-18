/**
 * Small shared helpers for the durable-telemetry renderers (StoryHandoff,
 * StoryContext). Kept in one place so a future change — e.g. Unicode-aware
 * truncation — is a single-point fix.
 */

/** Collapse whitespace and truncate a rationale to a single compact line. */
export function oneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed;
}

/**
 * Return the model id for display. NULL, undefined, or empty string all
 * render as the literal 'unknown' — never a guessed or policy-default value.
 * Only the model id string is returned; no keys, endpoints, or credentials.
 */
export function displayModel(model: string | null | undefined): string {
  return model || 'unknown';
}
