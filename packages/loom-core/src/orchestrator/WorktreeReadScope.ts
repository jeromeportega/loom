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
 * The PreToolUse hook is the sole load-bearing control. Workers run
 * --permission-mode bypassPermissions, under which Claude Code ignores `allow`
 * rules but STILL honors `deny` rules — so this file writes `allow` globs only
 * (a no-prompt hint for non-bypass modes) and never a broad `deny`, which would
 * beat the narrower allow and block the worker's reads of its own worktree.
 */
export function materializeWorktreeReadScope(
  opts: WorktreeReadScopeOptions,
): WorktreeReadScopeResult {
  const { worktreePath, readRoot, loomScriptPath } = opts;

  // JSON.stringify produces a properly quoted+escaped string, safe even if
  // loomScriptPath contains double-quotes or other shell-special characters.
  const hookCommand = `node ${JSON.stringify(loomScriptPath)} guard hook`;

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
      // The PreToolUse hook above is the SOLE enforcement mechanism. These
      // `allow` globs are a no-prompt optimization for non-bypass modes only —
      // under --permission-mode bypassPermissions (how loom runs workers) Claude
      // Code ignores `allow` entirely and the hook does the work.
      //
      // Deliberately NO `deny` block: Claude Code deny rules are honored in EVERY
      // mode (including bypassPermissions) and beat any narrower `allow`
      // regardless of specificity. A broad `Read(//**)`/`Grep(//**)`/`Glob(//**)`
      // deny would therefore veto the worker's reads of its OWN worktree and
      // brick every run. Out-of-scope denial belongs in the hook (which denies
      // only paths outside the worktree), not in a declarative rule Claude Code's
      // deny-beats-allow model cannot scope.
      allow: [
        `Read(//${worktreePath.replace(/^\//, '')}/**)`,
        `Read(//${readRoot.replace(/^\//, '')}/**)`,
        `Grep(//${worktreePath.replace(/^\//, '')}/**)`,
        `Glob(//${worktreePath.replace(/^\//, '')}/**)`,
      ],
    },
  };

  const claudeDir = path.join(worktreePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return { settingsPath };
}
