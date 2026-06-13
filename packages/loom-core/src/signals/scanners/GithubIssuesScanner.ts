import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Signal } from '../types.js';
import type { SignalScanner, ScanContext } from '../SignalScanner.js';

const GH_TIMEOUT_MS = 15_000;

interface GhIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
}

/** Spawn function type — always called with shell:false for injection control. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { shell: false }
) => ChildProcess;

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, [...args], opts);

interface GhResult {
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

function runGh(spawnFn: SpawnFn, timeoutMs: number): Promise<GhResult> {
  const GH_ARGS = [
    'issue',
    'list',
    '--json',
    'number,title,url,state,createdAt',
    '--state',
    'open',
    '--limit',
    '500',
  ] as const;

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn('gh', GH_ARGS, { shell: false });
    } catch (err) {
      resolve({ stdout: '', stderr: '', error: err as Error & { code?: string } });
      return;
    }

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout,
        stderr,
        error: Object.assign(new Error('gh timed out'), { code: 'ETIMEDOUT' }),
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: Error & { code?: string }) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, error: err });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

function degradationNote(err: Error & { code?: string }): string {
  if (err.code === 'ENOENT') return 'gh binary not found (ENOENT)';
  if (err.code === 'ETIMEDOUT') return 'network timeout (ETIMEDOUT)';
  return `gh error: ${err.message}`;
}

function stderrDegradation(stderr: string): string | null {
  const s = stderr.toLowerCase();
  if (s.includes('authentication') || s.includes('not logged in') || s.includes('401')) {
    return 'auth failure';
  }
  if (s.includes('rate limit') || s.includes('429') || s.includes('api rate limit')) {
    return 'rate limit';
  }
  if (
    s.includes('no git remote') ||
    s.includes('no remote configured') ||
    s.includes('not a git repository') ||
    s.includes('cannot find remote')
  ) {
    return 'missing remote';
  }
  if (
    s.includes('could not resolve') ||
    s.includes('network error') ||
    s.includes('connection refused') ||
    s.includes('dial tcp')
  ) {
    return 'network error';
  }
  return null;
}

export class GithubIssuesScanner implements SignalScanner {
  readonly source = 'github-issues' as const;

  constructor(
    private readonly _spawn: SpawnFn = defaultSpawn,
    private readonly _timeoutMs: number = GH_TIMEOUT_MS
  ) {}

  async scan(ctx: ScanContext): Promise<Signal[]> {
    const { stdout, stderr, error } = await runGh(this._spawn, this._timeoutMs);

    if (error) {
      ctx.auditLog.record({
        action: 'signal_scan',
        detail: {
          scanner: 'github-issues',
          note: `gh unavailable: ${degradationNote(error)}`,
          signals: 0,
        },
      });
      return [];
    }

    const degraded = stderrDegradation(stderr);
    if (degraded) {
      ctx.auditLog.record({
        action: 'signal_scan',
        detail: {
          scanner: 'github-issues',
          note: `gh degraded: ${degraded}`,
          signals: 0,
        },
      });
      return [];
    }

    let issues: GhIssue[];
    try {
      issues = JSON.parse(stdout) as GhIssue[];
    } catch {
      ctx.auditLog.record({
        action: 'signal_scan',
        detail: {
          scanner: 'github-issues',
          note: 'gh returned non-JSON output; treating as unavailable',
          signals: 0,
        },
      });
      return [];
    }

    ctx.auditLog.record({
      action: 'signal_scan',
      detail: { scanner: 'github-issues', signals: issues.length },
    });

    return issues.map((issue) => ({
      key: `github-issues:${issue.number}`,
      source: 'github-issues' as const,
      kind: 'github_issue',
      title: issue.title,
      detail: `GitHub issue #${issue.number}: ${issue.title}`,
      evidenceUrl: issue.url,
      metadata: {
        number: issue.number,
        state: issue.state,
        createdAt: issue.createdAt,
      },
    }));
  }
}
