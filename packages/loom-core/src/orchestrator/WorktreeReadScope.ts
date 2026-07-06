import fs from 'node:fs';
import path from 'node:path';

export interface WorktreeReadScopeOptions {
  /** Absolute path to the worker's git worktree (wt.path). */
  worktreePath: string;
  /** Resolved allowed_read_root — absolute, canonicalized. Defaults to repo root. */
  readRoot: string;
  /** Absolute path to the node script for the hook command (process.argv[1] from loom CLI). */
  loomScriptPath: string;
}

export interface WorktreeReadScopeResult {
  /** Absolute path of the written .claude/settings.json */
  settingsPath: string;
}

/**
 * Writes a per-worker `.claude/settings.json` that enforces read-scope
 * boundaries via a PreToolUse hook and declarative permission globs.
 *
 * Whole-file overwrite — never a merge — so the output is a pure function of
 * the inputs and re-dispatch is idempotent.
 *
 * Hook is the real load-bearing control (workers run --permission-mode
 * bypassPermissions, so the permissions block is defense-in-depth and
 * self-documentation only). Both must be kept in sync with the same resolved
 * roots.
 */
export function materializeWorktreeReadScope(
  opts: WorktreeReadScopeOptions,
): WorktreeReadScopeResult {
  const { worktreePath, readRoot, loomScriptPath } = opts;

  const hookCommand = `node "${loomScriptPath}" guard hook`;

  // Note: workers run --permission-mode bypassPermissions, so the permissions
  // block below is advisory (defense-in-depth) only. The hook is the real
  // enforcement mechanism. Both must stay in sync with worktreePath and
  // readRoot.
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read|Grep|Glob|Bash',
          hooks: [{ type: 'command', command: hookCommand }],
        },
      ],
    },
    permissions: {
      allow: [
        `Read(//${worktreePath}/**)`,
        `Read(//${readRoot}/**)`,
        `Grep(//${worktreePath}/**)`,
        `Glob(//${worktreePath}/**)`,
      ],
      deny: [
        'Read(//**)',
        'Read(~/**)',
        'Grep(//**)',
        'Glob(~/**)',
      ],
    },
  };

  const claudeDir = path.join(worktreePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return { settingsPath };
}
