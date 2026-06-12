import type { LLMClient } from '../llm/index.js';

/**
 * Shared context for a single planning run. `runId` scopes all artifacts to
 * `.loom/planning/<runId>/` so repeated `loom epic` invocations never collide.
 * `runId` equals the first epic id the run will produce (e.g. "epic-003").
 */
export interface PlannerContext {
  projectRoot: string;
  llm: LLMClient;
  /** Model id for planning calls, e.g. claude-sonnet-4-6. */
  model: string;
  runId: string;
  /**
   * Optional skill bodies selected for this run. The Analyst applies them as
   * reference practices while producing the brief — guidance, not deliverables.
   */
  skills?: string[];
  /**
   * policy.agents.shared_contract === 'on'. When true the Architect runs its
   * extra "Headless task C" pass to emit the epic-wide shared contract. Off by
   * default so planning spends no extra tokens and the worker prompt stays
   * byte-identical to the bench baseline.
   */
  sharedContract?: boolean;
  /**
   * policy.agents.qa_planning === 'advisory'. When true the QA persona (Tessa)
   * runs after the Architect to write a per-story test_plan. Off by default so
   * planning spends no extra tokens and the worker prompt stays byte-identical
   * to the bench baseline.
   */
  qaPlanning?: boolean;
}
