export {
  BriefRefiner,
  FALLBACK_QUALITY_SCORE,
  SALVAGE_QUALITY_SCORE,
} from './BriefRefiner.js';
export type { BriefRefinerOptions } from './BriefRefiner.js';
export type { BriefRefinement } from './types.js';
export { evaluateBriefGate } from './gate.js';
export type { GateVerdict } from './gate.js';
// Re-exported under a disambiguating alias: orchestrator/IntegrationGate already
// exports a GateOutcome interface via the root barrel — using BriefGateOutcome
// avoids the collision without forcing callers off the public API surface.
export type { GateOutcome as BriefGateOutcome } from './gate.js';
