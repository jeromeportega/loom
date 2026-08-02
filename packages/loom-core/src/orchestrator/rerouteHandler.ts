/**
 * Reroute handler for decomposition-aware orchestration (epic-095, reroute rework).
 *
 * When a worker signals `LOOM_TOO_BIG` or is killed at absoluteCapMs, the
 * Supervisor invokes the PM to decompose the story into N ≥ 2 sub-stories and
 * splices them into the live DAG. This module is the budget-gated PM call
 * (`handleReroute`), the pure validation (`validateSubStories`), and the atomic
 * DB injection (`injectSubStories`). The Supervisor (which alone holds the full
 * DAG) allocates the sub-story IDs and computes the downstream re-points.
 *
 * Rework fixes (post-gate): lineage-scoped budget via seeded `resplit_count`
 * (not a per-story-id increment); pre-injection validation; a single atomic
 * transaction that also supersedes the original; no separate increment write.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditLog } from '../state/AuditLog.js';
import { AGENT_ID_RANDOM_BYTES } from '../state/AgentStore.js';
import type { AgentStore } from '../state/AgentStore.js';
import type { Story } from '../types.js';
import { MAX_RESPLIT_BUDGET } from './constants.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ReroutePayload {
  story:         Story;
  fanOutPayload: string;
  trigger:       'LOOM_TOO_BIG' | 'cap';
}

export class RerouteBudgetExhaustedError extends Error {
  readonly storyId: string;
  readonly resplitCount: number;
  constructor(storyId: string, resplitCount: number) {
    super(
      `Story ${storyId} has exhausted its re-split budget ` +
      `(MAX_RESPLIT_BUDGET=${MAX_RESPLIT_BUDGET}, lineage count=${resplitCount}). ` +
      `It cannot be re-split again and has been marked failed.`
    );
    this.name = 'RerouteBudgetExhaustedError';
    this.storyId = storyId;
    this.resplitCount = resplitCount;
  }
}

/** Thrown when the PM's proposed sub-graph is malformed (see validateSubStories). */
export class RerouteValidationError extends Error {
  readonly storyId: string;
  constructor(storyId: string, reason: string) {
    super(`Reroute of ${storyId} rejected: ${reason}. Story marked failed.`);
    this.name = 'RerouteValidationError';
    this.storyId = storyId;
  }
}

/**
 * Injectable PM interface. `decompose` splits an oversized story into N ≥ 2
 * sub-stories. `coverageKeys` are the `requires` keys that downstream stories
 * demand FROM the original — the PM MUST arrange for exactly one sub-story to
 * `provides` each of them (enforced by validateSubStories). The PM returns
 * sub-stories with placeholder IDs; the Supervisor re-stamps schema-valid IDs.
 */
export interface PMAgent {
  decompose(storySpec: string, fanOutPayload: string, coverageKeys: string[]): Promise<Story[]>;
}

/** Re-point a downstream dependent's `dependencies` (original → all sub-stories). */
export interface DownstreamOverride {
  storyId:         string;
  newDependencies: string[];
}

/** Re-point a downstream dependent's `requires` map (original → providing sub-story). */
export interface DownstreamRequiresOverride {
  storyId:     string;
  newRequires: Record<string, string>;
}

// ─── Core: budget-gated PM call ─────────────────────────────────────────────────

/**
 * Budget check + PM decompose. Reads the story's LINEAGE resplit count (sub-stories
 * are seeded with parent+1 at injection, so this bounds re-split DEPTH, not a single
 * id). Does NOT write anything — the caller validates the result and injects it in
 * one atomic transaction. Returns the raw sub-stories (placeholder IDs) plus the
 * parent's resplit count for lineage seeding.
 *
 * Throws `RerouteBudgetExhaustedError` (no PM call) when the lineage budget is spent,
 * or `RerouteValidationError` when the PM returns fewer than 2 sub-stories.
 */
export async function handleReroute(
  payload: ReroutePayload,
  opts: {
    pmAgent:      PMAgent;
    agents:       AgentStore;
    epicId:       string;
    auditLog:     AuditLog;
    coverageKeys: string[];
  }
): Promise<{ subStories: Story[]; parentResplitCount: number }> {
  const { story, fanOutPayload, trigger } = payload;
  const { pmAgent, agents, epicId, auditLog, coverageKeys } = opts;

  const parentResplitCount = agents.getResplitCount(story.id, epicId);

  if (parentResplitCount >= MAX_RESPLIT_BUDGET) {
    auditLog.record({
      action:  'reroute_budget_exhausted',
      command: story.id,
      allowed: false,
      detail: { resplitCount: parentResplitCount, maxBudget: MAX_RESPLIT_BUDGET, trigger, epicId },
    });
    throw new RerouteBudgetExhaustedError(story.id, parentResplitCount);
  }

  auditLog.record({
    action:  'reroute_pm_invoked',
    command: story.id,
    allowed: true,
    detail: { trigger, epicId, lineageResplitCount: parentResplitCount, coverageKeys },
  });

  const subStories = await pmAgent.decompose(renderStorySpec(story), fanOutPayload, coverageKeys);

  if (subStories.length < 2) {
    auditLog.record({
      action:  'reroute_pm_insufficient',
      command: story.id,
      allowed: false,
      detail: { trigger, subStoryCount: subStories.length, epicId },
    });
    throw new RerouteValidationError(story.id, `PM returned ${subStories.length} sub-stories; need at least 2`);
  }

  auditLog.record({
    action:  'reroute_pm_succeeded',
    command: story.id,
    allowed: true,
    detail: { trigger, epicId, subStoryCount: subStories.length },
  });

  return { subStories, parentResplitCount };
}

