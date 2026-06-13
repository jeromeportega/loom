/**
 * Fleet board data shapes — shared between the loom-web Express server and
 * the fleet.js frontend view. Kept in a dedicated module (not shared/types.ts)
 * so story-003-005 can own this file exclusively during the epic-003 sprint.
 *
 * Owner: story-003-005
 */

import type { AgentStatus, EpicStatus } from '@loom-ai/core';
import type { EpicCost } from './types.js';

/**
 * Autonomy level for an epic. Defined here to avoid a hard dependency on the
 * story-003-001 branch that adds it to loom-core; the two definitions will
 * merge when epic-003 integrates.
 */
export type AutonomyLevel = 'full-auto' | 'checkpoint' | 'manual';

/** Per-story entry on a fleet card — one row per latest agent for the story. */
export interface FleetStory {
  story_id: string;
  status: AgentStatus;
}

/**
 * Fleet board card — one per epic across all registered projects.
 *
 * `stories` is derived from `AgentStore.listLatestByEpic` (per-story dedup,
 * never a shared accumulator that spans epics).
 *
 * `cost` is derived from `aggregateEpicCost(epic, allAgents)` — all agent
 * rows including retried attempts, so retry counts are accurate.
 *
 * `blockers` counts stories in {'blocked', 'failed'}.
 */
export interface FleetCard {
  project_root: string;
  epic_id: string;
  title: string;
  status: EpicStatus;
  autonomy_level: AutonomyLevel;
  paused: boolean;
  stories: FleetStory[];
  cost: EpicCost;
  blockers: number;
}
