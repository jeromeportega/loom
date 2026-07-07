import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SharedContract } from './SharedContract.js';
import { checkUndocumentedEnvVars } from './GateEnvVar.js';
import { checkCrossEpicRegressions } from './GateRegression.js';
import { checkDeadPolicyFields, type DeadFieldResult } from './GateDeadPolicyField.js';
import { checkNoProductionCallers, type NoCallerResult } from './GateNoProductionCaller.js';

export type FinalizeGateMode = 'off' | 'warn' | 'block';

export interface SymbolDriftFinding {
  symbol: string;
  contractEpicId: string;
}

export interface EnvVarFinding {
  varName: string;
  filePath: string;
  lineSnippet: string;
}

export interface RegressionFinding {
  symbol: string;
  priorEpicId: string;
}

export interface FinalizeGatesResult {
  symbolDrift: SymbolDriftFinding[];
  undocumentedEnvVars: EnvVarFinding[];
  regressions: RegressionFinding[];
  deadFields: DeadFieldResult;
  noCallers: NoCallerResult;
  /** true when mode === 'block' AND (undocumented env-var found
   *  OR deadFields.findings.length > 0 OR noCallers.findings.length > 0).
   *  Symbol drift and cross-epic regression are advisory and never contribute
   *  to hardFail. */
  hardFail: boolean;
}

// JS/TS keywords and builtins that appear in every code block but carry no
// semantic identity as contract symbols.
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
// or underscore) are treated as pinned contract symbols.
const PURE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A contract symbol is only "significant" enough to gate on if it looks like a
// real code identifier rather than an English word emphasised in prose:
//   • mixed-case  (PascalCase / camelCase) — `AuthToken`, `resolveTimeoutMs`
//   • UPPER_SNAKE containing an underscore — `AUTH_TOKEN_ID`, `MAX_RETRIES`
// This drops BOTH bare lowercase words (`when`, `team`, `state`) AND bare
// all-caps words (`OWNER`, `LAYER`, `STREAM`, `PRODUCER`) — the latter are the
// label/emphasis tokens loom's own prose-in-fence contracts are full of, and
// were the dominant residual false positive after the first narrowing pass.
// A token must also contain at least one letter, which drops artefacts like
// `_000` produced by tokenising a numeric separator (`30_000`).
// Precision over recall: a genuinely-pinned bare-word symbol (rare) is not
// gated, which is far cheaper than a finalize log full of the word "OWNER".
function isSignificantSymbol(s: string): boolean {
  if (!/[A-Za-z]/.test(s)) return false;
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  if (hasUpper && hasLower) return true; // PascalCase / camelCase
  if (!hasLower && s.includes('_')) return true; // UPPER_SNAKE constant / env var
  return false;
}

/**
 * Extracts pinned symbol names from fenced code blocks and inline code spans.
 * Returns a deduplicated array of identifier-like strings.
 * Symbols found only in prose (no code formatting) are NOT extracted; comment
 * text inside code fences is still tokenized — the significance filter below is
 * what keeps prose words out — and only "significant" identifiers (containing
 * an uppercase letter or underscore) survive. JS/TS reserved words and
 * identifiers of 2 or fewer characters are excluded.
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

  // Extract inline code spans not inside fenced blocks. Only pure identifiers
  // are accepted — complex expressions (e.g. `Map<K,V>`) are skipped.
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

  return Array.from(symbols).filter(
    s => s.length > 2 && !RESERVED_WORDS.has(s) && isSignificantSymbol(s)
  );
}

/**
 * Returns the subset of `symbols` that are present — as whole words — anywhere
 * in the git tree at `ref` (a branch name or commit sha), searched from
 * `treeRoot`. This is a *tree-wide* presence test, not a diff test: a symbol
 * that lives in a file this epic never touched still counts as present. That is
 * the whole point — "the contract pins symbol X" is only violated when X is
 * absent from the *entire delivered codebase*, not merely from one story's diff.
 *
 * Returns `null` when git grep could not run to completion (a bad ref, a git
 * error — anything other than the benign "no matches" exit code 1). Callers MUST
 * treat null as "unknown" and skip the gate rather than assume every symbol is
 * absent: flagging a whole contract on a transient git failure is exactly the
 * false-positive storm this rework exists to prevent.
 */
