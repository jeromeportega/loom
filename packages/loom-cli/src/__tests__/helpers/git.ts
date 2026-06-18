import { execFileSync } from 'node:child_process';

export function isTracked(repoRoot: string, relPath: string): boolean {
  return execFileSync('git', ['ls-files', '--', relPath], { cwd: repoRoot })
    .toString().trim().length > 0;
}
