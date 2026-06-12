import type Database from 'better-sqlite3';
import type { Investigation } from '../findings/investigation.js';
import { AuditLog } from '../state/AuditLog.js';
import { invokeSkill } from '../skills/types.js';
import { routeByGrade, type FailurePayload, type RouteDecision } from './router.js';

/**
 * Runtime dependencies {@link investigateAndRoute} needs beyond the failure
 * payload: the loom state db (for the skill invocation + audit rows), the epic
 * id (the payload only carries the story id), and the optional agent id that
 * attributes the audit rows to a concrete attempt.
 *
 * The shared contract documents `investigateAndRoute(p)` as a one-arg shape;
 * the real signature takes this context as a second argument, exactly as the
 * contract's `invokeSkill(call)` shape is implemented as `invokeSkill(call, ctx)`.
 * Writing the distinguishable `audit_log` rows the acceptance criteria require
 * is impossible without a db handle.
 */
export interface RouteContext {
  db: Database.Database;
  epic_id: string;
  agent_id?: string;
}

/** Maps each decision kind onto its exact, distinguishable audit_log action. */
const ACTION_BY_KIND: Record<RouteDecision['kind'], string> = {
  'retry-with-hint': 'failure.routed.retry_with_hint',
  'surface-to-operator': 'failure.routed.surface_to_operator',
  'stop-epic': 'failure.routed.stop_epic',
};

/**
 * The thin wrapper the failure-handling call site invokes: run the
 * failure-investigator skill on the payload, then route the resulting grade
 * through the pure {@link routeByGrade}. Two audit rows are written before
 * returning (CLAUDE.md invariant #5 — provenance lands before the caller acts):
 *
 *   1. `failure.investigation.graded` — the investigator's verdict.
 *   2. `failure.routed.{retry_with_hint|surface_to_operator|stop_epic}` — the
 *      dispatch the router chose. The three actions are distinct literals so an
 *      operator (and the verification suite) can tell the paths apart.
 *
 * The returned `RouteDecision` carries the investigator's `hint` on the
 * retry-with-hint arm; the caller threads that hint into the next worker
 * invocation's input. This function adds no retry ceiling — the caller's
 * existing per-story retry loop bounds how often a strong grade re-dispatches.
 */
export async function investigateAndRoute(
  p: FailurePayload,
  ctx: RouteContext,
): Promise<RouteDecision> {
  const { output: inv } = await invokeSkill<FailurePayload, Investigation>(
    { name: 'failure-investigator', input: p, story_id: p.story_id, epic_id: ctx.epic_id },
    { db: ctx.db, agent_id: ctx.agent_id },
  );

  const audit = new AuditLog(ctx.db);
  audit.record({
    agent_id: ctx.agent_id,
    action: 'failure.investigation.graded',
    command: p.story_id,
    detail: {
      epic_id: ctx.epic_id,
      grade: inv.grade,
      hypothesis: inv.hypothesis,
      evidence_refs: inv.evidence_refs.length,
      failing_test_or_gate: p.failing_test_or_gate,
    },
  });

  const decision = routeByGrade(inv);
  audit.record({
    agent_id: ctx.agent_id,
    action: ACTION_BY_KIND[decision.kind],
    command: p.story_id,
    detail: {
      epic_id: ctx.epic_id,
      kind: decision.kind,
      ...(decision.kind === 'retry-with-hint'
        ? { hint: decision.hint }
        : { reason: decision.reason }),
    },
  });

  return decision;
}
