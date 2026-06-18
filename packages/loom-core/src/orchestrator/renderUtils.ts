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
 * Returns the model id for display, or the literal string 'unknown' for
 * pre-migration rows whose model was never recorded. Never reveals credentials,
 * endpoints, or other secrets — only the bare model id string.
 */
export function displayModel(model: string | null | undefined): string {
  return model ?? 'unknown';
}
