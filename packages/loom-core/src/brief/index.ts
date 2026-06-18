export {
  BriefRefiner,
  FALLBACK_QUALITY_SCORE,
  SALVAGE_QUALITY_SCORE,
} from './BriefRefiner.js';
export type { BriefRefinerOptions } from './BriefRefiner.js';
export type { BriefRefinement } from './types.js';
export { evaluateBriefGate } from './gate.js';
export type { GateVerdict } from './gate.js';
// GateOutcome is not re-exported here: the name collides with the pre-existing
// orchestrator/IntegrationGate.GateOutcome in the root barrel. Import it
// directly from './gate.js' (or '@loom-ai/core/brief/gate.js') when needed.
