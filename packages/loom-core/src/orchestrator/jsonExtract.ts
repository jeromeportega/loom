/**
 * Extracts the balanced JSON object that starts at the first '{' in afterMarker.
 * Brace-walks to find the matching close — trailing prose on the same line does
 * not break extraction. Returns undefined when '{' is absent or braces are
 * unbalanced (e.g. truncated output). Never throws.
 *
 * Callers are responsible for slicing the string to start after their marker
 * and for enforcing any size cap BEFORE calling this function.
 */
export function extractJsonObject(afterMarker: string): string | undefined {
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
  return afterMarker.slice(start, end + 1);
}
