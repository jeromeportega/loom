import type { LessonExtractor, EpicTelemetry } from '../findings/LessonExtractor.js';
import type { LessonStore } from '../state/LessonStore.js';
import type { AuditLog } from '../state/AuditLog.js';
import type { DecisionTraceStore } from '../state/DecisionTraceStore.js';
import type { AgentStore } from '../state/AgentStore.js';

export interface AutoRetrospectiveOptions {
  extractor: LessonExtractor;
  lessonStore: LessonStore;
  audit: AuditLog;
  traces: DecisionTraceStore;
  agents: AgentStore;
}

/**
 * Collects epic-level telemetry from the three canonical sources for use
 * by the lesson extractor. Returns immediately with empty arrays if a
 * source is unavailable — the empty-contract check in LessonExtractor
 * will skip the LLM call in that case (FR-5).
 */
export async function gatherEpicTelemetry(
  epicId: string,
  finalStatus: 'done' | 'failed',
  deps: Pick<AutoRetrospectiveOptions, 'traces' | 'agents' | 'audit'>
): Promise<EpicTelemetry> {
  const decision_traces = deps.traces.getByEpic(epicId);
  const agentRecords = deps.agents.listByEpic(epicId);
  const agents = agentRecords.map((a) => ({
    story_id: a.story_id,
    review_summary: a.review_summary ?? null,
    log_tail: a.log_tail ?? null,
  }));
  const audit_tail = deps.audit.getByCommand(epicId);
  return { epic_id: epicId, final_status: finalStatus, decision_traces, agents, audit_tail };
}

/**
 * Runs a best-effort retrospective after an epic reaches a terminal state.
 * Gathers telemetry, calls the lesson extractor exactly once (on the happy
 * path), and persists any lessons via LessonStore. MUST NOT throw — any
 * failure is caught internally and recorded as `auto_retro_skipped`.
 */
export class AutoRetrospective {
  constructor(private opts: AutoRetrospectiveOptions) {}

  async run(epicId: string, finalStatus: 'done' | 'failed'): Promise<void> {
    try {
      const telemetry = await gatherEpicTelemetry(epicId, finalStatus, this.opts);
      const lessons = await this.opts.extractor.extract(telemetry);
      if (lessons.length > 0) {
        this.opts.lessonStore.insert(lessons);
      }
    } catch (err) {
      this.opts.audit.record({
        action: 'auto_retro_skipped',
        command: epicId,
        allowed: true,
        detail: { reason: String(err) },
      });
    }
  }
}
