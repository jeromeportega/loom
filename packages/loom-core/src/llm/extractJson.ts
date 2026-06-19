import { escapeBareControlsInStrings } from '../planner/util.js';

/**
 * Extracts a JSON object from an LLM response that may be wrapped in prose or
 * markdown fences. Tries each '{' in the text as a candidate start to handle
 * responses with leading prose, an assistant-turn prefill artifact, or both.
 *
 * Two-pass: strict JSON.parse first; on failure, retries after escaping bare
 * \n/\r/\t inside string literals (models routinely emit literal newlines in
 * string values, which strict parsing rejects as "Unterminated string").
 *
 * Throws a descriptive error if no JSON object is recoverable; caller
 * should Zod-validate the returned value.
 */
export function extractJsonObject(text: string): unknown {
  // 1. Try fenced block first (```json or plain ```)
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    return parseTolerant(fenced[1].trim(), text);
  }

  // 2. Scan for each '{' and return the first bracket-balanced JSON object.
  //    Trying every start position handles leading prose, a stray leading '{'
  //    from an assistant prefill, or both simultaneously.
  const candidate = findJsonObject(text);
  if (candidate !== null) {
    return parseTolerant(candidate, text);
  }

  // 3. Fallback: parse the whole trimmed text (pure unfenced JSON with no prose).
  return parseTolerant(text.trim(), text);
}

function parseTolerant(candidate: string, original: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch (strictErr) {
    try {
      return JSON.parse(escapeBareControlsInStrings(candidate));
    } catch {
      throw new Error(
        `Expected a JSON object in the LLM response but could not parse one.\n` +
          `Parse error: ${(strictErr as Error).message}\n` +
          `Response (first 500 chars): ${original.slice(0, 500)}`,
      );
    }
  }
}

/**
 * Scans the text for the first '{' that has a bracket-balanced matching '}'.
 * Handles nested objects and ignores braces inside quoted strings, including
 * \" escape sequences. Returns the balanced substring, or null if none found.
 */
function findJsonObject(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === '{') {
          depth++;
        } else if (c === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}
