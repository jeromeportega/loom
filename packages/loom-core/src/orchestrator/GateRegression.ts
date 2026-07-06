import type { RegressionFinding } from './FinalizeGates.js';

/**
 * Cross-epic regression gate. Pure.
 *
 * A symbol that a *prior delivered epic* pinned in its shared contract is a
 * regression when it was present in the tree *before* this epic (`basePresent`)
 * but is gone from the tree *after* this epic's integration (`headPresent`).
 * That "present-then-absent across this epic" test is what attributes the
 * removal to the current epic — a symbol that was already gone before this epic
 * started is not this epic's regression, and a symbol that is merely churned
 * (moved between files, reformatted) is still present at head and so is not
 * flagged. The presence sets come from `symbolsPresentInTree`, a whole-tree
 * grep, so a usage in any untouched file keeps the symbol alive.
 *
 * When priorContracts is empty, returns [].
 */
export function checkCrossEpicRegressions(opts: {
  priorContracts: Map<string, string[]>;
  basePresent: Set<string>;
  headPresent: Set<string>;
}): RegressionFinding[] {
  const findings: RegressionFinding[] = [];
  for (const [priorEpicId, symbols] of opts.priorContracts) {
    for (const symbol of symbols) {
      if (opts.basePresent.has(symbol) && !opts.headPresent.has(symbol)) {
        findings.push({ symbol, priorEpicId });
      }
    }
  }
  return findings;
}
