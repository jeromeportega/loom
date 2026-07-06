import type { RegressionFinding } from './FinalizeGates.js';
import { escapeRegexSymbol } from './FinalizeGates.js';

/**
 * Splits a unified diff into per-file sections using `diff --git` as the
 * boundary marker. Diffs without that header are returned as a single section.
 * This scopes context-line suppression to the file where the removal occurred,
 * preventing false negatives when a symbol is removed in one file but still
 * referenced in context lines of an unrelated file in the same diff.
 */
function splitDiffByFile(diff: string): string[] {
  const sections: string[] = [];
  const lines = diff.split('\n');
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections.filter(s => s.trim().length > 0);
}

/**
 * Returns the first removed line that represents a true regression in the diff,
 * or null if no regression is found.
 *
 * Context-line suppression is applied per-file section: if the symbol appears
 * in added or context lines within the same file as the removal, the removal is
 * not flagged (the symbol still exists there). This prevents false negatives from
 * unrelated files retaining context-line references to the removed symbol.
 */
function findRegressionLine(diff: string, re: RegExp): string | null {
  for (const section of splitDiffByFile(diff)) {
    const lines = section.split('\n');
    const addedLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = lines.filter(l => l.startsWith('-') && !l.startsWith('---'));
    const contextLines = lines.filter(l => l.startsWith(' '));

    if (addedLines.some(l => re.test(l)) || contextLines.some(l => re.test(l))) continue;

    const removedMatch = removedLines.find(l => re.test(l));
    if (removedMatch) return removedMatch;
  }
  return null;
}

/**
 * Checks story diffs and the aggregate epic diff for regressions against
 * symbols pinned in prior delivered-epic contracts.
 *
 * A regression is emitted when a prior symbol appears only in removed lines
 * (not in added or unchanged context lines) — meaning this epic deleted or
 * renamed something a previously-shipped epic exported.
 *
 * Deduplication: story diffs are checked before the aggregate epicDiff. Once a
 * regression is recorded for a (symbol, priorEpicId) pair, no further diffs are
 * checked for that pair — preventing duplicate findings when epicDiff aggregates
 * all story changes. Context-line suppression is applied per-file so a symbol's
 * remaining usages in unchanged files do not mask a genuine definition removal.
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

  // Story diffs are checked before the aggregate epicDiff so attribution names
  // the originating story where possible. Once a regression is found for a
  // (symbol, priorEpicId) pair, no further diffs are checked for that pair —
  // preventing duplicate findings when epicDiff is a superset of story diffs.
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
        const removedMatch = findRegressionLine(diff, re);
        if (removedMatch) {
          findings.push({ symbol, priorEpicId, storyId, lineSnippet: removedMatch });
          break; // One finding per (symbol, priorEpicId) — story attribution wins over epicDiff
        }
      }
    }
  }

  return findings;
}
