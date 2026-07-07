import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import {
  EpicStore,
  AgentStore,
  AuditLog,
  DecisionTraceStore,
  SkillStore,
  SkillUsageStore,
  ProjectRegistry,
  WorkerLogStore,
  PolicyEngine,
  openDatabase,
  createDatabase,
  resolveRepoStatePaths,
  deriveBlocked,
  STANDALONE_KIND,
  type IntakeVerdict,
} from '@loom-ai/core';
import type {
  EpicStatus,
  AgentSummary,
  EpicDetail,
  AgentDetail,
  CostReport,
  EpicCost,
  SkillManifestSummary,
  SkillHistoryEntry,
  AuditEntry,
  PlanningArtifacts,
} from '../shared/types.js';
import { accessGuard, newToken } from './auth.js';
import { eventStreamHandler } from './events.js';
import { registerAutonomyRoutes } from './routes/autonomy.js';
import { registerFleetRoutes } from './routes/fleet.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerMutationRoutes } from './routes/mutations.js';
import { registerOpportunityRoutes } from './routes/opportunities.js';
import { registerProposeRoutes } from './routes/propose.js';
import { registerLessonRoutes } from './routes/lessons.js';
import { makeResolveProjectDb } from './resolveProjectDb.js';

export interface CreateAppOptions {
  db: Database.Database;
  token: string;
  /** Absolute path to the built React bundle; when set, served at /. */
  staticDir?: string;
  /** Project root — used by SkillStore for discovery. Default: cwd. */
  projectRoot?: string;
  /** SSE poll interval in ms. Default 500. Lower in tests for snappier asserts. */
  ssePollMs?: number;
  /**
   * Command + leading-args tuple the approve handler uses to spawn the
   * loom CLI. The web server appends `['run', epic_id]` to it. Default:
   * `['loom']` (relies on the CLI being on PATH). For in-monorepo dev,
   * `loom web` passes `[process.execPath, '/path/to/dist/index.js']` so
   * approve works without `npm link`.
   */
  loomBin?: readonly string[];
  /**
   * When true, GET/HEAD requests are served without a token; any mutation
   * (non-GET/HEAD) still requires the write token (returns 403 without it).
   * Enabled by LOOM_WEB_READONLY=1 or `loom web --read-only`.
   * Default: false (token required for all /api/* requests).
   */
  readOnly?: boolean;
  /**
   * Test injection — bypasses BriefRefiner LLM call in POST /api/opportunities/:id/scope.
   * Production leaves this undefined; the route loads the LLM from policy.yaml.
   */
  _opportunityBriefRefiner?: { refine(rough: string): Promise<unknown> };
  /** Test injection — bypasses Planner LLM call in POST /api/opportunities/:id/scope. */
  _opportunityPlanner?: { run(brief: string): Promise<{ epicIds: string[] }> };
  /** Test injection — bypasses BriefRefiner LLM call in POST /api/propose. */
  _proposeBriefRefiner?: { refine(rough: string): Promise<unknown> };
  /** Test injection — bypasses Planner LLM call in POST /api/propose. */
  _proposePlanner?: { run(brief: string): Promise<{ epicIds: string[] }> };
}

/**
 * Constructs the Express app for loom-web. Exported as a factory so tests can
 * exercise routes without binding a port — pass a fixture-loaded SQLite
 * database and a known token, then assert against supertest.
 */
