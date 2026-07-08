/**
 * GET /api/inbox — cross-project decision inbox.
 *
 * Federates every pending decision across all registered projects. Each entry
 * carries enough context to act on it from the fleet view using the existing
 * mutation endpoints (approve/reject/resume/stop/kill) with ?project=<root>.
 *
 * Three decision sources per project:
 *   plan_approval     — epics in status='planned' awaiting human approval
 *   checkpoint_resume — epics with paused_at IS NOT NULL (post-checkpoint pause)
 *   escalation        — blocked stories (listLatestByEpic where status='blocked')
 *
 * Trade-off: each inbox load opens N project DBs synchronously — acceptable
 * at operator scale; no caching added per ADR guidance.
 *
 * Owner: story-003-004
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import { EpicStore, AgentStore, ProjectRegistry, PolicyEngine, createDatabase, resolveRepoStatePaths } from '@loom-ai/core';
import type { ProjectEntry } from '@loom-ai/core';
import type { InboxEntry } from '../../shared/inbox.js';

export interface InboxDeps {
  epicStore: EpicStore;
  agentStore: AgentStore;
  /** Absolute path of the project the web server was launched in. Default: cwd. */
  projectRoot?: string;
  /** Unified active + machine-default registry; falls back to ProjectRegistry.list(). */
  unifiedRegistry?: Map<string, ProjectEntry>;
  // All other RouteDeps fields are accepted but unused (structural subtype).
  [key: string]: unknown;
}

export function registerInboxRoutes(app: Express, deps: InboxDeps): void {
  const currentProjectRoot = deps.projectRoot ?? process.cwd();

  app.get('/api/inbox', (_req, res) => {
    const entries: InboxEntry[] = [];
    const now = Date.now();

    // Current project first — same ordering convention as /api/status.
    collectEntries(deps.epicStore, deps.agentStore, currentProjectRoot, now, entries);

    // Peer projects — best-effort federation, same pattern as /api/status.
    const registryEntries = deps.unifiedRegistry ? [...deps.unifiedRegistry.values()] : new ProjectRegistry().list();
    for (const entry of registryEntries) {
      if (entry.root === currentProjectRoot) continue;
      const peerLoomDir = path.join(entry.root, '.loom');
      let peerPolicy: { loom_home?: string };
      try {
        peerPolicy = PolicyEngine.load(peerLoomDir).policyData;
      } catch {
        // policy.yaml absent or malformed — mirror fleet.ts: fall back to default
        // resolver rather than silently dropping the project from the inbox.
        peerPolicy = { loom_home: '' };
      }
      const { namespaceDir: peerNsDir } = resolveRepoStatePaths(entry.root, { loom_home: peerPolicy.loom_home ?? '' });
      const dbPath = path.join(peerNsDir, 'loom.db');
      if (!fs.existsSync(dbPath)) continue;
      try {
        const peerDb = createDatabase(dbPath);
        const peerEpicStore = new EpicStore(peerDb);
        const peerAgentStore = new AgentStore(peerDb);
        collectEntries(peerEpicStore, peerAgentStore, entry.root, now, entries);
        peerDb.close();
      } catch {
        // Best-effort: a locked or transient peer DB must not crash the inbox.
      }
    }

    res.json(entries);
  });
}

/**
 * Collects all pending decision entries from one project into `out`.
 * Visits planned epics, paused epics, and blocked latest agents.
 * NO cross-epic accumulator — per-epic queries only.
 */
function collectEntries(
  epicStore: EpicStore,
  agentStore: AgentStore,
  projectRoot: string,
  now: number,
  out: InboxEntry[]
): void {
  const project = path.basename(projectRoot);

  // plan_approval — epics in 'planned' status awaiting human sign-off
  for (const epic of epicStore.listByStatus('planned')) {
    out.push({
      type: 'plan_approval',
      project_root: projectRoot,
      project,
      epic_id: epic.id,
      title: epic.title,
      story_id: null,
      age_ms: ageMs(now, epic.updated_at),
    });
  }

  // checkpoint_resume — paused epics (autonomy_level='checkpoint' after a story)
  // Access paused_at via a typed cast; pre-v16 rows have null here by column default.
  for (const epic of epicStore.list()) {
    const row = epic as typeof epic & {
      paused_at?: string | null;
      paused_after_story?: string | null;
    };
    if (row.paused_at == null) continue;
    out.push({
      type: 'checkpoint_resume',
      project_root: projectRoot,
      project,
      epic_id: epic.id,
      title: epic.title,
      story_id: row.paused_after_story ?? null,
      age_ms: ageMs(now, row.paused_at),
    });
  }

  // escalation — stories where the latest agent attempt is 'blocked'
  for (const epic of epicStore.list()) {
    const agents = agentStore.listLatestByEpic(epic.id);
    for (const agent of agents) {
      if (agent.status !== 'blocked') continue;
      out.push({
        type: 'escalation',
        project_root: projectRoot,
        project,
        epic_id: epic.id,
        title: epic.title,
        story_id: agent.story_id,
        age_ms: ageMs(now, agent.updated_at),
      });
    }
  }
}

/**
 * Returns elapsed milliseconds since a stored timestamp.
 *
 * SQLite's CURRENT_TIMESTAMP yields `YYYY-MM-DD HH:MM:SS` (UTC, no suffix).
 * JS Date.parse treats strings without timezone as LOCAL time, which produces
 * wrong results. We normalise by appending 'Z' when the string has no
 * timezone marker — the two timestamp formats in loom DBs are:
 *   - ISO 8601 from new Date().toISOString(): `2024-01-01T12:00:00.000Z` (has Z)
 *   - CURRENT_TIMESTAMP:                      `2024-01-01 12:00:00`       (no Z)
 */
function ageMs(now: number, ts: string): number {
  const normalised = /[TZ+]/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(normalised);
  return isNaN(parsed) ? 0 : Math.max(0, now - parsed);
}
