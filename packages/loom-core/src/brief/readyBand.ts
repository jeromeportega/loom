/**
 * Ready-band threshold — single source of truth (ADR-001).
 *
 * Lives in a brief-owned leaf module so the scorer (brief/) can reference it
 * without importing from eval/, preserving the one-way dependency eval → brief.
 * bands.ts re-exports READY_BAND as BANDS.high.
 */
export const READY_BAND: readonly [number, number] = [7, 10];

/** The minimum quality_score required for a brief to be considered ready. */
export const READY_BAND_MIN: number = READY_BAND[0];

/**
 * Readiness score floor for code-derived readiness — DECOUPLED from READY_BAND
 * (the eval's high scoring band). Readiness must not impose a higher score bar
 * than the brief gate's minimum passing threshold: among briefs that pass the
 * gate, "ready" means simply "no planning-blocking gaps". Aligned with the
 * default min_brief_quality_score so a brief scoring at the gate threshold can
 * still be pass-clean (preserving gate boundary semantics). Tying readiness to
 * READY_BAND_MIN (7) instead would wrongly demote every minimally-passing brief
 * to pass-with-clarifications.
 */
export const READINESS_SCORE_FLOOR: number = 6;