// ─── Validation (pure) ──────────────────────────────────────────────────────────

/**
 * Validates a PM-proposed sub-graph BEFORE any DB write. Throws
 * `RerouteValidationError` on any violation. `subStories` must already carry their
 * final (Supervisor-allocated) IDs.
 *
 * Checks: ≥2 sub-stories; unique IDs; no collision with existing tasks; no
 * self-dependency; every sub dependency resolves to a SIBLING sub-story or an
 * UPSTREAM of the original (never the original itself, never a downstream — which
 * would form a cycle once downstreams are re-pointed onto the subs); no cycle among
 * the sub-stories; each `coverageKey` (a downstream-required key) is `provides`d by
 * EXACTLY ONE sub-story (exact partition, so requires re-pointing is unambiguous);
 * and each sub's own `requires` resolves to a sibling or an existing story.
 */
export function validateSubStories(
  original:        Story,
  subStories:      Story[],
  existingTaskIds: Set<string>,
  coverageKeys:    string[]
): void {
  const fail = (reason: string): never => { throw new RerouteValidationError(original.id, reason); };

  if (subStories.length < 2) fail('fewer than 2 sub-stories');

  const subIds = subStories.map((s) => s.id);
  const subIdSet = new Set(subIds);
  if (subIdSet.size !== subIds.length) fail('duplicate sub-story ids');
  for (const id of subIds) {
    if (existingTaskIds.has(id)) fail(`sub-story id ${id} collides with an existing story`);
  }

  // Dependencies: siblings or upstreams-of-the-original only.
  const allowedDeps = new Set<string>([...subIdSet, ...original.dependencies]);
  for (const sub of subStories) {
    for (const dep of sub.dependencies) {
      if (dep === sub.id) fail(`sub-story ${sub.id} depends on itself`);
      if (dep === original.id) fail(`sub-story ${sub.id} depends on the superseded original`);
      if (!allowedDeps.has(dep)) {
        fail(`sub-story ${sub.id} depends on ${dep}, which is neither a sibling sub-story nor an upstream of the original`);
      }
    }
  }

  if (hasCycle(subStories)) fail('sub-stories contain a dependency cycle');

  // Coverage: each downstream-required key provided by exactly one sub-story.
  for (const key of coverageKeys) {
    const providers = subStories.filter((s) => s.provides !== undefined && key in s.provides);
    if (providers.length === 0) fail(`no sub-story provides required key "${key}" (downstream depends on it)`);
    if (providers.length > 1) fail(`required key "${key}" is provided by ${providers.length} sub-stories (must be exactly one)`);
  }

  // Each sub's own `requires` resolves to a sibling sub-story or an existing story —
  // but NEVER the superseded original. `existingTaskIds` still contains original.id at
  // validation time (it's removed from the tasks map only after injection), so guard it
  // explicitly: a sub that requires the original would resolve to a row whose
  // provides_output is NULL (the original never completes) and block forever. Mirrors
  // the dependencies guard above.
  const knownProviders = new Set<string>([...subIdSet, ...existingTaskIds]);
  for (const sub of subStories) {
    if (!sub.requires) continue;
    for (const [key, src] of Object.entries(sub.requires)) {
      if (src === original.id) fail(`sub-story ${sub.id} requires "${key}" from the superseded original`);
      if (!knownProviders.has(src)) fail(`sub-story ${sub.id} requires "${key}" from ${src}, which is not a known story`);
    }
  }
}

/** 3-color DFS cycle check over the sub-story sub-graph (deps restricted to sub ids). */
function hasCycle(subStories: Story[]): boolean {
  const idSet = new Set(subStories.map((s) => s.id));
  const adj = new Map<string, string[]>();
  for (const s of subStories) adj.set(s.id, s.dependencies.filter((d) => idSet.has(d)));
  const color = new Map<string, 0 | 1 | 2>(); // 0=white 1=gray 2=black
  for (const id of idSet) color.set(id, 0);
  const visit = (u: string): boolean => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v);
      if (c === 1) return true;
      if (c === 0 && visit(v)) return true;
    }
    color.set(u, 2);
    return false;
  };
  for (const id of idSet) if (color.get(id) === 0 && visit(id)) return true;
  return false;
}

// ─── Atomic injection ───────────────────────────────────────────────────────────

