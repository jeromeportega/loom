/**
 * GET /api/repos and nested endpoints: per-repo epics, stories, story detail.
 *
 * Owner: story-081-002
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import {
  ProjectRegistry,
  EpicStore,
  AgentStore,
  AuditLog,
  PolicyEngine,
  createDatabase,
  resolveRepoStatePaths,
  deriveBlocked,
  STANDALONE_KIND,
} from '@loom-ai/core';
import type {
  RepoSummary,
  ReposResponse,
  EpicsResponse,
  StoriesResponse,
  AgentDetail,
  AgentSummary,
  EpicStatus,
} from '../../shared/types.js';

export interface RepoDeps {
  db: Database.Database;
  projectRoot: string;
}

const STALL_ACTIONS = ['worker_timeout_warn', 'worker_watchdog_warn'];

function stallReasonFor(audit: AuditLog, agentId: string): string | null {
  const row = audit.latestActionForAgent(agentId, STALL_ACTIONS);
  if (!row) return null;
  if (row.action === 'worker_watchdog_warn') return 'analysis-only';
  try {
    const detail = row.detail ? JSON.parse(row.detail) : {};
    return typeof detail.reason === 'string' ? detail.reason : 'stall';
  } catch {
    return 'stall';
  }
}

function toAgentSummary(
  a: ReturnType<AgentStore['listByEpic']>[number],
  audit: AuditLog
): AgentSummary {
  const tokens =
    a.tokens_input != null ||
    a.tokens_output != null ||
    a.tokens_cached != null ||
    a.tokens_cache_creation != null
      ? (a.tokens_input ?? 0) +
        (a.tokens_output ?? 0) +
        (a.tokens_cached ?? 0) +
        (a.tokens_cache_creation ?? 0)
      : null;
  return {
    id: a.id,
    story_id: a.story_id,
    story_title: a.story_title,
    status: a.status,
    pr_url: a.pr_url,
    started_at: a.started_at,
    updated_at: a.updated_at,
    review_status: a.review_status,
    review_summary: a.review_summary,
    tokens_total: tokens,
    cost_usd: a.cost_usd,
    request_count: a.request_count,
    worktree_path: a.worktree_path,
    branch_name: a.branch_name,
    stall_reason: a.status === 'running' ? stallReasonFor(audit, a.id) : null,
    model: a.model ?? null,
  };
}

function countByStatus(
  agents: ReturnType<AgentStore['listByEpic']>
): EpicStatus['stories'] {
  const counts = { total: agents.length, done: 0, failed: 0, blocked: 0, pending: 0, running: 0 };
  for (const a of agents) {
    if (a.status === 'done' || a.status === 'pr_open') counts.done += 1;
    else if (a.status === 'failed') counts.failed += 1;
    else if (a.status === 'blocked') counts.blocked += 1;
    else if (a.status === 'running') counts.running += 1;
    else counts.pending += 1;
  }
  return counts;
}

export function registerRepoRoutes(app: Express, deps: RepoDeps): void {
  const { projectRoot } = deps;

  /** Returns the first registry entry whose basename matches slug, or null. */
  function resolveEntry(slug: string): { root: string; registeredAt: string } | null {
    return new ProjectRegistry().list().find(e => path.basename(e.root) === slug) ?? null;
  }

  /**
   * Opens the DB for a project root. Returns the current-project DB when root
   * matches projectRoot (no file I/O). Opens a fresh connection for peer
   * projects; caller must close() it in a finally block.
   *
   * Returns null when a registered peer repo has no `.loom` state DB on disk.
   * `createDatabase` mkdirs the directory, creates the file, and runs
   * migrations — a read endpoint that is polled every few seconds must NEVER
   * do that to another repo's disk (matches the `existsSync` guard the
   * `/api/status` and `/api/projects` peer-DB opens already use).
   */
  function openDb(root: string): { db: Database.Database; close: () => void } | null {
    if (root === projectRoot) {
      return { db: deps.db, close: () => {} };
    }
    let policy: { loom_home?: string } = {};
    try {
      policy = PolicyEngine.load(path.join(root, '.loom')).policyData;
    } catch {}
    const { namespaceDir } = resolveRepoStatePaths(root, policy);
    const dbPath = path.join(namespaceDir, 'loom.db');
    if (!fs.existsSync(dbPath)) return null; // uninitialized peer — do not create state
    const pDb = createDatabase(dbPath);
    return { db: pDb, close: () => pDb.close() };
  }

  function countEpics(root: string): number {
    const opened = openDb(root);
    if (!opened) return 0;
    try {
      return new EpicStore(opened.db).list({ includeArchived: true }).length;
    } finally {
      opened.close();
    }
  }

  // GET /api/repos — list all registered repos
  app.get('/api/repos', (_req, res) => {
    const entries = new ProjectRegistry().list();
    const repos: RepoSummary[] = entries.map(entry => ({
      slug: path.basename(entry.root),
      root: entry.root,
      is_current: entry.root === projectRoot,
      epic_count: countEpics(entry.root),
      registered_at: entry.registeredAt,
    }));
    const response: ReposResponse = { repos };
    res.json(response);
  });

  // GET /api/repos/:slug/epics — list epics for a repo
  app.get('/api/repos/:slug/epics', (req, res) => {
    const entry = resolveEntry(req.params.slug);
    if (!entry) {
      res.status(404).json({ error: 'repo not found' });
      return;
    }
    const opened = openDb(entry.root);
    if (!opened) {
      res.status(404).json({ error: 'repo not initialized' });
      return;
    }
    const { db: pDb, close } = opened;
    try {
      const epicStore = new EpicStore(pDb);
      const agentStore = new AgentStore(pDb);
      const allEpics = epicStore.list({ includeArchived: true, includeStandalone: true });
      const allIds = allEpics.map(e => e.id);
      const verdicts = epicStore.getIntakeVerdicts(allIds);
      const isCurrent = entry.root === projectRoot;
      const epics: EpicStatus[] = allEpics.map(epic => ({
        id: epic.id,
        title: epic.title,
        status: epic.status as EpicStatus['status'],
        ...(epic.kind === STANDALONE_KIND ? { kind: 'standalone' as const } : {}),
        planning_phase: (epic.planning_phase ?? null) as EpicStatus['planning_phase'],
        stories: countByStatus(agentStore.listLatestByEpic(epic.id)),
        updated_at: epic.updated_at,
        project_name: path.basename(entry.root),
        project_root: entry.root,
        is_current_project: isCurrent,
        archived: epic.archived_at != null,
        ...(deriveBlocked(epic) ?? {}),
        intake_verdict: verdicts.get(epic.id) ?? null,
      }));
      const response: EpicsResponse = { epics };
      res.json(response);
    } finally {
      close();
    }
  });

  // GET /api/repos/:slug/epics/:epicId/stories — list stories for an epic
  app.get('/api/repos/:slug/epics/:epicId/stories', (req, res) => {
    const entry = resolveEntry(req.params.slug);
    if (!entry) {
      res.status(404).json({ error: 'repo not found' });
      return;
    }
    const opened = openDb(entry.root);
    if (!opened) {
      res.status(404).json({ error: 'repo not initialized' });
      return;
    }
    const { db: pDb, close } = opened;
    try {
      const epicStore = new EpicStore(pDb);
      const epic = epicStore.get(req.params.epicId);
      if (!epic) {
        res.status(404).json({ error: 'epic not found' });
        return;
      }
      const agentStore = new AgentStore(pDb);
      const auditLog = new AuditLog(pDb);
      const agents = agentStore.listLatestByEpic(epic.id);
      const stories: AgentSummary[] = agents.map(a => toAgentSummary(a, auditLog));
      const response: StoriesResponse = { epic_id: epic.id, stories };
      res.json(response);
    } finally {
      close();
    }
  });

  // GET /api/repos/:slug/epics/:epicId/stories/:storyId — single story detail
  app.get('/api/repos/:slug/epics/:epicId/stories/:storyId', (req, res) => {
    const entry = resolveEntry(req.params.slug);
    if (!entry) {
      res.status(404).json({ error: 'repo not found' });
      return;
    }
    const opened = openDb(entry.root);
    if (!opened) {
      res.status(404).json({ error: 'repo not initialized' });
      return;
    }
    const { db: pDb, close } = opened;
    try {
      const epicStore = new EpicStore(pDb);
      const epic = epicStore.get(req.params.epicId);
      if (!epic) {
        res.status(404).json({ error: 'epic not found' });
        return;
      }
      const agentStore = new AgentStore(pDb);
      const auditLog = new AuditLog(pDb);
      // Match by story_id within this epic (latest attempt wins).
      const agents = agentStore.listLatestByEpic(epic.id);
      const agent = agents.find(a => a.story_id === req.params.storyId);
      if (!agent) {
        res.status(404).json({ error: 'story not found' });
        return;
      }
      const detail: AgentDetail = {
        ...toAgentSummary(agent, auditLog),
        epic_id: agent.epic_id,
        worktree_path: agent.worktree_path,
        branch_name: agent.branch_name,
        log_tail: agent.log_tail,
        worker_pid: agent.worker_pid,
      };
      res.json(detail);
    } finally {
      close();
    }
  });
}
