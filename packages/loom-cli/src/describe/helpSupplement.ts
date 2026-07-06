import type { CommandDescription, PositionalArg } from './schema.js';

/**
 * Renders the "Values:" block for a single positional arg's valueMeanings map.
 * Returns '' when no valueMeanings are present. story-070-002 imports this to
 * produce byte-identical output in the no-level echo.
 */
export function renderValueMeanings(arg: PositionalArg): string {
  const meanings = arg.valueMeanings;
  if (!meanings || Object.keys(meanings).length === 0) return '';

  const entries = Object.entries(meanings);
  const maxLen = Math.max(...entries.map(([k]) => k.length));
  const lines = ['Values:'];
  for (const [value, meaning] of entries) {
    const pad = ' '.repeat(maxLen - value.length + 2);
    lines.push(`  ${value}${pad}— ${meaning}`);
  }
  return lines.join('\n');
}

/**
 * Renders the full "after"-help supplement for a command: a Values block (from
 * any arg with valueMeanings) and an Exit codes block (from spec.exitCodes).
 * Returns '' when the spec has neither, so the caller can guard before appending.
 */
export function renderHelpSupplement(spec: CommandDescription): string {
  const parts: string[] = [];

  for (const arg of spec.arguments) {
    const block = renderValueMeanings(arg);
    if (block) parts.push(block);
  }

  if (spec.exitCodes.length > 0) {
    const maxCodeLen = Math.max(...spec.exitCodes.map(e => String(e.code).length));
    const lines = ['Exit codes:'];
    for (const ec of spec.exitCodes) {
      const codeStr = String(ec.code).padEnd(maxCodeLen);
      lines.push(`  ${codeStr}  ${ec.meaning}`);
    }
    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}
