import fs from 'node:fs';
import path from 'node:path';
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

// JS/TS keywords and builtins that appear in every code block but carry no
// semantic identity as contract symbols. Filtering these prevents spurious
// drift findings when a story removes a module-level `export` or renames
// a parameter typed as `string`.
const RESERVED_WORDS = new Set([
  'export', 'import', 'interface', 'class', 'function', 'type', 'const', 'let', 'var',
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'return', 'if', 'else',
  'for', 'while', 'new', 'this', 'enum', 'extends', 'implements', 'abstract', 'static',
  'public', 'private', 'protected', 'readonly', 'async', 'await', 'from', 'of', 'in',
  'default', 'any', 'never', 'object', 'unknown', 'true', 'false', 'namespace',
  'module', 'declare', 'throw', 'try', 'catch', 'finally', 'switch', 'case', 'break',
  'continue', 'delete', 'typeof', 'instanceof',
]);

// Only pure identifier spans (letters/digits/underscore, starting with a letter
// or underscore) are treated as pinned contract symbols from inline code spans.
// Complex expressions like `Map<K,V>` are skipped — \b anchors misfire on the
// non-word trailing character, causing false negatives in drift matching.
const PURE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Extracts pinned symbol names from fenced code blocks and inline code spans.
 * Returns a deduplicated array of identifier-like strings.
 * Symbols found only in prose (no code formatting) are NOT extracted.
 * JS/TS reserved words and identifiers of 2 or fewer characters are excluded.
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
  // Only pure identifiers are accepted — complex expressions (e.g. `Map<K,V>`)
  // are skipped to avoid regex-boundary mismatches during drift checking.
  const inlineSpanRe = /`([^`\n]+)`/g;
  let spanMatch: RegExpExecArray | null;
  while ((spanMatch = inlineSpanRe.exec(contractMarkdown)) !== null) {
    const spanStart = spanMatch.index;
    const inBlock = blockRanges.some(([start, end]) => spanStart >= start && spanStart < end);
    if (!inBlock) {
      const content = spanMatch[1].trim();
      if (content && PURE_IDENT_RE.test(content)) symbols.add(content);
    }
  }

  return Array.from(symbols).filter(s => s.length > 2 && !RESERVED_WORDS.has(s));
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
    // Context lines (space-prefixed, unchanged) count as evidence the symbol
    // still exists in the file. Without this check, removing a definition while
    // keeping usages in the same hunk would produce a spurious drift finding.
    const contextLines = lines.filter(l => l.startsWith(' '));

    for (const symbol of opts.contractSymbols) {
      const escaped = escapeRegexSymbol(symbol);
      const re = new RegExp('\\b' + escaped + '\\b');

      // Symbol present in added or context lines → still alive in this story.
      if (addedLines.some(l => re.test(l)) || contextLines.some(l => re.test(l))) continue;

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

  // Env-var gate: read .env.example and pass its variable names (or null if absent).
  const envExampleVars = readEnvExampleVars(opts.projectRoot);
  const undocumentedEnvVars = checkUndocumentedEnvVars({
    epicDiff: opts.epicDiff,
    envExampleVars,
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

/**
 * Reads .env.example from projectRoot and returns the set of documented
 * variable names. Returns null when the file is absent (caller emits notice).
 */
export function readEnvExampleVars(projectRoot: string): Set<string> | null {
  const envExamplePath = path.join(projectRoot, '.env.example');
  let content: string;
  try {
    content = fs.readFileSync(envExamplePath, 'utf8');
  } catch {
    console.warn(`[finalize] .env.example not found at ${envExamplePath} — skipping undocumented env-var gate`);
    return null;
  }

  const vars = new Set<string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    const name = eqIdx >= 0 ? trimmed.slice(0, eqIdx).trim() : trimmed;
    if (name) vars.add(name);
  }
  return vars;
}
