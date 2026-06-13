import type Database from 'better-sqlite3';
import type { LLMClient } from '../llm/LLMClient.js';
import type { AuditLog } from '../state/AuditLog.js';
import { AuditLog as AuditLogImpl } from '../state/AuditLog.js';
import { OpportunityStore } from './OpportunityStore.js';
import { BriefRefiner } from '../brief/BriefRefiner.js';
import { evaluateBriefGate } from '../brief/gate.js';
import { Planner } from '../planner/Planner.js';
import type { BriefRefinement } from '../brief/types.js';

export type ScopeResult =
  | { ok: true; epicId: string }
  | { ok: false; critique: string };

interface ScopeDeps {
  db: Database.Database;
  projectRoot: string;
  llm: LLMClient;
  refineModel: string;
  planModel: string;
  minBriefQualityScore: number;
  auditLog: AuditLog;
  /** Test injection — avoids real LLM calls inside BriefRefiner. */
  _briefRefiner?: { refine(rough: string): Promise<BriefRefinement> };
  /** Test injection — avoids spawning the full planning pipeline. */
  _planner?: { run(brief: string): Promise<{ epicIds: string[] }> };
}

/**
 * Scopes an opportunity to a planned epic. Runs ONLY on explicit operator action
 * (no scheduler, no score-threshold auto-trigger — ADR-006).
 *
 * Flow: fetch opportunity → build rough brief → BriefRefiner.refine() → brief gate
 *   → on fail:  record critique audit row, leave opportunity open, return {ok:false}
 *   → on pass:  Planner.run() → mark opportunity scoped → record audit → return {ok:true}
 */
export async function scopeOpportunity(
  deps: ScopeDeps,
  opportunityId: number
): Promise<ScopeResult> {
  const opportunityStore = new OpportunityStore(deps.db);
  const opportunity = opportunityStore.get(opportunityId);

  if (!opportunity) {
    throw new Error(`Opportunity ${opportunityId} not found`);
  }

  // Idempotency: already scoped → return the existing epic id, no double-create
  if (opportunity.status === 'scoped' && opportunity.scoped_epic_id) {
    return { ok: true, epicId: opportunity.scoped_epic_id };
  }

  // Build a rough brief from the opportunity's rationale and evidence summary
  const evidencePart =
    opportunity.evidence.length > 0
      ? `\n\n## Evidence\n\n${opportunity.evidence.map((e) => `- [${e.title}](${e.url})`).join('\n')}`
      : '';
  const rough = `# ${opportunity.title}\n\n${opportunity.rationale}${evidencePart}`;

  // Brief refinement (single LLM call, planning-tier model)
  const refiner =
    deps._briefRefiner ??
    new BriefRefiner({ projectRoot: deps.projectRoot, llm: deps.llm, model: deps.refineModel });
  const refinement = await refiner.refine(rough);

  // Brief gate: both ready===true AND quality_score >= threshold must hold
  if (!evaluateBriefGate(refinement, deps.minBriefQualityScore).pass) {
    const critique =
      [...refinement.critique.ambiguities, ...refinement.critique.missing_scope].join('; ') ||
      'brief quality score below threshold';
    deps.auditLog.record({
      action: 'opportunity_scoped',
      command: String(opportunityId),
      detail: { ok: false, critique },
    });
    return { ok: false, critique };
  }

  // Gate passed: plan the epic (produces a planned + autonomy_level='manual' epic)
  const brief = refinement.refined_brief ?? rough;
  const planner =
    deps._planner ??
    new Planner({
      projectRoot: deps.projectRoot,
      llm: deps.llm,
      model: deps.planModel,
      db: deps.db,
    });

  const planResult = await planner.run(brief);
  const epicId = planResult.epicIds[0];

  // Link the opportunity to its scoped epic
  opportunityStore.markScoped(opportunityId, epicId);

  deps.auditLog.record({
    action: 'opportunity_scoped',
    command: String(opportunityId),
    detail: { ok: true, epic_id: epicId },
  });

  return { ok: true, epicId };
}

/**
 * Called from the reject handler (POST /api/epics/:id/reject) so that a rejected
 * scoped epic returns its linked opportunity to status='open'.
 *
 * No-op when the epic has no linked opportunity (e.g. plain planned epics).
 */
export function reopenOpportunityForRejectedEpic(db: Database.Database, epicId: string): void {
  const opportunityStore = new OpportunityStore(db);
  const opportunity = opportunityStore.getByEpicId(epicId);
  if (!opportunity) return;

  opportunityStore.reopen(opportunity.id);

  new AuditLogImpl(db).record({
    action: 'opportunity_reopened',
    command: epicId,
    detail: { opportunity_id: opportunity.id },
  });
}
