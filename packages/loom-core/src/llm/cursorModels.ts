import { execFileSync } from 'node:child_process';
import type { Policy } from '../types.js';

export type ListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

export interface CursorModelCheck {
  status: 'ok' | 'invalid' | 'unavailable';
  /** The valid model ids from `cursor-agent --list-models`. [] when unavailable. */
  validModels: string[];
  /** The offending model id(s). [] unless status === 'invalid'. */
  invalidIds: string[];
  /**
   * Human-facing message. '' on an exact 'ok'; advisory text on an alias 'ok';
   * the COMPLETE valid-model list on 'invalid'.
   */
  message: string;
  /**
   * Set true ONLY on the boundary-prefix alias tier: the configured id is not
   * an exact match but is a `-`-boundary prefix of a listed id, so the check
   * still passes ('ok') while recommending the explicit suffixed id. A
   * consumer that switches only on `status` treats this as a plain 'ok' — the
   * advisory is purely additive and never changes pass/fail.
   */
  advisory?: boolean;
}

/**
 * Parses `cursor-agent --list-models` stdout into the list of model ids.
 *
 * The CLI prints an "Available models" header, a blank line, then one model
 * per line as `<model-id> - <Human Description>`. We take the id (the token
 * before the first ` - `). Pure and defensive: empty or garbage stdout that
 * carries no `id - description` lines yields `[]` without throwing.
 */
export function parseListModelsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    // A model line is `<id> - <description>`; the id has no whitespace. The
    // header ("Available models"), blank lines, and arbitrary prose all fail
    // this shape and are skipped.
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+\S/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/**
 * Runs `cursor-agent --list-models` and returns the parsed model ids. The
 * subprocess is invoked with an args array (no shell) so the binary name and
 * flags can never be misinterpreted as shell syntax. A spawn failure (binary
 * absent, not authenticated, offline) is reported as `{ ok: false }` rather
 * than thrown — callers degrade open on it (FR-8).
 */
export function listCursorModels(cursorBin = 'cursor-agent'): ListModelsResult {
  try {
    const stdout = execFileSync(cursorBin, ['--list-models'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, models: parseListModelsOutput(stdout) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Validates `policy.agents.cursor_model` against the live model list, but only
 * when a cursor-cli backend is actually configured for planning or workers
 * (otherwise there is nothing to validate and we return `undefined`).
 *
 * `modelFor()` routes the cursor-cli planning model through `cursor_model`, so
 * validating that single id also covers the planning path.
 *
 * Degrade-open: if `--list-models` cannot run (offline, unauthenticated, no
 * binary) we return 'unavailable' — a warning, never a false 'invalid' — so a
 * valid configuration is never rejected just because the probe failed.
 */
export function validateCursorModels(
  policy: Policy,
  cursorBin?: string
): CursorModelCheck | undefined {
  const usesCursor =
    policy.agents.llm_backend === 'cursor-cli' ||
    policy.agents.worker_backend === 'cursor-cli';
  if (!usesCursor) return undefined;

  const target = policy.agents.cursor_model;
  const result = listCursorModels(cursorBin);

  // Treat both a spawn failure and a successful-but-unparseable run as
  // 'unavailable': with no model list to check against, the only safe move is
  // to warn rather than reject a possibly-valid configuration.
  if (!result.ok || result.models.length === 0) {
    const reason = result.ok
      ? '`cursor-agent --list-models` returned no recognizable models'
      : `\`cursor-agent --list-models\` failed: ${result.error}`;
    return {
      status: 'unavailable',
      validModels: [],
      invalidIds: [],
      message:
        `Could not validate cursor_model "${target}" — ${reason}. ` +
        'Run `cursor-agent --list-models` to confirm Cursor is installed and ' +
        'logged in. Skipping model validation; a typo will surface later.',
    };
  }

  const validModels = result.models;

  // Tier 1 — exact match. Silent 'ok', no advisory.
  if (validModels.includes(target)) {
    return { status: 'ok', validModels, invalidIds: [], message: '' };
  }

  // Tier 2 — boundary-prefix alias. `target` aliases a listed id IFF that id
  // is `target` plus EXACTLY ONE more '-'-delimited token (e.g. a decorator
  // like '-high'). The trailing '-' boundary alone is not enough: 'claude-opus-4'
  // is a '-'-boundary prefix of 'claude-opus-4-8-high', but it skips the '8'
  // version segment — two extra tokens, not one — so it must NOT alias. Only a
  // single-token expansion ('claude-opus-4-8' → 'claude-opus-4-8-high') counts.
  // Among several single-token matches we recommend the SHORTEST listed id —
  // the closest, least-decorated expansion of what the operator typed.
  const prefix = `${target}-`;
  let alias: string | undefined;
  for (const m of validModels) {
    // One extra token: starts at the '-' boundary and the remainder carries no
    // further '-' (which would mean two or more added tokens).
    if (!m.startsWith(prefix)) continue;
    const remainder = m.slice(prefix.length);
    if (remainder.length === 0 || remainder.includes('-')) continue;
    if (alias === undefined || m.length < alias.length) {
      alias = m;
    }
  }
  if (alias !== undefined) {
    return {
      status: 'ok',
      advisory: true,
      validModels,
      invalidIds: [],
      message:
        `cursor_model "${target}" matches "${alias}"; ` +
        `set the explicit id "${alias}" in policy.agents.cursor_model to pin it.`,
    };
  }

  // Tier 3 — no match. 'invalid' with the COMPLETE valid-model list.
  return {
    status: 'invalid',
    validModels,
    invalidIds: [target],
    message:
      `cursor_model "${target}" is not a valid Cursor model. ` +
      'Set policy.agents.cursor_model to one of the available models:\n' +
      validModels.map((m) => `  - ${m}`).join('\n'),
  };
}
