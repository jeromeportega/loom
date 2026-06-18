// Patterns for secrets we redact. The replacement strings must NOT match the
// same pattern (so re-redacting is a no-op). We verify: `[REDACTED]` contains
// `[` which is not in `[A-Za-z0-9_\-]`, so sk-ant-[REDACTED] never re-matches.
const SK_ANT = /sk-ant-[A-Za-z0-9_\-]{10,}/g;
const GITHUB_PAT_FINEGRAINED = /github_pat_[A-Za-z0-9_]{20,}/g;
const GITHUB_PAT_CLASSIC = /ghp_[A-Za-z0-9]{20,}/g;
// OAuth (gho_), user-to-server (ghu_), server-to-server (ghs_), fine-grained (ghf_)
const GITHUB_OTHER = /gh[oushf]_[A-Za-z0-9]{20,}/g;

/**
 * Replaces known secret patterns in `chunk` with inert placeholders.
 * - Idempotent: calling twice produces the same result as calling once.
 * - Handles empty string.
 * - Does NOT throw on split tokens (partial matches are simply not matched).
 */
export function redactSecrets(chunk: string): string {
  if (!chunk) return chunk;
  return chunk
    .replace(SK_ANT, 'sk-ant-[REDACTED]')
    .replace(GITHUB_PAT_FINEGRAINED, 'github_pat_[REDACTED]')
    .replace(GITHUB_PAT_CLASSIC, 'ghp_[REDACTED]')
    .replace(GITHUB_OTHER, 'ghs_[REDACTED]');
}
