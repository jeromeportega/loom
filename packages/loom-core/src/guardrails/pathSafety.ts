/**
 * UNSAFE_CHECKS — a deterministic, pre-resolution safety check on a single command
 * argument token, run by the guard BEFORE any path resolution.
 *
 * Scope (deliberately narrow — see the epic-098 re-gate): this layer guards the
 * RAW SHELL COMMAND surface, where tools (`cat`, `git`, `rm`, …) take arguments
 * LITERALLY and do not percent-decode. So it targets only the classes that are
 * genuinely dangerous at that layer with near-zero false positives:
 *
 *   1. null-byte    — a NUL truncates paths in C/fs layers; never legitimate.
 *   2. control-char — C0/DEL bytes in a path token; never legitimate.
 *   3. file-scheme  — a `file:` URI handed to a URL-fetching tool (`curl`, `wget`)
 *                     reads a LOCAL file, escaping read-scope. ALL forms are
 *                     rejected — `file://host/p`, `file:/p` (single slash, the
 *                     RFC-8089 form `curl` normalizes and reads), and the opaque
 *                     `file:p` — because curl treats them identically.
 *
 * Deliberately NOT here (and why): percent-encoded traversal (`%2e`, `%2f`, `%5c`)
 * is NOT decoded by the shell tools this guard fronts (`cat %2e%2e%2fx` opens the
 * literal file `%2e%2e%2fx`), so checking it only generated false positives on
 * `grep %2e`, `gh api …%2F…` (GitHub requires it), and commit messages — for a
 * threat the guarded tools don't have. Real `../` traversal is handled where paths
 * are actually RESOLVED (the read-scope / cross-repo guards' `resolveArg`), the
 * correct layer for it. Remote URL schemes (`https://`, `ssh://`, `git://`, …) are
 * benign network operands and pass through untouched.
 */

export type RejectionRule = 'null-byte' | 'control-char' | 'file-scheme';

export type PathSafetyResult =
  | { safe: true }
  | { safe: false; reason: string; rule: RejectionRule };

// `file:` in any form — `file://`, `file:/`, or opaque `file:` — case-insensitive.
// curl normalizes `file:/etc/passwd` to `file:///etc/passwd` and reads it, so the
// slash count must NOT matter (the original `://`-only rule missed `file:/`).
// Leading whitespace is tolerated so a quoted ` file:/x` token can't slip the anchor.
const FILE_SCHEME_RE = /^\s*file:/i;

export function checkPathSafety(token: string): PathSafetyResult {
  if (/\x00/.test(token)) {
    return { safe: false, reason: 'token contains a null byte', rule: 'null-byte' };
  }
  // C0 (excluding NUL, above) and DEL — but NOT tab (\x09), LF (\x0a), or CR
  // (\x0d): those appear legitimately inside quoted operands (a multi-line
  // `git commit -m` message), and flagging them broke routine commits. A path
  // with a NUL is a truncation attack; a path with a tab/newline is just quoted.
  if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(token)) {
    return { safe: false, reason: 'token contains a C0 or DEL control character', rule: 'control-char' };
  }
  if (FILE_SCHEME_RE.test(token)) {
    return {
      safe: false,
      reason: `token is a file: URI ("${token}") — reads a local file, escaping read-scope`,
      rule: 'file-scheme',
    };
  }
  return { safe: true };
}