export function symbolsPresentInTree(
  treeRoot: string,
  ref: string,
  symbols: string[]
): Set<string> | null {
  if (symbols.length === 0) return new Set();

  // Chunk the patterns. A single git-grep over a ~1.5k-symbol alternation on a
  // real repo measured ~130s per ref; the same query in 50-symbol chunks yields
  // an identical present-set in ~13s. Any chunk that errors (bad ref, git
  // failure) fails the whole call to null — the caller then skips the gate
  // rather than treating "unknown" as "absent". A bad ref fails every chunk, so
  // this loses nothing; per-chunk maxBuffer overflow is now implausible at 50.
  const CHUNK = 50;
  const requested = new Set(symbols);
  const present = new Set<string>();

  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const patternArgs: string[] = [];
    for (const s of chunk) patternArgs.push('-e', s);

    let out: string;
    try {
      out = execFileSync(
        'git',
        // -w whole-word, -F fixed-string (symbols are literal identifiers),
        // -o only the matched token, -h no filename prefix, -I skip binary.
        ['grep', '-w', '-F', '-o', '-h', '-I', ...patternArgs, ref],
        {
          cwd: treeRoot,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    } catch (err) {
      const e = err as { status?: number };
      // Exit 1 = this chunk matched nothing: a legitimate "none present".
      if (e.status === 1) continue;
      // Any other failure = we genuinely do not know. Signal the caller to skip.
      return null;
    }

    for (const rawLine of out.split('\n')) {
      // With -o -h each line is a matched token, but guard against any residual
      // `path:token` prefix by also checking the last colon-delimited field.
      const line = rawLine.trim();
      if (!line) continue;
      if (requested.has(line)) {
        present.add(line);
        continue;
      }
      const tail = line.slice(line.lastIndexOf(':') + 1).trim();
      if (requested.has(tail)) present.add(tail);
    }
  }
  return present;
}

/**
 * Symbol-drift gate. Pure. A pinned contract symbol that is NOT present in the
 * integrated tree (see `symbolsPresentInTree`) has been renamed or dropped:
 * the epic promised a seam by that name and did not deliver it.
 */
export function checkSymbolDrift(opts: {
  contractSymbols: string[];
  contractEpicId: string;
  presentSymbols: Set<string>;
}): SymbolDriftFinding[] {
  return opts.contractSymbols
    .filter(s => !opts.presentSymbols.has(s))
    .map(symbol => ({ symbol, contractEpicId: opts.contractEpicId }));
}

/**
 * Orchestrates all three finalize gates. Called by EpicFinalizer after
 * IntegrationGate.run(). Returns early with all-empty findings when mode='off'.
 *
 * Contracts are read from `contractRoot` (the real repo root, where the
 * untracked `.loom/contract/` artifacts are written at plan time) while symbol
 * presence is tested against the integrated tree at `treeRoot` (which, in
 * rolling mode, is a dedicated integration worktree that does NOT carry the
 * untracked contract files). Conflating the two is what made the gate silently
 * no-op in loom's own rolling-integration configuration.
 */
export async function runFinalizeGates(opts: {
  contractRoot: string;
  treeRoot: string;
  headRef: string;
  baseRef: string;
  epicId: string;
  epicDiff: string;
  mode: FinalizeGateMode;
  deliveredEpicIds: string[];
}): Promise<FinalizeGatesResult> {
  const emptyNoCallers: NoCallerResult = { findings: [], scannedSymbols: [], durationMs: 0 };
  const emptyDeadFields: DeadFieldResult = { findings: [], scannedFields: [], durationMs: 0 };
  if (opts.mode === 'off') {
    return { symbolDrift: [], undocumentedEnvVars: [], regressions: [], deadFields: emptyDeadFields, noCallers: emptyNoCallers, hardFail: false };
  }

  // ── Symbol-drift gate: this epic's own pinned symbols must exist at head. ──
  const contractMarkdown = SharedContract.read(opts.contractRoot, opts.epicId) ?? '';
  const contractSymbols = extractSymbolsFromContract(contractMarkdown);
  const ownPresent =
    contractSymbols.length > 0
      ? symbolsPresentInTree(opts.treeRoot, opts.headRef, contractSymbols)
      : new Set<string>();
  if (ownPresent === null && contractSymbols.length > 0) {
    console.warn(`[finalize] contract-drift gate skipped for ${opts.epicId} — git grep unavailable at ${opts.headRef}`);
  }
  const symbolDrift =
    ownPresent === null
      ? [] // grep unavailable → skip rather than flag every pinned symbol
      : checkSymbolDrift({
          contractSymbols,
          contractEpicId: opts.epicId,
          presentSymbols: ownPresent,
        });

  // ── Env-var gate: newly-read env vars must be documented in .env.example. ──
  const envExampleVars = readEnvExampleVars(opts.treeRoot);
  const undocumentedEnvVars = checkUndocumentedEnvVars({
    epicDiff: opts.epicDiff,
    envExampleVars,
  });

  // ── Cross-epic regression gate: a symbol a prior delivered epic pinned that
  // was present before this epic but is gone at head → this epic dropped a
  // previously-shipped seam. Union all prior symbols into a single grep pair. ──
  const priorContracts = new Map<string, string[]>();
  const priorUnion = new Set<string>();
  for (const priorEpicId of opts.deliveredEpicIds) {
    if (priorEpicId === opts.epicId) continue;
    const md = SharedContract.read(opts.contractRoot, priorEpicId);
    if (!md) continue;
    const syms = extractSymbolsFromContract(md);
    if (syms.length === 0) continue;
    priorContracts.set(priorEpicId, syms);
    for (const s of syms) priorUnion.add(s);
  }
  let regressions: RegressionFinding[] = [];
  if (priorUnion.size > 0) {
    const union = Array.from(priorUnion);
    const basePresent = symbolsPresentInTree(opts.treeRoot, opts.baseRef, union);
    const headPresent = symbolsPresentInTree(opts.treeRoot, opts.headRef, union);
    if (basePresent !== null && headPresent !== null) {
      regressions = checkCrossEpicRegressions({ priorContracts, basePresent, headPresent });
    } else {
      console.warn(`[finalize] cross-epic regression gate skipped for ${opts.epicId} — git grep unavailable`);
    }
  }

  // ── Dead-policy-field gate: agents schema fields with zero production reads. ──
  // Use treeRoot (not contractRoot): the schema lives at the project root, not the
  // .loom/ contract directory. contractRoot and treeRoot differ in rolling-integration
  // mode; conflating them causes this gate to silently no-op when run in production.
  const schemaPath = path.join(opts.treeRoot, 'schemas', 'policy.schema.yaml');
  const deadFields = checkDeadPolicyFields({ schemaPath, projectRoot: opts.treeRoot });
  for (const f of deadFields.findings) {
    console.warn(`[finalize] dead policy field: '${f.field}' — ${f.reason}`);
  }

  // ── No-production-caller gate: exported symbols in the diff that are only
  // called by test files are flagged as possibly-cosmetic wiring. ──────────────
  const noCallers = checkNoProductionCallers({
    epicDiff: opts.epicDiff,
    projectRoot: opts.treeRoot,
  });

  // The undocumented-env-var, dead-policy-field, and no-production-caller gates
  // are precise enough to WITHHOLD a PR: all are exact set-membership / pattern
  // tests with allowlists, so their findings are real. Symbol drift and
  // cross-epic regression are heuristics — always advisory, never hard-fail.
  const hardFail =
    opts.mode === 'block' &&
    (undocumentedEnvVars.length > 0 ||
      deadFields.findings.length > 0 ||
      noCallers.findings.length > 0);

  return { symbolDrift, undocumentedEnvVars, regressions, deadFields, noCallers, hardFail };
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
