import type { MergeStrategy } from './types.js';

/**
 * Static registry that classifies every guard-shaped PolicySchema field (ADR-003).
 * Keyed by dotted path into PolicySchema.
 *
 * INVARIANT: every field whose name matches *_branches / *_paths / allowed_* /
 * forbidden_* / risky_* must have an explicit entry here. The registry-coverage
 * test enforces this — a missing entry silently defaults to loosenable 'replace'.
 *
 * Fields NOT listed here fall to the structural default:
 *   - object  → 'deep'
 *   - array   → 'replace'
 *   - scalar  → 'scalar'
 */
export const MERGE_STRATEGY: Record<string, MergeStrategy> = {
  // ── Guard denylists — union, most-restrictive, precedence-independent (ADR-004) ──
  // Adding a layer can ONLY grow the set; no layer can shrink it.
  'git.protected_branches':     'union',
  'git.forbidden_flags':        'union',
  'filesystem.protected_paths': 'union',
  'agents.risky_paths':         'union',

  // ── Guard allowlists — intersect, most-restrictive, precedence-independent (ADR-004) ──
  // The effective set is the tightest intersection across all present layers.
  'git.allowed_remotes':           'intersect',

  // allowed_write_root is a scalar path string (not a list), so it cannot use
  // intersect/union semantics. It uses 'scalar' (higher layer wins), which is a
  // deliberate operator-level escape hatch: an env var can override a team-config
  // restriction. This is documented as an intentional design trade-off — env-layer
  // overrides of allowed_write_root are operator-controlled, not agent-controlled.
  // Its name starts with 'allowed_' so the registry-coverage test requires an
  // explicit entry here; the 'scalar' strategy is the intentional choice.
  'filesystem.allowed_write_root': 'scalar',

  // ── Guard boolean — true wins regardless of precedence (ADR-004) ──
  // agents_must_use_pr=true is the more restrictive value; once any layer asserts
  // it, no higher layer can loosen it to false.
  'git.agents_must_use_pr':        'and',

  // ── Cross-repo retrieval guards (epic-057) ──────────────────────────────────
  // secret_globs is a security denylist — union semantics so no layer can remove
  // a secret pattern contributed by a lower layer (ADR-004).
  'cross_repo.secret_globs':       'union',
};
