/**
 * Extracts a JSON object from an LLM response. Accepts a fenced ```json block,
 * a bare ``` block, or raw JSON. Throws a descriptive error if nothing parses.
 *
 * Two-pass: strict JSON.parse first; on failure, retry after escaping bare
 * \n/\r/\t inside string literals. Models routinely emit multi-paragraph
 * markdown content as JSON string values with literal newlines, which strict
 * parsing rejects ("Unterminated string"). The fallback is a no-op for
 * well-formed JSON.
 */
export function extractJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch (strictErr) {
    try {
      return JSON.parse(escapeBareControlsInStrings(candidate));
    } catch {
      throw new Error(
        `Expected a JSON object in the LLM response but could not parse one.\n` +
          `Parse error: ${(strictErr as Error).message}\n` +
          `Response (first 500 chars): ${text.slice(0, 500)}`
      );
    }
  }
}

/**
 * Walks the text and escapes bare \n/\r/\t that appear INSIDE JSON string
 * literals. Anything outside a string literal — keys, whitespace between
 * tokens, structural braces — is passed through unchanged. The escape state
 * machine recognises \" and \\ so closing quotes are tracked correctly.
 *
 * Exported for unit testing.
 */
export function escapeBareControlsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === '\\' && inString) {
      out += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      if (c === '\n') {
        out += '\\n';
        continue;
      }
      if (c === '\r') {
        out += '\\r';
        continue;
      }
      if (c === '\t') {
        out += '\\t';
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Strips a leading conversational preamble so the result starts at the first
 * Markdown heading. Headless persona prompts ask for "no preamble" but this is
 * a cheap safety net for when a model adds one anyway.
 */
export function trimToFirstHeading(text: string): string {
  const idx = text.indexOf('\n# ');
  if (text.startsWith('# ')) return text.trim();
  if (idx >= 0) return text.slice(idx + 1).trim();
  return text.trim();
}
