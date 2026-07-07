import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface NoCallerFinding {
  symbol: string;   // exported symbol name
  file: string;     // source file that exports it (repo-relative)
  callers: string[]; // all found call sites (all are test files)
}

export interface NoCallerResult {
  findings: NoCallerFinding[];
  scannedSymbols: string[];
  durationMs: number;
}

// Matches the +++ b/ header line in a unified diff to extract the file path.
const DIFF_FILE_RE = /^\+\+\+ b\/(.+)$/;

// Matches declaration-form exports in the content of an added diff line.
// Covers: function, async function, function*, class, abstract class,
//         const, let, var, interface, type, enum (non-default variants only).
// NOTE: `export default function/class` is intentionally NOT matched — callers
// import the default binding under an arbitrary local name, so grepping for the
// declared function/class name would miss most callers and produce false positives.
const EXPORT_DECL_RE =
  /^export\s+(?!default\s)(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)([A-Za-z_$][A-Za-z0-9_$]*)/;

// Matches named-form exports: export { foo, bar as baz } or export type { Foo }.
const NAMED_EXPORT_RE = /^export\s+(?:type\s+)?\{([^}]+)\}/;

// Annotation that unconditionally suppresses a no-production-caller finding.
const PUBLIC_API_ANNOTATION = '@loom-public-api';

/**
 * Returns true when `filePath` is a test file.
 * Covers the common conventions used in this monorepo:
 *   - *.test.ts / *.spec.ts (and .js/.mts/.mjs variants)
 *   - files under __tests__/ directory segments (including root-level __tests__/)
 *   - files under test/ directory segments (e.g. packages/loom-core/test/)
 */
function isTestFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  return (
    /[._]test\.[mc]?[jt]sx?$/.test(norm) ||
    /[._]spec\.[mc]?[jt]sx?$/.test(norm) ||
    /(^|\/)__tests__\//.test(norm) ||
    /(^|\/)test\//.test(norm)
  );
}

interface ExportEntry {
  symbol: string;
  file: string;
  annotated: boolean;
}

/**
 * Parses a unified diff and returns all exports found in added lines.
 * The `@loom-public-api` annotation on the immediately preceding non-blank
 * line (context or added) marks the following export as annotated.
 */
function extractExportsFromDiff(epicDiff: string): ExportEntry[] {
  const entries: ExportEntry[] = [];
  let currentFile = '';
  let prevContent = '';

  for (const rawLine of epicDiff.split('\n')) {
    // Track current file from diff headers; reset annotation state per file.
    const fileMatch = DIFF_FILE_RE.exec(rawLine);
    if (fileMatch) {
      currentFile = fileMatch[1];
      prevContent = '';
      continue;
    }

    // Hunk headers (@@ ... @@) reset the annotation state so an annotation in
    // one hunk cannot accidentally suppress an export in the next.
    if (rawLine.startsWith('@@')) {
      prevContent = '';
      continue;
    }

    // Skip removed diff lines (covers both the --- old-file header and any -prefixed
    // removal). Reset prevContent so a @loom-public-api annotation cannot bleed
    // forward through a removed declaration onto the next added export.
    if (rawLine.startsWith('-')) {
      prevContent = '';
      continue;
    }

    const isAdded = rawLine.startsWith('+') && !rawLine.startsWith('+++');
    const isContext = rawLine.startsWith(' ');
    if (!isAdded && !isContext) continue;

    const content = rawLine.slice(1); // strip leading +/space
    const trimmed = content.trim();

    if (isAdded && trimmed) {
      // Declaration-form: export function foo, export const bar, etc.
      const declMatch = EXPORT_DECL_RE.exec(trimmed);
      if (declMatch) {
        entries.push({
          symbol: declMatch[1],
          file: currentFile,
          annotated: prevContent.includes(PUBLIC_API_ANNOTATION),
        });
      }

      // Named-form: export { foo, bar as baz } or export type { Foo }.
      const namedMatch = NAMED_EXPORT_RE.exec(trimmed);
      if (namedMatch) {
        const annotated = prevContent.includes(PUBLIC_API_ANNOTATION);
        for (const part of namedMatch[1].split(',')) {
          // "local as exported" — the public name is the alias if present.
          const tokens = part.trim().split(/\s+as\s+/);
          const exportedName = (tokens[1] ?? tokens[0]).trim();
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportedName)) {
            entries.push({ symbol: exportedName, file: currentFile, annotated });
          }
        }
      }
    }

    // Track last non-blank line (context or added) for annotation detection.
    if (trimmed) prevContent = trimmed;
  }

  return entries;
}

