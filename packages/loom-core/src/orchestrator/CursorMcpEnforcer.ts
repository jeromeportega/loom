import { execFileSync } from 'node:child_process';

export interface CursorEnforceOptions {
  worktreePath: string;
  /** Servers that must survive — equals MaterializeResult.serverNames. */
  allowlist: string[];
  /** Defaults to 'cursor-agent'. */
  cursorBin?: string;
}

export interface CursorEnforceResult {
  /** Servers found and disabled. */
  disabled: string[];
  /** Servers that could not be disabled headlessly — record, never throw. */
  gaps: string[];
}

/**
 * Wall-clock guards so a prompting or wedged `cursor-agent` can never stall
 * worktree setup. Overridable via env purely as an internal test seam (lets the
 * hang→gap path be exercised deterministically); not a policy knob, not part of
 * the contracted signature.
 */
function listTimeoutMs(): number {
  return Number(process.env.LOOM_CURSOR_MCP_LIST_TIMEOUT_MS) || 30_000;
}
function disableTimeoutMs(): number {
  return Number(process.env.LOOM_CURSOR_MCP_DISABLE_TIMEOUT_MS) || 30_000;
}

/**
 * Parse `cursor-agent mcp list` output. Each server is printed as
 * `name: status`; we take the leading token before the first colon and ignore
 * any line that does not match that shape (banners, blanks, headers). Empty or
 * unparseable output yields an empty list rather than throwing.
 */
function parseServerNames(raw: string): string[] {
  const names: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([^\s:]+)\s*:/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Enforce the MCP allowlist for a cursor-cli worktree by enumeration: list
 * every server `cursor-agent` can see from this worktree's cwd (the union of
 * user-global `~/.cursor/mcp.json` and the materialized project config — see
 * docs/research/cursor-mcp-strictness.md) and headlessly disable each one not
 * on the allowlist. `disable` state is per-project and durable, so this only
 * touches this worktree.
 *
 * Best-effort and observable, never fail-closed: a server we cannot disable
 * (non-zero exit, prompt, hang) is recorded in `gaps` and the loop continues.
 * A failure to even enumerate (binary missing, list errors/times out) yields an
 * empty result — the worker still runs, just without this hardening.
 */
export function enforceCursorMcpAllowlist(
  opts: CursorEnforceOptions
): CursorEnforceResult {
  const bin = opts.cursorBin ?? 'cursor-agent';
  const cwd = opts.worktreePath;
  const survive = new Set(opts.allowlist);

  let listed: string[];
  try {
    const raw = execFileSync(bin, ['mcp', 'list'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: listTimeoutMs(),
    });
    listed = parseServerNames(raw);
  } catch {
    // Cannot enumerate (binary absent, error, or timeout) — nothing to enforce.
    return { disabled: [], gaps: [] };
  }

  const targets = [...new Set(listed)].filter((name) => !survive.has(name)).sort();

  const disabled: string[] = [];
  const gaps: string[] = [];
  for (const name of targets) {
    try {
      execFileSync(bin, ['mcp', 'disable', name], {
        cwd,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: disableTimeoutMs(),
      });
      disabled.push(name);
    } catch {
      gaps.push(name);
    }
  }

  return { disabled, gaps };
}
