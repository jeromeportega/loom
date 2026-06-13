import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Signal } from '../types.js';
import type { SignalScanner, ScanContext } from '../SignalScanner.js';

const DEBT_RE = /\b(TODO|FIXME|HACK)\b/g;
export const CODE_DEBT_CAP = 200;

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cpp|h|hpp|cs|sh|bash|zsh)$/;

function defaultGetTrackedFiles(projectRoot: string): string[] {
  const result = spawnSync('git', ['ls-files'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];
  return result.stdout.split('\n').filter(Boolean);
}

function defaultReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

interface MatchEntry {
  relativePath: string;
  line: number;
  token: string;
}

export class CodeDebtScanner implements SignalScanner {
  readonly source = 'code-debt' as const;

  constructor(
    private readonly _getTrackedFiles?: (projectRoot: string) => string[],
    private readonly _readFile?: (absolutePath: string) => string
  ) {}

  async scan(ctx: ScanContext): Promise<Signal[]> {
    const getFiles = this._getTrackedFiles ?? defaultGetTrackedFiles;
    const readFile = this._readFile ?? defaultReadFile;

    const files = getFiles(ctx.projectRoot)
      .filter((f) => SOURCE_EXT.test(f))
      .sort();

    const allMatches: MatchEntry[] = [];

    for (const relativePath of files) {
      const absolutePath = join(ctx.projectRoot, relativePath);
      let content: string;
      try {
        content = readFile(absolutePath);
      } catch {
        content = '';
      }
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        DEBT_RE.lastIndex = 0;
        const lineText = lines[i];
        let match: RegExpExecArray | null;
        while ((match = DEBT_RE.exec(lineText)) !== null) {
          allMatches.push({ relativePath, line: i + 1, token: match[1] });
        }
      }
    }

    // Already ordered path-then-line due to sorted files + sequential line iteration,
    // but sort explicitly for correctness.
    allMatches.sort((a, b) => {
      if (a.relativePath < b.relativePath) return -1;
      if (a.relativePath > b.relativePath) return 1;
      return a.line - b.line;
    });

    const dropped = Math.max(0, allMatches.length - CODE_DEBT_CAP);
    if (dropped > 0) {
      ctx.auditLog.record({
        action: 'signal_scan',
        detail: {
          scanner: 'code-debt',
          note: `code-debt cap: ${dropped} match(es) dropped (total ${allMatches.length}, cap ${CODE_DEBT_CAP})`,
          dropped,
          total: allMatches.length,
        },
      });
    }

    return allMatches.slice(0, CODE_DEBT_CAP).map((m) => ({
      key: `code-debt:${m.relativePath}:${m.line}:${m.token}`,
      source: 'code-debt' as const,
      kind: 'todo',
      title: `${m.token} in ${m.relativePath}:${m.line}`,
      evidenceUrl: `${m.relativePath}:${m.line}`,
      metadata: { path: m.relativePath, line: m.line, token: m.token },
    }));
  }
}
