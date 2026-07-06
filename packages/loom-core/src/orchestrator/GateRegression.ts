import type { RegressionFinding } from './FinalizeGates.js';
import { escapeRegexSymbol } from './FinalizeGates.js';

/**
 * Checks story diffs and the aggregate epic diff for regressions against
 * symbols pinned in prior delivered-epic contracts.
 *
 * A regression is emitted when a prior symbol appears only in removed lines
 * (not in added or unchanged context lines) — meaning this epic deleted or
 * renamed something a previously-shipped epic exported.
 *
 * When priorContracts is empty, returns [].
 */
export function checkCrossEpicRegressions(opts: {
  epicDiff: string;
  storyDiffs: Map<string, string>;
  priorContracts: Map<string, string[]>;
}): RegressionFinding[] {
  if (opts.priorContracts.size === 0) return [];

  const findings: RegressionFinding[] = [];

  // Build the ordered list of diffs to search. Story diffs are checked first
  // so attribution names the originating story where possible. The aggregate
  // epicDiff (storyId='') catches any changes that fall outside story-level
  // diffs (e.g. merge commits or auto-generated files).
  const diffsToCheck: Array<[string, string]> = [];
  for (const [storyId, diff] of opts.storyDiffs) {
    if (diff) diffsToCheck.push([storyId, diff]);
  }
  if (opts.epicDiff) diffsToCheck.push(['', opts.epicDiff]);

  if (diffsToCheck.length === 0) return [];

  for (const [priorEpicId, symbols] of opts.priorContracts) {
    for (const symbol of symbols) {
      const escaped = escapeRegexSymbol(symbol);
      const re = new RegExp('\\b' + escaped + '\\b');

      for (const [storyId, diff] of diffsToCheck) {
        const lines = diff.split('\n');
        const addedLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
        const removedLines = lines.filter(l => l.startsWith('-') && !l.startsWith('---'));
        // Context lines (space-prefixed, unchanged) count as evidence the
        // symbol still exists in this file, preventing false-positive reports
        // when a definition is removed while usages remain in the same hunk.
        const contextLines = lines.filter(l => l.startsWith(' '));

        // Symbol survives if it appears in added or context lines.
        if (addedLines.some(l => re.test(l)) || contextLines.some(l => re.test(l))) continue;

        const removedMatch = removedLines.find(l => re.test(l));
        if (removedMatch) {
          findings.push({
            symbol,
            priorEpicId,
            storyId,
            lineSnippet: removedMatch,
          });
        }
      }
    }
  }

  return findings;
}