/**
 * Atomically, in ONE transaction: inserts sub-story agent rows (seeded with
 * `resplit_count = parentResplitCount + 1` so re-split DEPTH is bounded), applies
 * `dep_overrides` and `requires_overrides` to downstream rows, and marks the
 * original's latest agent row `superseded_by` (so the restart map-build excludes
 * it). Sub-story inserts are idempotent on story_id (crash-restart safe). Never
 * touches the YAML plan — all cross-restart state lives in the DB.
 */
export function injectSubStories(
  originalStory: Story,
  subStories:    Story[],
  epicId:        string,
  db:            Database.Database,
  auditLog:      AuditLog,
  opts: {
    parentResplitCount: number;
    depOverrides?:      DownstreamOverride[];
    requiresOverrides?: DownstreamRequiresOverride[];
  }
): void {
  const now = new Date().toISOString();
  const { parentResplitCount, depOverrides = [], requiresOverrides = [] } = opts;
  const subResplit = parentResplitCount + 1;
  const supersededBy = JSON.stringify(subStories.map((s) => s.id));

  const latestId = (storyId: string) =>
    `(SELECT id FROM agents WHERE story_id = ? AND epic_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1)`;

  db.transaction(() => {
    // 1. Sub-story rows (idempotent), seeded with the lineage resplit count.
    for (const sub of subStories) {
      const existing = db
        .prepare('SELECT id FROM agents WHERE story_id = ? AND epic_id = ? LIMIT 1')
        .get(sub.id, epicId) as { id: string } | undefined;
      if (existing) continue; // crash-restart idempotency
      const agentId = `agent-${sub.id}-${crypto.randomBytes(AGENT_ID_RANDOM_BYTES).toString('hex')}`;
      db.prepare(
        `INSERT INTO agents
           (id, epic_id, story_id, story_title, status, story_json, resplit_count, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(agentId, epicId, sub.id, sub.title, 'pending', JSON.stringify(sub), subResplit, now);
      auditLog.record({
        agent_id: agentId,
        action:   'sub_story_injected',
        command:  sub.id,
        allowed:  true,
        detail: {
          epicId, parentStoryId: originalStory.id, trigger: 'reroute',
          title: sub.title, dependenciesLen: sub.dependencies.length, resplitCount: subResplit,
        },
      });
    }

    // 2. dep_overrides on downstream rows.
    for (const ov of depOverrides) {
      db.prepare(
        `UPDATE agents SET dep_overrides = ?, updated_at = ? WHERE story_id = ? AND epic_id = ? AND id = ${latestId('')}`
      ).run(JSON.stringify(ov.newDependencies), now, ov.storyId, epicId, ov.storyId, epicId);
      const ds = db
        .prepare('SELECT id FROM agents WHERE story_id = ? AND epic_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
        .get(ov.storyId, epicId) as { id: string } | undefined;
      auditLog.record({
        agent_id: ds?.id, action: 'dep_override_applied', command: ov.storyId, allowed: true,
        detail: { epicId, newDependencies: ov.newDependencies, replacedForStory: originalStory.id },
      });
    }

    // 3. requires_overrides on downstream rows.
    for (const ov of requiresOverrides) {
      db.prepare(
        `UPDATE agents SET requires_overrides = ?, updated_at = ? WHERE story_id = ? AND epic_id = ? AND id = ${latestId('')}`
      ).run(JSON.stringify(ov.newRequires), now, ov.storyId, epicId, ov.storyId, epicId);
      const ds = db
        .prepare('SELECT id FROM agents WHERE story_id = ? AND epic_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
        .get(ov.storyId, epicId) as { id: string } | undefined;
      auditLog.record({
        agent_id: ds?.id, action: 'requires_override_applied', command: ov.storyId, allowed: true,
        detail: { epicId, newRequires: ov.newRequires, replacedForStory: originalStory.id },
      });
    }

    // 4. Supersede the original — its latest row keeps status='failed' but gains
    //    superseded_by so the restart map-build fully excludes it.
    db.prepare(
      `UPDATE agents SET superseded_by = ?, updated_at = ? WHERE story_id = ? AND epic_id = ? AND id = ${latestId('')}`
    ).run(supersededBy, now, originalStory.id, epicId, originalStory.id, epicId);
    auditLog.record({
      action: 'story_superseded', command: originalStory.id, allowed: true,
      detail: { epicId, subStoryIds: subStories.map((s) => s.id), trigger: 'reroute' },
    });
  })();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Renders a Story as a Markdown spec for the PM's decompose prompt. */
export function renderStorySpec(story: Story): string {
  const lines: string[] = [
    `# Story ${story.id} — ${story.title}`,
    '',
    story.description,
    '',
    '## Acceptance criteria',
    ...story.acceptance_criteria.map((ac) => `- [ ] ${ac}`),
  ];
  if (story.tech_notes?.trim()) {
    lines.push('', '## Technical guidance', story.tech_notes);
  }
  return lines.join('\n');
}
