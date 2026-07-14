/**
 * GET  /api/opportunities[?project=<root>]   → 200 OpportunityCard[]
 * POST /api/opportunities/:id/scope          → 200 ScopeResult
 * POST /api/opportunities/:id/dismiss        → 200 { status:'dismissed' }
 *
 * GET is public-read (accessGuard readOnly mode lets GET/HEAD through without
 * a token). Both POSTs are token-gated via the same accessGuard already
 * installed on all /api/* routes (readOnly=true → non-GET/HEAD → 403 without
 * the write token).
 *
 * Owner: story-004-006
 */

import path from 'node:path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import {
  OpportunityStore,
  scopeOpportunity,
  PolicyEngine,
  createLLMClient,
  modelFor,
  MIN_BRIEF_QUALITY_SCORE,
} from '@loom-ai/core';
import type { LLMClient } from '@loom-ai/core';
import type { ResolveProjectDb } from '../resolveProjectDb.js';
import type { OpportunityCard } from '../../shared/opportunities.js';

export interface OpportunityDeps {
  db: Database.Database;
  resolveProjectDb: ResolveProjectDb;
  projectRoot?: string;
  llm?: LLMClient;
  refineModel?: string;
  planModel?: string;
  minBriefQualityScore?: number;
  loomBin?: readonly string[];
  /** Test injection — bypasses BriefRefiner LLM call (mirrors scopeOpportunity ScopeDeps). */
  _briefRefiner?: { refine(rough: string): Promise<unknown> };
  /** Test injection — bypasses Planner LLM call. */
  _planner?: { run(brief: string): Promise<{ epicIds: string[] }> };
  [key: string]: unknown;
}

export function registerOpportunityRoutes(app: Express, deps: OpportunityDeps): void {
  const currentProjectRoot = deps.projectRoot ?? process.cwd();

  // GET /api/opportunities — public-read federated list
  app.get('/api/opportunities', (req, res) => {
    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      res.status(e.statusCode ?? 400).json({ error: e.message ?? 'bad request' });
      return;
    }
    try {
      const store = new OpportunityStore(resolved.db);
      const rows = store.listRanked();
      const cards: OpportunityCard[] = rows.map((r) => ({
        id: r.id,
        project_root: resolved.project_root,
        title: r.title,
        rationale: r.rationale,
        score: r.score,
        rank: r.rank,
        signal_count: r.signal_count,
        status: r.status,
        evidence: r.evidence,
        scoped_epic_id: r.scoped_epic_id,
      }));
      res.json(cards);
    } finally {
      resolved.cleanup();
    }
  });

  // POST /api/opportunities/:id/scope — token-gated
  // scopeOpportunity writes the 'opportunity_scoped' audit row internally
  app.post('/api/opportunities/:id/scope', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      res.status(e.statusCode ?? 400).json({ error: e.message ?? 'bad request' });
      return;
    }

    // Resolve LLM deps: use injected values (tests), else load from policy at
    // request time (production). Fall back to 503 if no policy on disk.
    let llm = deps.llm;
    let refineModel = deps.refineModel;
    let planModel = deps.planModel;
    let minBriefQualityScore = deps.minBriefQualityScore;

    if (!llm && !deps._briefRefiner) {
      const loomDir = path.join(resolved.project_root, '.loom');
      try {
        const policy = PolicyEngine.load(loomDir).policyData;
        llm = createLLMClient(policy.agents.llm_backend);
        refineModel = modelFor(policy, 'planning');
        planModel = modelFor(policy, 'planning');
        minBriefQualityScore = MIN_BRIEF_QUALITY_SCORE;
      } catch {
        resolved.cleanup();
        res.status(503).json({ error: 'LLM not configured — run loom init first' });
        return;
      }
    }

    try {
      const result = await scopeOpportunity(
        {
          db: resolved.db,
          projectRoot: resolved.project_root,
          llm: llm!,
          refineModel: refineModel ?? '',
          planModel: planModel ?? '',
          minBriefQualityScore: minBriefQualityScore ?? 7,
          auditLog: resolved.auditLog,
          _briefRefiner: deps._briefRefiner as Parameters<typeof scopeOpportunity>[0]['_briefRefiner'],
          _planner: deps._planner as Parameters<typeof scopeOpportunity>[0]['_planner'],
        },
        id
      );
      res.json(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      const status =
        e.statusCode ?? (e.message?.includes('not found') ? 404 : 500);
      res.status(status).json({ error: e.message ?? 'internal error' });
    } finally {
      resolved.cleanup();
    }
  });

  // POST /api/opportunities/:id/dismiss — token-gated; writes audit row here
  app.post('/api/opportunities/:id/dismiss', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      res.status(e.statusCode ?? 400).json({ error: e.message ?? 'bad request' });
      return;
    }
    try {
      const store = new OpportunityStore(resolved.db);
      const opp = store.get(id);
      if (!opp) {
        res.status(404).json({ error: 'opportunity not found' });
        return;
      }
      store.markDismissed(id);
      resolved.auditLog.record({
        action: 'opportunity_dismissed',
        command: String(id),
        detail: { id, title: opp.title },
      });
      res.json({ status: 'dismissed' });
    } finally {
      resolved.cleanup();
    }
  });
}
