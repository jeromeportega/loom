import type { Finding, Severity } from '../findings/schema.js';

/**
 * Description normalization for finding dedupe (ADR-003). The exact pipeline is
 * frozen across epic-001 — change it here and every reviewer's dedupe behavior
 * shifts:
 *   1. lowercase
 *   2. collapse runs of whitespace to a single space
 *   3. strip everything that is not a letter, number, or whitespace
 *   4. trim
 * The Unicode property escapes (`\p{L}`/`\p{N}`) keep accented letters and
 * non-Latin digits, so two findings that differ only in case, spacing, or
 * trailing punctuation collapse to the same key.
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

/**
 * The dedupe key for a finding: `${file}|${line ?? ''}|${normalize(description)}`.
 * Two findings share a key iff they point at the same file and line and their
 * descriptions are identical after {@link normalize}. A missing line collapses
 * to the empty string so an unlocated finding never accidentally matches a
 * line-pinned one.
 */
export function dedupeKey(f: Finding): string {
  return `${f.location.file}|${f.location.line ?? ''}|${normalize(f.description)}`;
}

// Lower rank = more severe. Used to pick the survivor when several findings
// collapse to one key, so a blocker is never masked by a less-severe duplicate.
const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Collapse findings that share a {@link dedupeKey} into one. The survivor is
 * the most-severe finding in the group (ties resolve to the first seen), so a
 * duplicate reported as `blocker` by one reviewer and `medium` by another keeps
 * the `blocker`. First-seen key order is preserved for deterministic output.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  const order: string[] = [];
  for (const f of findings) {
    const key = dedupeKey(f);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, f);
      order.push(key);
    } else if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity]) {
      byKey.set(key, f);
    }
  }
  return order.map((key) => byKey.get(key)!);
}
