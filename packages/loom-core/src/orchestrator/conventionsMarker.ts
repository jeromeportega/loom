/** The marker a worker emits to share cross-cutting conventions/gotchas. */
export const CONVENTIONS_MARKER = 'LOOM_CONVENTIONS';

/** Maximum characters for a single convention text entry. */
export const MAX_CONVENTION_CHARS = 280;
/** Maximum number of convention entries per story. */
export const MAX_CONVENTIONS_PER_STORY = 8;
/** Maximum raw marker payload size — reject before parsing. */
export const MAX_CONVENTION_MARKER_CHARS = 2_000;

/**
 * Brace-walking parser cloned from parseSelfAssessment (selfAssessment.ts:24).
 * Never throws. Takes the LAST occurrence (the model may echo the format while
 * reasoning; the final emission is the real one). Rejects raw payloads above
 * MAX_CONVENTION_MARKER_CHARS. Truncates each text to MAX_CONVENTION_CHARS and
 * drops entries past MAX_CONVENTIONS_PER_STORY. Returns undefined when
 * absent/oversized/malformed so the story still succeeds (FR-3/AC4).
 */
export function parseConventions(output: string): string[] | undefined {
  if (!output) return undefined;

  const lastIdx = output.lastIndexOf(CONVENTIONS_MARKER);
  if (lastIdx === -1) return undefined;

  const afterMarker = output.slice(lastIdx + CONVENTIONS_MARKER.length);

  // Enforce raw payload size cap before any parsing.
  if (afterMarker.length > MAX_CONVENTION_MARKER_CHARS) return undefined;

  // Walk braces to extract the JSON object.
  const start = afterMarker.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let end = -1;
  for (let i = start; i < afterMarker.length; i++) {
    const ch = afterMarker[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(afterMarker.slice(start, end + 1));
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.conventions)) return undefined;

  const results: string[] = [];
  for (const item of obj.conventions) {
    if (typeof item !== 'string') continue;
    const text = item.slice(0, MAX_CONVENTION_CHARS);
    if (text.trim().length === 0) continue;
    results.push(text);
    if (results.length >= MAX_CONVENTIONS_PER_STORY) break;
  }

  return results.length > 0 ? results : undefined;
}

/**
 * The gated prompt block telling the worker it MAY end with the conventions
 * marker to share cross-cutting discoveries.
 */
export function conventionsInstruction(): string {
  return (
    '\n\n### Optional: share discovered conventions\n' +
    'If you discovered cross-cutting conventions or gotchas that future stories ' +
    'in this epic should know about, you MAY append a single line in EXACTLY this ' +
    `format (before the self-assessment line):\n\n` +
    `${CONVENTIONS_MARKER} {"conventions":["use ULID not UUID for ids","gate X behind flag Y"]}\n\n` +
    `- Each entry must be under ${MAX_CONVENTION_CHARS} characters.\n` +
    `- At most ${MAX_CONVENTIONS_PER_STORY} entries.\n` +
    '- Omit this line entirely if you have nothing to share.'
  );
}