export function createApp(opts: CreateAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Health check is the only unauthenticated endpoint. It carries no state
  // and lets the browser fetch / verify the server is up before sending the
  // token. (The token lives in the URL fragment; the page must load to
  // extract it.)
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Single centralized access guard for all /api/* routes.
  // readOnly=false (default): token required on every request (byte-identical
  // to the old requireToken behavior).
  // readOnly=true: GET/HEAD pass tokenless; non-GET/HEAD → 403 without token.
  app.use('/api', accessGuard({ token: opts.token, readOnly: opts.readOnly ?? false }));

  const epicStore = new EpicStore(opts.db);
  const agentStore = new AgentStore(opts.db);
  const auditLog = new AuditLog(opts.db);
  const skillUsage = new SkillUsageStore(opts.db);
  const skillStore = new SkillStore({ projectRoot: opts.projectRoot ?? process.cwd() });
  const decisionTraces = new DecisionTraceStore(opts.db);

  const currentProjectRoot = opts.projectRoot ?? process.cwd();
  const resolveProjectDb = makeResolveProjectDb(opts.db, currentProjectRoot);
  const workerLogs = new WorkerLogStore(path.join(currentProjectRoot, '.loom'));

  // ─── Route modules (owned by sibling stories; mounted here) ─────────────
  registerAutonomyRoutes(app, { epicStore, auditLog });
  registerFleetRoutes(app, { epicStore, agentStore, db: opts.db, projectRoot: currentProjectRoot });
  registerInboxRoutes(app, { epicStore, agentStore, projectRoot: currentProjectRoot });
  registerMutationRoutes(app, {
    db: opts.db,
    resolveProjectDb,
    projectRoot: currentProjectRoot,
    loomBin: opts.loomBin,
  });

  // ─── GET /api/status — federated list of EpicStatus across all repos ─────
  // Aggregates every loom-init'ed repo on this machine, not just the one the
  // web server was launched in. The operator sees everything loom is
  // working on at any time. Each epic carries its project attribution so
  // the detail view + the frontend can route follow-up fetches to the
  // right DB.
  //
  // The opening db (opts.db) is the one the SSE stream still tracks — its
  // epics are the ones that fire live diffs over /api/events. Peer-project
  // epics are visible but their SSE multiplexing is a follow-up (issue
  // #15's deeper slice).
  app.get('/api/status', (req, res) => {
    // Archived runs are hidden by default so the list stays scoped to what
    // the operator cares about; the "show archived" toggle passes
    // ?include_archived=true to surface them (dimmed in the UI).
    const includeArchived = req.query.include_archived === 'true';
    const result: EpicStatus[] = [];
    // First, the current project's DB (the one launched with).
    result.push(
      ...rollupEpics(epicStore, agentStore, currentProjectRoot, true, includeArchived)
    );
    // Then every other registered project.
    const registryEntries = new ProjectRegistry().list();
    for (const entry of registryEntries) {
      if (entry.root === currentProjectRoot) continue;
      try {
        // createDatabase() returns a fresh non-singleton connection — using
        // openDatabase() here would reuse the current-project singleton.
        const peerLoomDir = path.join(entry.root, '.loom');
        const peerPolicy = PolicyEngine.load(peerLoomDir).policyData;
        const { namespaceDir: peerNsDir } = resolveRepoStatePaths(entry.root, peerPolicy);
        const peerDbPath = path.join(peerNsDir, 'loom.db');
        if (!fs.existsSync(peerDbPath)) continue;
        const peerDb = createDatabase(peerDbPath);
        const peerEpicStore = new EpicStore(peerDb);
        const peerAgentStore = new AgentStore(peerDb);
        result.push(
          ...rollupEpics(peerEpicStore, peerAgentStore, entry.root, false, includeArchived)
        );
        peerDb.close();
      } catch {
        // Best-effort: a locked or transient peer DB shouldn't take down
        // the whole status response. Surface the others.
      }
    }
    // Sort by updated_at desc so newest activity surfaces first.
    result.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    res.json({ epics: result, read_only: opts.readOnly ?? false });
  });

  // ─── GET /api/epics/:id — one epic with its full agent list ──────────────
  // Reads from the current project by default; pass ?project=<absolute-path>
  // to route the lookup at one of the federated peer projects (the path
  // matches `project_root` from /api/status).
  app.get('/api/epics/:id', (req, res) => {
    const peer = resolvePeerProject(req.query.project, currentProjectRoot);
    if (peer === 'invalid') {
      res.status(400).json({ error: 'unknown project root' });
      return;
    }
    const [scopedEpics, scopedAgents, scopedRoot, scopedCleanup, scopedAudit] =
      peer === 'current'
        ? ([epicStore, agentStore, currentProjectRoot, () => {}, auditLog] as const)
        : openPeer(peer);
    try {
      const epic = scopedEpics.get(req.params.id);
      if (!epic) {
        res.status(404).json({ error: 'epic not found' });
        return;
      }
      // Collapse retries to the latest attempt per story — same dedup the
      // MCP `loom_get_status` does. `countByStatus` then reflects current
      // story state, not "blocked attempt + done attempt = 2 stories."
      const agents = scopedAgents.listLatestByEpic(epic.id);
      const counts = countByStatus(agents);
      const detail: EpicDetail = {
        id: epic.id,
        title: epic.title,
        status: epic.status,
        ...(epic.kind === STANDALONE_KIND ? { kind: 'standalone' as const } : {}),
        planning_phase: (epic.planning_phase ?? null) as EpicDetail['planning_phase'],
        brief_path: epic.brief_path,
        prd_path: epic.prd_path,
        yaml_path: epic.yaml_path,
        base_sha: epic.base_sha,
        planner_tokens_total: sumPlannerTokens(epic),
        planner_ms: epic.planner_ms,
        user_brief: epic.user_brief,
        stories: counts,
        updated_at: epic.updated_at,
        agents: agents.map((a) => toAgentSummary(a, scopedAudit)),
        project_name: path.basename(scopedRoot),
        project_root: scopedRoot,
        is_current_project: scopedRoot === currentProjectRoot,
        archived: epic.archived_at != null,
        intake_verdict: scopedEpics.getIntakeVerdict(epic.id),
      };
      res.json(detail);
    } finally {
      scopedCleanup();
    }
  });

  // ─── GET /api/epics/:id/planning-artifacts — brief/PRD/architecture/yaml ─
  // Surfaces the four documents the planner produced so the operator can
  // review them in the approval UI instead of having to crack open the repo.
  // Mirrors the loom_get_planning_artifacts MCP tool: paths come from the
  // epic row, bodies are read from disk on demand, missing files surface as
  // null rather than as errors.
  app.get('/api/epics/:id/planning-artifacts', (req, res) => {
    const peer = resolvePeerProject(req.query.project, currentProjectRoot);
    if (peer === 'invalid') {
      res.status(400).json({ error: 'unknown project root' });
      return;
    }
    const [scopedEpics, , scopedRoot, scopedCleanup] =
      peer === 'current'
        ? ([epicStore, agentStore, currentProjectRoot, () => {}] as const)
        : openPeer(peer);
    try {
      const epic = scopedEpics.get(req.params.id);
      if (!epic) {
        res.status(404).json({ error: 'epic not found' });
        return;
      }
      const readMaybe = (rel: string | null): string | null => {
        if (!rel) return null;
        const abs = path.isAbsolute(rel) ? rel : path.join(scopedRoot, rel);
        try {
          return fs.readFileSync(abs, 'utf8');
        } catch {
          return null;
        }
      };
      const architectureRel = epic.brief_path
        ? path.join(path.dirname(epic.brief_path), 'architecture.md')
        : null;
      const payload: PlanningArtifacts = {
        epic_id: epic.id,
        paths: {
          brief: epic.brief_path,
          prd: epic.prd_path,
          epic_yaml: epic.yaml_path,
          architecture: architectureRel,
        },
        brief: readMaybe(epic.brief_path),
        prd: readMaybe(epic.prd_path),
        architecture: readMaybe(architectureRel),
        epic_yaml: readMaybe(epic.yaml_path),
      };
      res.json(payload);
    } finally {
      scopedCleanup();
    }
  });

  // ─── GET /api/agents/:id — single agent with log_tail + worktree info ────
  app.get('/api/agents/:id', (req, res) => {
    const agent = agentStore.get(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'agent not found' });
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
  });

  // ─── GET /api/agents/:id/log — full persisted log with optional from-offset ─
  // Resolves :id → story_id via AgentStore (unknown id → 404; raw param never
  // concatenated into a path). Reads are bounded to agents.log_bytes so a
  // concurrently-appending writer is tolerated. ?from=N returns only bytes
  // after offset N; from === log_bytes yields an empty 200 body.
  app.get('/api/agents/:id/log', (req, res) => {
    const agent = agentStore.get(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const logBytes = agent.log_bytes ?? 0;
    const fromRaw = req.query.from;
    const from =
      typeof fromRaw === 'string' ? Math.max(0, parseInt(fromRaw, 10) || 0) : 0;
    const body = workerLogs.read(agent.story_id, from, logBytes);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Log-Length', String(logBytes));
    res.status(200).send(body);
  });

  // ─── GET /api/agents/:id/audit — audit-log entries for the agent ─────────
  app.get('/api/agents/:id/audit', (req, res) => {
    const agent = agentStore.get(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const limit =
      typeof req.query.limit === 'string'
        ? Math.min(parseInt(req.query.limit, 10) || 50, 500)
        : 50;
    const entries = auditLog.getByAgent(agent.id, limit) as AuditEntry[];
    res.json({ entries });
  });

  // ─── GET /api/skills — discovered skills with their lifecycle + track ────
  app.get('/api/skills', (_req, res) => {
    const skills = skillStore.discover().map((s): SkillManifestSummary => {
      const tr = skillUsage.trackRecord(s.name);
      return {
        name: s.name,
        description: s.description,
        source: s.source,
        ...(s.shareSourceName ? { shareSourceName: s.shareSourceName } : {}),
        lifecycle: s.lifecycle,
        injected: tr.injected,
        succeeded: tr.succeeded,
        failed: tr.failed,
      };
    });
    res.json({ skills });
  });

  // ─── GET /api/skills/:name/history — chronological timeline for one skill
  app.get('/api/skills/:name/history', (req, res) => {
    const name = req.params.name;
    const injections = skillUsage.history(name);
    const auditRows = auditLog.getByCommand(name, [
      'skill_generated',
      'skill_lifecycle_change',
    ]);
    const rows: SkillHistoryEntry[] = [];
    for (const row of auditRows) {
      const detail = parseDetail(row.detail);
      if (row.action === 'skill_generated') {
        rows.push({
          ts: row.timestamp,
          kind: 'generated',
          text: `GENERATED (candidate) from ${String(detail.story_id ?? '?')}`,
        });
      } else {
        rows.push({
          ts: row.timestamp,
          kind: 'lifecycle',
          text: `${String(detail.from ?? '?')} -> ${String(detail.to ?? '?')}${
            detail.reason ? `  (${String(detail.reason)})` : ''
          }`,
        });
      }
    }
    for (const inj of injections) {
      rows.push({
        ts: inj.injectedAt,
        kind: 'injected',
        text: `injected into ${inj.storyId}  [${inj.outcome ?? 'in-flight'}]`,
      });
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    res.json({ rows });
  });

  // ─── GET /api/cost — token usage + cost across epics + totals ────────────
  // ─── GET /api/projects — every loom-init'ed repo on this machine ────────
  // First slice of multi-repo support (#15). Lists each registered project
  // with a best-effort snapshot of its latest epic. Each project remains
  // its own loom web; this endpoint is the directory for "where am I
  // running loom?" The full SSE federation lands as a follow-up.
  app.get('/api/projects', (_req, res) => {
    const entries = new ProjectRegistry().list();
    const projects = entries.map((entry) => {
      const projectName = path.basename(entry.root);
      const isCurrent = entry.root === (opts.projectRoot ?? process.cwd());
      let latestEpic: { id: string; title: string; status: string } | undefined;
      let epicCount = 0;
      // Best-effort read of the project's own loom.db. A missing or locked
      // DB just yields undefined snapshot — the registry entry is still
      // useful even when the project is mid-run with the DB busy.
      try {
        const peerLoomDir = path.join(entry.root, '.loom');
        const peerPolicy = PolicyEngine.load(peerLoomDir).policyData;
        const { namespaceDir: peerNamespaceDir } = resolveRepoStatePaths(entry.root, peerPolicy);
        const peerDbPath = path.join(peerNamespaceDir, 'loom.db');
        if (fs.existsSync(peerDbPath)) {
          const peerDb = createDatabase(peerDbPath);
          try {
            // Count every epic (including archived) — the directory count is a
            // "how much has this project done" signal, not a working set.
            const peerEpics = new EpicStore(peerDb).list({ includeArchived: true });
            epicCount = peerEpics.length;
            const last = peerEpics[peerEpics.length - 1];
            if (last) {
              latestEpic = { id: last.id, title: last.title, status: last.status };
            }
          } finally {
            peerDb.close();
          }
        }
      } catch {
        // Best-effort — registry entry stays useful without the snapshot.
      }
      return {
        name: projectName,
        root: entry.root,
        registered_at: entry.registeredAt,
        is_current: isCurrent,
        epic_count: epicCount,
        latest_epic: latestEpic,
      };
    });
    res.json({ projects });
  });

  app.get('/api/cost', (_req, res) => {
    // Cost is a spend roll-up — archiving a run doesn't un-spend its tokens,
    // so the report counts everything.
    const epics = epicStore.list({ includeArchived: true });
    const report: CostReport = {
      epics: [],
      totals: {
        planner_tokens: 0,
        planner_requests: 0,
        worker_tokens: 0,
        worker_cost_usd: 0,
        worker_requests: 0,
        prs: 0,
      },
    };
    for (const epic of epics) {
      const agents = agentStore.listByEpic(epic.id);
      const epicCost = aggregateEpicCost(epic, agents);
      report.epics.push(epicCost);
      report.totals.planner_tokens += epicCost.planner_tokens;
      report.totals.planner_requests += epicCost.planner_requests;
      report.totals.worker_tokens += epicCost.worker_tokens;
      report.totals.worker_cost_usd += epicCost.worker_cost_usd;
      report.totals.worker_requests += epicCost.worker_requests;
      report.totals.prs += epicCost.prs;
    }
    res.json(report);
  });

  // ─── GET /api/agents/:id/traces — reasoning replay for one agent ────────
  app.get('/api/agents/:id/traces', (req, res) => {
    const agent = agentStore.get(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const limit =
      typeof req.query.limit === 'string'
        ? Math.min(parseInt(req.query.limit, 10) || 200, 1000)
        : 200;
    res.json({ traces: decisionTraces.getByAgent(agent.id, limit) });
  });

  // ─── GET /api/epics/:id/traces — whole-epic reasoning timeline ──────────
  app.get('/api/epics/:id/traces', (req, res) => {
    const epic = epicStore.get(req.params.id);
    if (!epic) {
      res.status(404).json({ error: 'epic not found' });
      return;
    }
    res.json({ traces: decisionTraces.getByEpic(epic.id) });
  });

  // ─── POST /api/epics/:id/archive — hide a run from the default views ─────
  // Non-destructive: flips epics.archived_at, audit-logs, and (because
  // list() excludes archived by default) the epic drops out of /api/status
  // and supervisor selection. Pass ?project=<root> to act on a federated peer
  // epic; the body's `archived` flag toggles (default true = archive).
  app.post('/api/epics/:id/archive', (req, res) => {
    const peer = resolvePeerProject(req.query.project, currentProjectRoot);
    if (peer === 'invalid') {
      res.status(400).json({ error: 'unknown project root' });
      return;
    }
    const [scopedEpics, , , scopedCleanup, scopedAudit] =
      peer === 'current'
        ? ([epicStore, agentStore, currentProjectRoot, () => {}, auditLog] as const)
        : openPeer(peer);
    try {
      const epic = scopedEpics.get(req.params.id);
      if (!epic) {
        res.status(404).json({ error: 'epic not found' });
        return;
      }
      const archive = req.body?.archived !== false; // default true
      const alreadyArchived = epic.archived_at != null;
      if (archive !== alreadyArchived) {
        if (archive) scopedEpics.archive(epic.id);
        else scopedEpics.unarchive(epic.id);
        scopedAudit.record({
          action: archive ? 'epic_archived' : 'epic_unarchived',
          command: epic.id,
        });
      }
      res.json({ status: archive ? 'archived' : 'unarchived', epic_id: epic.id, archived: archive });
    } finally {
      scopedCleanup();
    }
  });

  // ─── propose route (story-005-006) — POST /api/propose ──────────────────
  registerProposeRoutes(app, {
    db: opts.db,
    projectRoot: currentProjectRoot,
    _refiner: opts._proposeBriefRefiner as Parameters<typeof registerProposeRoutes>[1]['_refiner'],
    _planner: opts._proposePlanner,
  });

  // ─── lesson routes (story-005-007) — GET /api/lessons ──────────────────────
  registerLessonRoutes(app, { db: opts.db });

  // ─── opportunity routes (story-004-006) mount below ───
  registerOpportunityRoutes(app, {
    db: opts.db,
    resolveProjectDb,
    projectRoot: currentProjectRoot,
    loomBin: opts.loomBin,
    _briefRefiner: opts._opportunityBriefRefiner,
    _planner: opts._opportunityPlanner,
  });

  // ─── GET /api/events — Server-Sent Events stream of live state diffs ────
  // Epic / agent status changes + appended log_tail bytes flow here. The
  // browser opens an EventSource; the server polls the DB every ~500ms and
  // emits diffs. Heartbeat every 15s.
  app.get('/api/events', eventStreamHandler({
    db: opts.db,
    pollMs: opts.ssePollMs,
    loomdir: path.join(currentProjectRoot, '.loom'),
  }));

  // ─── Static frontend (built React) ───────────────────────────────────────
  // Default to the Vite SPA output directory when no override is provided.
  // The check gates on file existence so the dev workflow (Vite dev server
  // proxying /api to Express) is unaffected when client-dist hasn't been built.
  const defaultStaticDir = path.join(__dirname, '../../client-dist');
  const resolvedStaticDir = opts.staticDir ?? (fs.existsSync(defaultStaticDir) ? defaultStaticDir : undefined);
  if (resolvedStaticDir) {
    app.use(express.static(resolvedStaticDir));
    // SPA fallback for client-side routing.
    app.get(/^(?!\/api\/).+/, (_req, res) => {
      res.sendFile('index.html', { root: resolvedStaticDir! });
    });
  }

  return app;
}

/**
 * Maps a project's EpicStore + AgentStore rows to EpicStatus[] tagged with
 * the project attribution. Shared by the current-project pass and every
 * federated peer pass in /api/status.
 *
 * Standalone stories (kind='standalone') are emitted with their stored id
 * verbatim (story-NNN). Normal epics are returned unchanged.
 */
function rollupEpics(
  epicStore: EpicStore,
  agentStore: AgentStore,
  projectRoot: string,
  isCurrent: boolean,
  includeArchived = false
): EpicStatus[] {
  const allRows = epicStore.list({ includeArchived, includeStandalone: true });
  const allIds = allRows.map((e) => e.id);
  const verdicts = epicStore.getIntakeVerdicts(allIds);
  const result: EpicStatus[] = [];

  for (const epic of allRows) {
    result.push({
      id: epic.id,
      title: epic.title,
      status: epic.status as EpicStatus['status'],
      ...(epic.kind === STANDALONE_KIND ? { kind: 'standalone' as const } : {}),
      planning_phase: (epic.planning_phase ?? null) as EpicStatus['planning_phase'],
      // Per-story dedup so the list-view counts match the detail view: a
      // retried-blocked-now-done story counts as 1 done, not 1 blocked + 1 done.
      stories: countByStatus(agentStore.listLatestByEpic(epic.id)),
      updated_at: epic.updated_at,
      project_name: path.basename(projectRoot),
      project_root: projectRoot,
      is_current_project: isCurrent,
      archived: epic.archived_at != null,
      ...(deriveBlocked(epic) ?? {}),
      intake_verdict: verdicts.get(epic.id) ?? null,
    });
  }

  return result;
}

/**
 * Validates a `?project=<root>` query param against ProjectRegistry.
 *
 * Returns:
 *   - 'current'  — no project param OR it equals the current project root
 *   - 'invalid'  — the param refers to a project that is not registered
 *   - string     — an absolute path to a registered peer project
 *
 * Validation is essential: a request handler that opens an arbitrary
 * caller-controlled path with `openDatabase()` would be a directory-
 * traversal vector. Only paths that ProjectRegistry vouches for resolve.
 */
function resolvePeerProject(
  raw: unknown,
  currentRoot: string
): 'current' | 'invalid' | string {
  if (typeof raw !== 'string' || raw.length === 0) return 'current';
  if (raw === currentRoot) return 'current';
  const known = new ProjectRegistry().list().map((e) => e.root);
  if (!known.includes(raw)) return 'invalid';
  return raw;
}

/**
 * Opens a peer project's DB for the duration of one request. Returns the
 * stores tied to it plus a cleanup function the caller MUST invoke in a
 * `finally` block. Throws are caught by the caller's normal error path.
 */
function openPeer(
  root: string
): readonly [EpicStore, AgentStore, string, () => void, AuditLog] {
  // createDatabase() — fresh connection, NOT the openDatabase() singleton.
  // The singleton would alias the current-project DB and close-on-cleanup
  // would tear down the long-lived connection the rest of the server uses.
  const peerLoomDir = path.join(root, '.loom');
  let peerPolicy: { loom_home?: string };
  try {
    peerPolicy = PolicyEngine.load(peerLoomDir).policyData;
  } catch {
    // Absent or malformed policy.yaml — fall back to default loom_home so the
    // peer DB can still be opened. Matches the degraded behaviour of crossEpicOverlap.
    peerPolicy = { loom_home: '' };
  }
  const { namespaceDir: peerNsDir } = resolveRepoStatePaths(root, peerPolicy);
  const peerDb = createDatabase(path.join(peerNsDir, 'loom.db'));
  const peerEpics = new EpicStore(peerDb);
  const peerAgents = new AgentStore(peerDb);
  const peerAudit = new AuditLog(peerDb);
  return [peerEpics, peerAgents, root, () => peerDb.close(), peerAudit] as const;
}

function countByStatus(
  agents: ReturnType<AgentStore['listByEpic']>
): EpicStatus['stories'] {
  const counts = {
    total: agents.length,
    done: 0,
    failed: 0,
    blocked: 0,
    pending: 0,
    running: 0,
  };
  for (const a of agents) {
    if (a.status === 'done' || a.status === 'pr_open') counts.done += 1;
    else if (a.status === 'failed') counts.failed += 1;
    else if (a.status === 'blocked') counts.blocked += 1;
    else if (a.status === 'running') counts.running += 1;
    else counts.pending += 1;
  }
  return counts;
}

function sumPlannerTokens(
  epic: ReturnType<EpicStore['get']>
): number | null {
  if (!epic) return null;
  const parts = [
    epic.planner_tokens_input,
    epic.planner_tokens_output,
    epic.planner_tokens_cached,
  ];
  if (parts.every((p) => p == null)) return null;
  return parts.reduce<number>((acc, p) => acc + (p ?? 0), 0);
}

/** Audit actions that mark a worker as approaching/hitting a deadline. */
const STALL_ACTIONS = ['worker_timeout_warn', 'worker_watchdog_warn'];

/** Stall reason for a running story from its latest timeout/watchdog warning. */
function stallReasonFor(audit: AuditLog | undefined, agentId: string): string | null {
  if (!audit) return null;
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
  audit?: AuditLog
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

function aggregateEpicCost(
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

  // Story retries = N >1 agents for the same story_id.
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

function parseDetail(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export { newToken } from './auth.js';
