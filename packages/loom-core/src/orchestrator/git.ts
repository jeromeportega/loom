import { execFileSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  output: string;
}

/** Runs git with array args (no shell — safe from injection). Throws on failure. */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Runs git without throwing; returns { ok, output }. */
export function gitSafe(cwd: string, args: string[]): GitResult {
  try {
    return { ok: true, output: git(cwd, args) };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, output: (e.stderr || e.stdout || e.message || '').trim() };
  }
}

/** True if the path is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  return gitSafe(cwd, ['rev-parse', '--is-inside-work-tree']).output === 'true';
}

/** True if the repo has at least one commit (worktrees require this). */
export function hasCommits(cwd: string): boolean {
  return gitSafe(cwd, ['rev-parse', '--verify', 'HEAD']).ok;
}

/** Returns the configured push remote name, or null if the repo has none. */
export function defaultRemote(cwd: string): string | null {
  const res = gitSafe(cwd, ['remote']);
  if (!res.ok || res.output.length === 0) return null;
  const remotes = res.output.split('\n').map((r) => r.trim());
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

/** Returns a remote's push URL, or null if it cannot be resolved. */
export function remoteUrl(cwd: string, remote: string): string | null {
  const res = gitSafe(cwd, ['remote', 'get-url', remote]);
  return res.ok && res.output.length > 0 ? res.output : null;
}
