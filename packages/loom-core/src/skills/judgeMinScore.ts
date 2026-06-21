/**
 * Minimum score for a skill to pass the judge gate (SSOT for the policy default).
 *
 * Mirrors the `skill_judge_min_score` default in schemas/policy.schema.yaml.
 * The eval's band boundaries are derived from this constant (not hard-coded)
 * so they stay in sync when the policy default changes.
 *
 * ADR-001: one-way dependency — eval/ imports from skills/, never the reverse.
 */
export const JUDGE_MIN_SCORE = 6;
