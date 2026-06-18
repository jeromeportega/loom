/**
 * Replaces known secret patterns in `chunk` with inert placeholders.
 * - Idempotent: calling twice produces the same result as calling once.
 * - Handles empty string.
 * - Does NOT throw on split tokens (partial matches are simply not matched).
 *
 * Regex objects are created fresh on each call so that callers can freely use
 * .test()/.exec() on the same patterns elsewhere without lastIndex skew.
 */
export function redactSecrets(chunk: string): string {
  if (!chunk) return chunk;
  // Dash placed last in character class to avoid ambiguity with a range.
  const SK_ANT = /sk-ant-[A-Za-z0-9_-]{10,}/g;
  const GITHUB_PAT_FINEGRAINED = /github_pat_[A-Za-z0-9_]{20,}/g;
  const GITHUB_PAT_CLASSIC = /ghp_[A-Za-z0-9]{20,}/g;
  // OAuth (gho_), user-to-server (ghu_), server-to-server (ghs_), fine-grained actions (ghf_).
  // Capture group preserves the token-type prefix so incident responders can identify
  // which credential family to rotate.
  const GITHUB_OTHER = /gh([ousf])_[A-Za-z0-9]{20,}/g;

  return chunk
    .replace(SK_ANT, 'sk-ant-[REDACTED]')
    .replace(GITHUB_PAT_FINEGRAINED, 'github_pat_[REDACTED]')
    .replace(GITHUB_PAT_CLASSIC, 'ghp_[REDACTED]')
    .replace(GITHUB_OTHER, (_m, c: string) => `gh${c}_[REDACTED]`);
}
