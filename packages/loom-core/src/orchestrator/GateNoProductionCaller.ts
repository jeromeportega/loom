import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface NoCallerFinding {
  symbol: string;   // exported symbol name
  file: string;     // source file that exports it (repo-relative)
  callers: string[]; // all found reference sites (all are test files, or none)
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

// A pure re-export line ("barrel") — it forwards the symbol without USING it.
// Covers `export { x } from '...'`, `export type { x } from '...'`, and
// `export * from '...'` / `export * as ns from '...'`. Loom-core barrel-exports
// nearly every symbol through orchestrator/index.ts + src/index.ts, so counting
// these as callers would make this gate VACUOUS: an orphan that is only
// barrel-exported (the default worker convention) would look "called" and the
// epic-076 defect class this gate targets would be invisible.
const RE_EXPORT_RE = /^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?)\s+from\s+/;

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
    /(^|\/)test\//.test(norm) ||
    /(^|\/)fixtures?\//.test(norm)
  );
}

/** True when `content` DECLARES `symbol` (its own definition), not a use. */
function isDeclarationLine(content: string, symbol: string): boolean {
  const t = content.trim();
  const decl = EXPORT_DECL_RE.exec(t);
  if (decl && decl[1] === symbol) return true;
  const named = NAMED_EXPORT_RE.exec(t);
  // Only the local re-export form (`export { foo }` with no `from`) is the
  // source's own declaration; `export { foo } from '…'` is handled as a barrel.
  if (named && !/\bfrom\b/.test(t)) {
    for (const part of named[1].split(',')) {
      const tokens = part.trim().split(/\s+as\s+/);
      const exportedName = (tokens[1] ?? tokens[0]).trim();
      if (exportedName === symbol) return true;
    }
  }
  return false;
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
    const fileMatch = DIFF_FILE_RE.exec(rawLine);
    if (fileMatch) {
      currentFile = fileMatch[1];
      prevContent = '';
      continue;
    }

    if (rawLine.startsWith('@@')) {
      prevContent = '';
      continue;
    }

    if (rawLine.startsWith('-')) {
      prevContent = '';
      continue;
    }

    const isAdded = rawLine.startsWith('+') && !rawLine.startsWith('+++');
    const isContext = rawLine.startsWith(' ');
    if (!isAdded && !isContext) continue;

    const content = rawLine.slice(1);
    const trimmed = content.trim();

    if (isAdded && trimmed) {
      const declMatch = EXPORT_DECL_RE.exec(trimmed);
      if (declMatch) {
        entries.push({
          symbol: declMatch[1],
          file: currentFile,
          annotated: prevContent.includes(PUBLIC_API_ANNOTATION),
        });
      }

      // Named-form: export { foo, bar as baz }. A re-export (`… from '…'`) is a
      // barrel line, not a new local export — skip it as an export SOURCE.
      const namedMatch = NAMED_EXPORT_RE.exec(trimmed);
      if (namedMatch && !RE_EXPORT_RE.test(content)) {
        const annotated = prevContent.includes(PUBLIC_API_ANNOTATION);
        for (const part of namedMatch[1].split(',')) {
          const tokens = part.trim().split(/\s+as\s+/);
          const exportedName = (tokens[1] ?? tokens[0]).trim();
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportedName)) {
            entries.push({ symbol: exportedName, file: currentFile, annotated });
          }
        }
      }
    }

    if (trimmed) prevContent = trimmed;
  }

  return entries;
}

/**
 * Searches `projectRoot` for production source lines that genuinely USE
 * `symbol` (import or call), and returns the repo-relative files that do.
 *
 * Line-level (grep -n) so it can exclude, per matching line:
 *  - test files (they never count as production callers);
 *  - the symbol's own declaration line in its source file;
 *  - pure re-export / barrel lines (`export { x } from '…'`, `export * from`) —
 *    a forward is not a use, and loom barrels everything, so counting them would
 *    make the gate vacuous.
 * A same-file usage (the source file referencing the symbol on a non-declaration
 * line) DOES count — an exported-for-testing helper used within its own module
 * has a real production caller.
 */
function findCallers(
  symbol: string,
  sourceFile: string,
  projectRoot: string
): { production: string[]; test: string[] } {
  const escaped = symbol.replace(/\$/g, '\\$');
  const pattern = `(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`;

  let out: string;
  try {
    out = execFileSync(
      'grep',
      [
        '-rn',                       // recursive, with line numbers + content
        '-E',
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.mts',
        '--include=*.js',
        '--include=*.mjs',
        '--include=*.jsx',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '--exclude-dir=dist-test',
        '--exclude-dir=client-dist',
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
    const e = err as { status?: number };
    if (e.status === 1) return { production: [], test: [] };
    return { production: [], test: [] };
  }

  const production = new Set<string>();
  const test = new Set<string>();
  const src = sourceFile.replace(/\\/g, '/');
  for (const line of out.split('\n')) {
    // grep -rn output: `<abs-path>:<lineno>:<content>` (paths have no colons).
    const m = /^([^:]+):\d+:(.*)$/.exec(line);
    if (!m) continue;
    const rel = path.relative(projectRoot, m[1]).replace(/\\/g, '/');
    const content = m[2];
    if (RE_EXPORT_RE.test(content)) continue;    // barrel forward — not a use at all
    if (rel === src && isDeclarationLine(content, symbol)) continue; // the decl itself
    if (isTestFile(rel)) test.add(rel);          // test reference — doesn't count as production
    else production.add(rel);                    // real production use (import/call/in-file)
  }
  return { production: [...production], test: [...test] };
}

/**
 * Static checker. Extracts every export added in `epicDiff`, searches
 * `projectRoot` for genuine production uses, and returns a finding for each
 * export with zero production callers (only test callers, barrel forwards, or
 * nothing at all).
 *
 * Rules:
 *  - An export annotated `// @loom-public-api` on the preceding non-blank diff
 *    line is skipped unconditionally.
 *  - An export whose SOURCE file is itself a test/fixture file is not scanned.
 *  - Zero production callers is flagged (whether the only refs are test files,
 *    barrel forwards, or none).
 *  - Cross-package and same-file production uses both count as callers.
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

  const seen = new Set<string>();
  const exports: ExportEntry[] = [];
  for (const e of raw) {
    const key = `${e.symbol}:${e.file}`;
    if (!seen.has(key)) {
      seen.add(key);
      exports.push(e);
    }
  }

  const scannedSymbols: string[] = [];
  const findings: NoCallerFinding[] = [];

  for (const entry of exports) {
    if (!entry.file) continue;
    // Exports DEFINED in a test/fixture file are not a production surface.
    if (isTestFile(entry.file)) continue;
    scannedSymbols.push(entry.symbol);

    if (entry.annotated) continue;

    // NOTE: a comment/string mention of the symbol in a production file (e.g.
    // `// calls orphanFn`) is still matched by the word-boundary grep and
    // suppresses the finding — an inherent limit of static text search. Rare in
    // practice; a genuinely dead symbol is almost never name-dropped in prose.
    const { production, test } = findCallers(entry.symbol, entry.file, opts.projectRoot);

    if (production.length === 0) {
      // No genuine production use — flag it. `callers` lists the test-file
      // references (empty when there are no callers at all).
      findings.push({ symbol: entry.symbol, file: entry.file, callers: test });
    }
  }

  return { findings, scannedSymbols, durationMs: Date.now() - start };
}
