/**
 * POST /api/propose — mission-control button for self-proposed epics.
 *
 * Token-gated via the accessGuard already installed on all /api/* routes
 * (readOnly=true → non-GET/HEAD → 403 without the write token).
 *
 * Owner: story-005-006
 */

import path from 'node:path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import {
  LessonStore,
  OpportunityStore,
  EpicStore,
  AuditLog,
  BriefRefiner,
  Planner,
  PolicyEngine,
  createLLMClient,
  modelFor,
  proposeNextEpic,
} from '@loom-ai/core';
import type { BriefRefinement } from '@loom-ai/core';

export interface ProposeDeps {
  db: Database.Database;
  projectRoot?: string;
  /** Test injection — bypasses BriefRefiner LLM call. */
  _refiner?: { refine(rough: string): Promise<BriefRefinement> };
  /** Test injection — bypasses Planner LLM call. */
  _planner?: { run(brief: string): Promise<{ epicIds: string[] }> };
}

export function registerProposeRoutes(app: Express, deps: ProposeDeps): void {
  const currentProjectRoot = deps.projectRoot ?? process.cwd();
  const loomDir = path.join(currentProjectRoot, '.loom');

  app.post('/api/propose', async (req, res) => {
    const topLessons =
      typeof req.body?.top_lessons === 'number' ? req.body.top_lessons : undefined;
    const topOpps =
      typeof req.body?.top_opps === 'number' ? req.body.top_opps : undefined;

    let minBriefQualityScore = 7;
    let refiner = deps._refiner;
    let planner = deps._planner;

    if (!refiner || !planner) {
      let policy;
      try {
        policy = PolicyEngine.load(loomDir).policyData;
      } catch {
        res.status(503).json({ error: 'LLM not configured — run loom init first' });
        return;
      }
      let llm;
      try {
        llm = createLLMClient(policy.agents.llm_backend);
      } catch {
        res.status(503).json({ error: 'LLM not configured — run loom init first' });
        return;
      }
      minBriefQualityScore = policy.agents.min_brief_quality_score;
      const model = modelFor(policy, 'planning');
      if (!refiner) {
        refiner = new BriefRefiner({ projectRoot: currentProjectRoot, llm, model });
      }
      if (!planner) {
        planner = new Planner({ projectRoot: currentProjectRoot, llm, model, db: deps.db });
      }
    }

    try {
      const result = await proposeNextEpic(
        {
          lessonStore: new LessonStore(deps.db),
          opportunityStore: new OpportunityStore(deps.db),
          refiner,
          planner,
          epicStore: new EpicStore(deps.db),
          audit: new AuditLog(deps.db),
          minBriefQualityScore,
        },
        { topLessons, topOpps }
      );
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'internal error';
      res.status(500).json({ error: msg });
    }
  });
}
