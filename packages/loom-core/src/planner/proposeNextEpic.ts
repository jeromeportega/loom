import type { LessonRow } from '../findings/lesson.js';
import type { LessonStore } from '../state/LessonStore.js';
import type { OpportunityRecord } from '../signals/OpportunityEngine.js';
import type { OpportunityStore } from '../signals/OpportunityStore.js';
import type { EpicStore } from '../state/EpicStore.js';
import type { AuditLog } from '../state/AuditLog.js';
import { evaluateBriefGate } from '../brief/gate.js';
import type { BriefRefinement } from '../brief/types.js';

export interface ProposeDeps {
  lessonStore: LessonStore;
  opportunityStore: OpportunityStore;
  /**
   * BriefRefiner or stub: the SINGLE batched LLM call per proposal.
   * Exactly one invocation on the happy path; zero on gate fail.
   */
  refiner: { refine(rough: string): Promise<BriefRefinement> };
  /**
   * Planner or stub: runs the full planning pipeline when the gate passes.
   * Must NOT make a second model call visible to the proposeNextEpic pipeline
   * (planner.run is the second phase but is treated as a separate concern).
   */
  planner: { run(brief: string): Promise<{ epicIds: string[] }> };
  epicStore: EpicStore;
  audit: AuditLog;
  minBriefQualityScore: number;
}

export type EpicProposeResult =
  | { ok: true; epicId: string }
  | { ok: false; critique: BriefRefinement };

/**
 * Proposes a next epic by combining top-ranked lessons with top open
 * opportunities into a brief, then running it through the brief gate
 * and Planner.
 *
 * EXPLICIT TRIGGER ONLY — no setInterval, setTimeout, cron, scheduler,
 * or auto-approve path references this function (NFR-3). Reachable only
 * from: `loom propose` CLI, `loom_propose` MCP tool, POST /api/propose.
 *
 * Pipeline:
 *   rank lessons (recency + category freq, ADR-006)
 *   → compose brief from lessons + open opportunities
 *   → refiner.refine()   ← exactly ONE batched LLM call
 *   → evaluateBriefGate()
 *   → on fail: return {ok:false, critique}
 *   → on pass: planner.run() → epicStore.setProposedBy('loom')
 *   → audit.record('epic_proposed') → return {ok:true, epicId}
 *
 * Trade-off (accepted for v4.0): frequency-weighted ranking amplifies
 * the currently-noisiest category, which may not be the most valuable.
 */
export async function proposeNextEpic(
  deps: ProposeDeps,
  opts?: { topLessons?: number; topOpps?: number }
): Promise<EpicProposeResult> {
  const topLessons = opts?.topLessons ?? 5;
  const topOpps = opts?.topOpps ?? 3;

  // 1. Rank lessons by recency + category frequency (ADR-006)
  const allLessons = deps.lessonStore.list();
  const rankedLessons = rankLessons(allLessons, topLessons);

  // 2. Pull top open opportunities
  const opps = deps.opportunityStore.listRanked({ status: 'open', limit: topOpps });

  // 3. Compose rough brief from lessons + opportunities
  const rough = composeBrief(rankedLessons, opps);

  // 4. Single batched LLM call: BriefRefiner (exactly one per proposal)
  const refinement = await deps.refiner.refine(rough);

  // 5. Brief gate: both ready===true AND quality_score >= threshold must hold
  if (!evaluateBriefGate(refinement, deps.minBriefQualityScore).pass) {
    return { ok: false, critique: refinement };
  }

  // 6. Gate passed: run the planner → produces planned + manual epic
  const brief = refinement.refined_brief ?? rough;
  const planResult = await deps.planner.run(brief);
  const epicId = planResult.epicIds[0];
  if (!epicId) throw new Error('Planner returned no epic IDs — cannot complete proposal');

  // 7. Stamp proposed_by='loom'; epic stays planned + manual until human approves
  deps.epicStore.setProposedBy(epicId, 'loom');

  // 8. Audit before returning (ordering invariant)
  deps.audit.record({
    action: 'epic_proposed',
    command: epicId,
    detail: { proposed_by: 'loom' },
  });

  return { ok: true, epicId };
}

/**
 * Ranks lessons by recency + category frequency (ADR-006).
 *
 * Score = categoryFrequency + (1 / (recencyRank + 1))
 *
 * Lessons in frequently-recurring categories score higher; among equal
 * category-frequency lessons, more recently created ones rank first.
 * The fractional recency bonus breaks ties without overriding frequency.
 */
function rankLessons(lessons: LessonRow[], topN: number): LessonRow[] {
  if (lessons.length === 0) return [];

  // Count category frequency across all lessons
  const catFreq = new Map<string, number>();
  for (const l of lessons) {
    catFreq.set(l.category, (catFreq.get(l.category) ?? 0) + 1);
  }

  // Sort by created_at DESC to assign recency rank (0 = most recent)
  const byRecency = [...lessons].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const recencyRank = new Map<number, number>();
  byRecency.forEach((l, i) => recencyRank.set(l.id, i));

  const scored = lessons.map((l) => ({
    lesson: l,
    score: (catFreq.get(l.category) ?? 1) + 1 / ((recencyRank.get(l.id) ?? 0) + 1),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((s) => s.lesson);
}

function composeBrief(lessons: LessonRow[], opps: OpportunityRecord[]): string {
  const lines: string[] = ['# Proposed Next Epic', ''];

  if (lessons.length > 0) {
    lines.push('## Lessons from Prior Epics', '');
    for (const l of lessons) {
      lines.push(`**[${l.category}]** ${l.general_rule}`);
      lines.push(`  *(from epic ${l.epic_id})*`, '');
    }
  }

  if (opps.length > 0) {
    lines.push('## Top Open Opportunities', '');
    for (const o of opps) {
      lines.push(`### ${o.title}`);
      lines.push(o.rationale);
      if (o.evidence.length > 0) {
        lines.push('');
        lines.push('Evidence:');
        for (const e of o.evidence) {
          lines.push(`- [${e.title}](${e.url})`);
        }
      }
      lines.push('');
    }
  }

  lines.push(
    '## Direction',
    '',
    'Based on the lessons and opportunities above, propose an epic that would deliver ' +
      'the highest-impact improvement to this system. The brief must specify: ' +
      'goal, user served, in-scope capabilities, out-of-scope non-goals, ' +
      'technical constraints, and concrete success criteria.'
  );

  return lines.join('\n');
}
