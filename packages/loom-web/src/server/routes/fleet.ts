/**
 * GET /api/fleet — Fleet board endpoint.
 *
 * Returns FleetCard[] aggregating every non-archived epic across all registered
 * projects. Each card carries: status, per-story states, cost (via
 * aggregateEpicCost — verbatim copy so tests can import and call it directly),
 * and a blocker count of stories in {'blocked','failed'}.
 *
 * Cross-epic correctness is structural: listLatestByEpic is called per epic
 * with that epic's id — NO shared accumulator ever spans epics.
 *
 * Owner: story-003-005
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { EpicStore, AgentStore, ProjectRegistry, createDatabase, deriveBlocked, PolicyEngine, resolveRepoStatePaths } from '@loom-ai/core';
import type { ProjectEntry } from '@loom-ai/core';
import type { EpicCost } from '../../shared/types.js';
import type { FleetCard, FleetStory, AutonomyLevel } from '../../shared/fleet.js';

/**
 * Minimum deps this route module needs. TypeScript structural typing makes
 * this compatible with the full RouteDeps that story-003-006 will pass.
 */
export interface FleetDeps {
  epicStore: EpicStore;
  agentStore: AgentStore;
  db: Database.Database;
  /** Absolute path of the project the web server was launched in. Default: cwd. */
  projectRoot?: string;
  /** Unified active + machine-default registry; falls back to ProjectRegistry.list(). */
  unifiedRegistry?: Map<string, ProjectEntry>;
  // All other RouteDeps fields are accepted but unused (structural subtype).
  [key: string]: unknown;
}

export function registerFleetRoutes(app: Express, deps: FleetDeps): void {
  const currentProjectRoot = deps.projectRoot ?? process.cwd();

  app.get('/api/fleet', (_req, res) => {
    const cards: FleetCard[] = [];

    // Current project first (same ordering convention as /api/status).
    cards.push(
      ...buildProjectCards(deps.epicStore, deps.agentStore, currentProjectRoot)
    );

    // Peer projects — same best-effort federation pattern as /api/status.
    const registryEntries = deps.unifiedRegistry ? [...deps.unifiedRegistry.values()] : new ProjectRegistry().list();
    for (const entry of registryEntries) {
      if (entry.root === currentProjectRoot) continue;
      let peerLoomHome: string | undefined;
      try {
        peerLoomHome = PolicyEngine.load(path.join(entry.root, '.loom')).policyData.loom_home;
      } catch { /* use default */ }
      const { namespaceDir } = resolveRepoStatePaths(entry.root, { loom_home: peerLoomHome ?? '' });
      const dbPath = path.join(namespaceDir, 'loom.db');
      if (!fs.existsSync(dbPath)) continue;
      try {
        const peerDb = createDatabase(dbPath);
        const peerEpicStore = new EpicStore(peerDb);
        const peerAgentStore = new AgentStore(peerDb);
        cards.push(...buildProjectCards(peerEpicStore, peerAgentStore, entry.root));
        peerDb.close();
      } catch {
        // Best-effort: a locked or transient peer DB must not crash the response.
      }
    }

    res.json(cards);
  });
}

const BLOCKER_STATUSES = new Set(['blocked', 'failed']);

/**
 * Builds fleet cards for all non-archived epics in one project.
 * Per-story dedup via listLatestByEpic — NEVER uses a shared accumulator
 * that spans epics (the cross-epic isolation invariant).
 */
function buildProjectCards(
  epicStore: EpicStore,
  agentStore: AgentStore,
  projectRoot: string
): FleetCard[] {
  // Archived epics are hidden from the fleet view, same as /api/status.
  const epics = epicStore.list();
  return epics.map((epic) => {
    // Per-story dedup: one row per story_id, most-recent attempt.
    const latestAgents = agentStore.listLatestByEpic(epic.id);
    const stories: FleetStory[] = latestAgents.map((a) => ({
      story_id: a.story_id,
      status: a.status,
    }));

    // Cost uses ALL agent rows (including retried), same as /api/cost.
    const allAgents = agentStore.listByEpic(epic.id);
    const cost = aggregateEpicCost(epic, allAgents);

    // Blockers: count of stories (deduplicated) in blocked or failed state.
    const blockers = latestAgents.filter((a) => BLOCKER_STATUSES.has(a.status)).length;

    // autonomy_level and paused_at are added by story-003-001 (schema v16).
    // Guard against pre-v16 rows that don't have these columns yet.
    const epicRow = epic as typeof epic & {
      autonomy_level?: string | null;
      paused_at?: string | null;
    };
    const autonomy_level = (epicRow.autonomy_level ?? 'manual') as AutonomyLevel;
    const paused = epicRow.paused_at != null;

    return {
      project_root: projectRoot,
      epic_id: epic.id,
      title: epic.title,
      status: epic.status,
      autonomy_level,
      paused,
      stories,
      cost,
      blockers,
      ...(deriveBlocked(epic) ?? {}),
    };
  });
}

/**
 * Verbatim copy of aggregateEpicCost from packages/loom-web/src/server/index.ts.
 * Exported so tests can call it directly and assert the fleet endpoint's cost
 * equals a direct invocation (the "reused verbatim" acceptance criterion).
 *
 * Do NOT change this implementation independently — any fix to the original
 * in index.ts must be mirrored here. The intent is identical behavior.
 */
export function aggregateEpicCost(
  epic: ReturnType<EpicStore['get']>,
  agents: ReturnType<AgentStore['listByEpic']>
): EpicCost {
  if (!epic) {
    return {
      epic_id: '?',
      title: '?',
      planner_tokens: 0,
      planner_requests: 0,
      worker_tokens: 0,
      worker_cost_usd: 0,
      worker_requests: 0,
      agents: 0,
      prs: 0,
      retries: 0,
      budget_exhausted: 0,
    };
  }
  const plannerTokens =
    (epic.planner_tokens_input ?? 0) +
    (epic.planner_tokens_output ?? 0) +
    (epic.planner_tokens_cached ?? 0);

  // Story retries = N > 1 agents for the same story_id.
  const byStory = new Map<string, number>();
  let workerTokens = 0;
  let workerCost = 0;
  let workerRequests = 0;
  let prs = 0;
  let budgetExhausted = 0;
  for (const a of agents) {
    byStory.set(a.story_id, (byStory.get(a.story_id) ?? 0) + 1);
    workerTokens +=
      (a.tokens_input ?? 0) +
      (a.tokens_output ?? 0) +
      (a.tokens_cached ?? 0) +
      (a.tokens_cache_creation ?? 0);
    workerCost += a.cost_usd ?? 0;
    workerRequests += a.request_count ?? 0;
    if (a.pr_url) prs += 1;
    if (a.status === 'failed' && /budget/i.test(a.log_tail ?? '')) {
      budgetExhausted += 1;
    }
  }
  let retries = 0;
  for (const n of byStory.values()) {
    if (n > 1) retries += n - 1;
  }
  return {
    epic_id: epic.id,
    title: epic.title,
    planner_tokens: plannerTokens,
    planner_requests: epic.planner_request_count ?? 0,
    worker_tokens: workerTokens,
    worker_cost_usd: workerCost,
    worker_requests: workerRequests,
    agents: agents.length,
    prs,
    retries,
    budget_exhausted: budgetExhausted,
  };
}
