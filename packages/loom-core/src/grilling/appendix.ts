import type { ResolvedDecision } from './types.js';

/**
 * Appends a human-readable "Resolved Assumptions and Decisions" section to the
 * brief that the Analyst will consume, so the grilling gate's resolutions travel
 * downstream as explicit, sourced context instead of silent assumptions. Pure —
 * returns a new string and never mutates `brief`. When there are no decisions the
 * heading is still emitted (an empty grilling result is a real, recordable state).
 */
export function appendResolvedDecisionsAppendix(
  brief: string,
  decisions: ResolvedDecision[],
): string {
  const lines = ['## Resolved Assumptions and Decisions', ''];
  for (const d of decisions) {
    let bullet = `- **${d.text}** — ${d.answer} *(tag: ${d.tag})*`;
    if (d.citation) {
      bullet += ` ([\`${d.citation}\`](${d.citation}))`;
    }
    lines.push(bullet);
  }
  return `${brief}\n\n${lines.join('\n')}`;
}
