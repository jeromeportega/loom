/**
 * GET /api/lessons — read-only federated flywheel data
 *
 * Returns LessonsResponse: all lessons (with applied_as/applied_ref showing
 * where each was applied), self-proposed planned epics (proposed_by='loom'),
 * and an empty flag for the defined empty state (FR-12).
 *
 * Passes accessGuard in readOnly mode without a token (GET route). Any
 * mutating route added here must be token-gated — POST /api/propose is
 * already owned by story-005-006 in routes/propose.ts.
 *
 * Owner: story-005-007
 */

import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { LessonStore, EpicStore } from '@loom-ai/core';

export interface LessonDeps {
  db: Database.Database;
  [key: string]: unknown;
}

export type LessonsResponse = {
  lessons: {
    id: number;
    epic_id: string;
    category: string;
    observation: string;
    general_rule: string;
    applied_as: string | null;
    applied_ref: string | null;
    created_at: string;
  }[];
  proposals: { epic_id: string; title: string; created_at: string }[];
  empty: boolean;
};

export function registerLessonRoutes(app: Express, deps: LessonDeps): void {
  app.get('/api/lessons', (_req, res) => {
    const lessonStore = new LessonStore(deps.db);
    const epicStore = new EpicStore(deps.db);

    const lessonRows = lessonStore.list();
    const lessons: LessonsResponse['lessons'] = lessonRows.map((r) => ({
      id: r.id,
      epic_id: r.epic_id,
      category: r.category,
      observation: r.observation,
      general_rule: r.general_rule,
      applied_as: r.applied_as,
      applied_ref: r.applied_ref,
      created_at: r.created_at,
    }));

    // Proposals: planned epics where proposed_by='loom'. The proposed_by column
    // was added in v18 (story-005-001) but is not in the EpicRecord TS type, so
    // we read it via a type cast — same guard pattern as autonomy_level in fleet.ts.
    const plannedEpics = epicStore.listByStatus('planned');
    type WithProposedBy = { proposed_by?: string | null };
    const proposals: LessonsResponse['proposals'] = plannedEpics
      .filter((e) => (e as typeof e & WithProposedBy).proposed_by === 'loom')
      .map((e) => ({
        epic_id: e.id,
        title: e.title,
        created_at: e.created_at,
      }));

    const empty = lessons.length === 0 && proposals.length === 0;

    const response: LessonsResponse = { lessons, proposals, empty };
    res.json(response);
  });
}
