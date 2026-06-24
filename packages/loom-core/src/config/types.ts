import type { Policy } from '../types.js';

/** Low → high precedence. The array order [team, repo, env] IS the precedence. */
export type LayerName = 'team' | 'repo' | 'env';

/** A raw, PRE-validation parsed tree. Genuinely-absent fields stay absent (ADR-007):
 *  `{}` ≠ `{ git: { allowed_remotes: [] } }`. Never run through PolicySchema.parse here. */
export interface ConfigLayer {
  name: LayerName;
  tree: unknown;
}

/** scalar   → higher layer wins
 *  deep     → maps merged key-wise
 *  union    → denylist, most-restrictive (ADR-004), precedence-independent
 *  intersect→ allowlist, most-restrictive (ADR-004), precedence-independent
 *  replace  → non-guard list, higher layer wins
 *  and      → guard boolean, `true` wins regardless of precedence (ADR-004) */
export type MergeStrategy = 'scalar' | 'deep' | 'union' | 'intersect' | 'replace' | 'and';

/** Winning layer per resolved dotted key path — audit trail (Security T4). */
export type ProvenanceMap = Record<string, LayerName>;

export interface EffectiveConfig {
  /** Validated; PolicySchema defaults applied ONCE at the end (ADR-007). */
  policy: Policy;
  provenance: ProvenanceMap;
}

export interface ResolveOptions {
  /** <projectRoot>/.loom — locates policy.yaml (repo layer). */
  loomdir: string;
  /** Needed to derive loom-home for the team layer. */
  projectRoot: string;
  /** Defaults to process.env; injectable for hermetic tests. */
  env?: NodeJS.ProcessEnv;
}
