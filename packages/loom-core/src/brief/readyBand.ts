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
