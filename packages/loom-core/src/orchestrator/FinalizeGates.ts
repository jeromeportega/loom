import { SharedContract } from './SharedContract.js';
import { checkUndocumentedEnvVars } from './GateEnvVar.js';
import { checkCrossEpicRegressions } from './GateRegression.js';

export type FinalizeGateMode = 'off' | 'warn' | 'block';

export interface SymbolDriftFinding {
  symbol: string;
  contractEpicId: string;
  storyId: string;
  lineSnippet: string;
}

export interface EnvVarFinding {
  varName: string;
  filePath: string;
  lineSnippet: string;
}

export interface RegressionFinding {
  symbol: string;
  priorEpicId: string;
  storyId: string;
  lineSnippet: string;
}

export interface FinalizeGatesResult {
  symbolDrift: SymbolDriftFinding[];
  undocumentedEnvVars: EnvVarFinding[];
  regressions: RegressionFinding[];
  /** true only when mode === 'block' AND at least one finding exists */
  hardFail: boolean;
}

/** Escapes a symbol string for safe use in new RegExp(escapeRegexSymbol(s)). */
export function escapeRegexSymbol(symbol: string): string {
  return symbol.replace(/[.*+?^${}()|[\]\\<>,]/g, '\\$&');
}

/**
 * Extracts pinned symbol names from fenced code blocks and inline code spans.
 * Returns a deduplicated array of identifier-like strings.
 * Symbols found only in prose (no code formatting) are NOT extracted.
 */
export function extractSymbolsFromContract(contractMarkdown: string): string[] {
  if (!contractMarkdown.trim()) return [];

  const symbols = new Set<string>();

  // Find fenced code blocks (```...```) and extract identifiers from them.
  // Track block ranges so we can skip inline spans inside blocks.
  const blockRanges: Array<[number, number]> = [];
  const fencedBlockRe = /^```[^\n]*\n([\s\S]*?)^```/gm;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = fencedBlockRe.exec(contractMarkdown)) !== null) {
    blockRanges.push([blockMatch.index, blockMatch.index + blockMatch[0].length]);
    const blockContent = blockMatch[1];
    const identRe = /[A-Za-z_][A-Za-z0-9_]*/g;
    let identMatch: RegExpExecArray | null;
    while ((identMatch = identRe.exec(blockContent)) !== null) {
      symbols.add(identMatch[0]);
    }
  }

  // Extract inline code spans not inside fenced blocks.
  const inlineSpanRe = /`([^`\n]+)`/g;
  let spanMatch: RegExpExecArray | null;
  while ((spanMatch = inlineSpanRe.exec(contractMarkdown)) !== null) {
    const spanStart = spanMatch.index;
    const inBlock = blockRanges.some(([start, end]) => spanStart >= start && spanStart < end);
    if (!inBlock) {
      const content = spanMatch[1].trim();
      if (content) symbols.add(content);
    }
  }

  return Array.from(symbols);
}

/**
 * Checks each story diff for symbol drift: a pinned contract symbol that was
 * removed or renamed. Uses word-boundary regex so `Token` does not match
 * inside `AuthToken`.
 *
 * Drift detection: for each symbol, if the symbol appears in the removed
 * lines (`-`) of a story diff but NOT in the added lines (`+`), the story
 * has removed or renamed the contract symbol.
 */
export function checkSymbolDrift(opts: {
  contractSymbols: string[];
  contractEpicId: string;
  storyDiffs: Map<string, string>;
}): SymbolDriftFinding[] {
  if (opts.contractSymbols.length === 0) return [];

  const findings: SymbolDriftFinding[] = [];

  for (const [storyId, diff] of opts.storyDiffs) {
    const lines = diff.split('\n');
    const addedLines = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = lines.filter(l => l.startsWith('-') && !l.startsWith('---'));

    for (const symbol of opts.contractSymbols) {
      const escaped = escapeRegexSymbol(symbol);
      const re = new RegExp('\\b' + escaped + '\\b');

      // Symbol present in added lines → story correctly uses the contract symbol.
      if (addedLines.some(l => re.test(l))) continue;

      // Symbol only in removed lines → was removed or renamed in this story.
      const removedMatch = removedLines.find(l => re.test(l));
      if (removedMatch) {
        findings.push({
          symbol,
          contractEpicId: opts.contractEpicId,
          storyId,
          lineSnippet: removedMatch,
        });
      }
    }
  }

  return findings;
}

/**
 * Orchestrates all three finalize gates. Called by EpicFinalizer after
 * IntegrationGate.run(). Returns early with all-empty findings when mode='off'.
 */
export async function runFinalizeGates(opts: {
  projectRoot: string;
  epicId: string;
  epicDiff: string;
  storyDiffs: Map<string, string>;
  mode: FinalizeGateMode;
  deliveredEpicIds: string[];
}): Promise<FinalizeGatesResult> {
  if (opts.mode === 'off') {
    return { symbolDrift: [], undocumentedEnvVars: [], regressions: [], hardFail: false };
  }

  // Read this epic's shared contract and extract its pinned symbols.
  const contractMarkdown = SharedContract.read(opts.projectRoot, opts.epicId) ?? '';
  const contractSymbols = extractSymbolsFromContract(contractMarkdown);

  // Symbol drift gate.
  const symbolDrift = checkSymbolDrift({
    contractSymbols,
    contractEpicId: opts.epicId,
    storyDiffs: opts.storyDiffs,
  });

  // Env-var gate (GateEnvVar.ts stub; story-077-003 provides the real implementation).
  const undocumentedEnvVars = checkUndocumentedEnvVars({
    epicDiff: opts.epicDiff,
    envExampleVars: null,
  });

  // Build prior-contract map for the regression gate.
  const priorContracts = new Map<string, string[]>();
  for (const priorEpicId of opts.deliveredEpicIds) {
    const md = SharedContract.read(opts.projectRoot, priorEpicId);
    if (md) {
      priorContracts.set(priorEpicId, extractSymbolsFromContract(md));
    }
  }

  // Regression gate (GateRegression.ts stub; story-077-004 provides the real implementation).
  const regressions = checkCrossEpicRegressions({
    epicDiff: opts.epicDiff,
    storyDiffs: opts.storyDiffs,
    priorContracts,
  });

  const hasFindings =
    symbolDrift.length > 0 || undocumentedEnvVars.length > 0 || regressions.length > 0;
  const hardFail = opts.mode === 'block' && hasFindings;

  return { symbolDrift, undocumentedEnvVars, regressions, hardFail };
}