/**
 * Searches `projectRoot` recursively for TypeScript/JavaScript source files
 * that mention `symbol` as a whole word. Returns repo-relative paths.
 * The export's own source file (`sourceFile`) is excluded.
 * Ignores node_modules, dist, and dist-test directories.
 *
 * Uses an explicit extended-regex word boundary (`[A-Za-z0-9_$]`) rather than
 * grep -w because -w treats `$` as a non-word character: searching for `stream$`
 * with -w would match inside `notstream$` since grep sees a boundary at `$`.
 * The explicit character class covers the full TypeScript identifier alphabet.
 */
function findCallers(symbol: string, sourceFile: string, projectRoot: string): string[] {
  // Escape $ in the symbol for use in an extended regex pattern.
  const escaped = symbol.replace(/\$/g, '\\$');
  const pattern = `(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`;

  let out: string;
  try {
    out = execFileSync(
      'grep',
      [
        '-r',                       // recursive
        '-l',                       // list matching files only (no line output)
        '-E',                       // extended regex (portable; macOS BSD grep supports -E)
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.mts',
        '--include=*.js',
        '--include=*.mjs',
        '--include=*.jsx',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '--exclude-dir=dist-test',
        '--exclude-dir=.git',
        '-e', pattern,
        projectRoot,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      }
    );
  } catch (err) {
    // grep exits 1 when no files match — that is not an error.
    const e = err as { status?: number };
    if (e.status === 1) return [];
    // Unexpected grep failure: treat as no callers found rather than crashing.
    return [];
  }

  const callers: string[] = [];
  for (const line of out.split('\n')) {
    const absPath = line.trim();
    if (!absPath) continue;
    const rel = path.relative(projectRoot, absPath).replace(/\\/g, '/');
    // Exclude the file that exports the symbol.
    if (rel === sourceFile || rel === sourceFile.replace(/\\/g, '/')) continue;
    callers.push(rel);
  }
  return callers;
}

/**
 * Static checker. Extracts every export added in `epicDiff`, searches
 * `projectRoot` for their import and call sites, and returns a finding for
 * each export whose only callers are test files (or that has no callers at
 * all).
 *
 * Rules:
 *  - An export annotated `// @loom-public-api` on the immediately preceding
 *    non-blank diff line is skipped unconditionally.
 *  - Zero callers is treated identically to all-test callers (flagged).
 *  - Cross-package imports count as production callers and suppress findings.
 *  - An empty `epicDiff` produces an empty result immediately.
 */
export function checkNoProductionCallers(opts: {
  epicDiff: string;
  projectRoot: string;
}): NoCallerResult {
  const start = Date.now();

  if (!opts.epicDiff.trim()) {
    return { findings: [], scannedSymbols: [], durationMs: Date.now() - start };
  }

  const raw = extractExportsFromDiff(opts.epicDiff);

  // Deduplicate by composite key (symbol + file) so that identically-named
  // exports from different files each receive their own caller search. Deduping
  // by symbol name alone would silently drop same-named exports from any file
  // after the first occurrence in the diff.
  const seen = new Set<string>();
  const exports: ExportEntry[] = [];
  for (const e of raw) {
    const key = `${e.symbol}:${e.file}`;
    if (!seen.has(key)) {
      seen.add(key);
      exports.push(e);
    }
  }

  const scannedSymbols: string[] = exports.map(e => e.symbol);
  const findings: NoCallerFinding[] = [];

  for (const entry of exports) {
    // Skip entries from malformed diff (no +++ b/ header seen before this export).
    if (!entry.file) continue;

    // @loom-public-api annotation unconditionally suppresses the check.
    if (entry.annotated) continue;

    // NOTE: findCallers uses a grep word-boundary pattern that may match symbol
    // names inside comments or string literals (e.g. `// calls orphanFn`).
    // This is a known limitation of a static-text search: a comment mention in
    // a production file will suppress a legitimate finding. The rate is low in
    // practice since most comments do not import/call by name.
    const callers = findCallers(entry.symbol, entry.file, opts.projectRoot);

    // Flag when every caller is a test file (Array.every returns true for []).
    if (callers.every(c => isTestFile(c))) {
      findings.push({ symbol: entry.symbol, file: entry.file, callers });
    }
  }

  return { findings, scannedSymbols, durationMs: Date.now() - start };
}
