import type { PlanningPhase } from '../types.js';

export type PlanningEvent =
  | { type: 'phase';  phase: PlanningPhase }
  | { type: 'output'; phase: PlanningPhase; chunk: string };
