import type Database from 'better-sqlite3';
import type { LLMClient, ClassifyResult } from '@loom-ai/core';
import { classifyIntake, INTAKE_AUDIT_ACTION, EpicStore, AuditLog } from '@loom-ai/core';

/**
 * Leaf side-effect: classify the intake brief and persist the verdict best-effort
 * to two sinks: EpicStore (the database, which is also the status surface read by
 * `loom status` via `getIntakeVerdicts`) and AuditLog. Never throws — every failure
 * is swallowed so the caller's planning path is unaffected (ADR-001).
 * Returns void; the verdict is never read downstream.
 */
export async function recordIntakeClassification(deps: {
  db: Database.Database;
  epicId: string;
  brief: string;
  llm: LLMClient;
  model: string;
  timeoutMs: number;
}): Promise<void> {
  const { db, epicId, brief, llm, model, timeoutMs } = deps;

  let result: ClassifyResult | undefined;
  // classifyIntake catches LLM errors and returns {ok:false}; this outer catch
  // is for unexpected internal errors only (e.g. a bug inside classifyIntake).
  try {
    result = await classifyIntake(brief, { llm, model, timeoutMs });
  } catch {
    // Unexpected error — still write a failure audit entry so the event is
    // traceable, then swallow so planning is unaffected.
    try {
      new AuditLog(db).record({
        action: INTAKE_AUDIT_ACTION,
        command: brief.slice(0, 120),
        allowed: false,
        detail: { reason: 'unexpected_error' },
      });
    } catch { /* best-effort */ }
    return;
  }
  if (!result) return;

  // Persist to each sink independently so one failure doesn't prevent the others.

  if (result.ok) {
    try {
      new EpicStore(db).recordIntakeVerdict(epicId, result.verdict);
    } catch { /* best-effort */ }
  }

  try {
    new AuditLog(db).record({
      action: INTAKE_AUDIT_ACTION,
      command: brief.slice(0, 120),
      allowed: result.ok,
      detail: result.ok
        ? (result.verdict as Record<string, unknown>)
        : { reason: result.reason, detail: result.detail },
    });
  } catch { /* best-effort */ }
}
