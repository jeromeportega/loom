import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  createDatabase,
  EpicStore,
  AgentStore,
  AuditLog,
  LandingStore,
  RecoveryStore,
  landingReport,
  ProjectRegistry,
  PolicyEngine,
  resolveLoomHomePath,
  prepareRepoState,
  deriveBlocked,
  displayModel,
  STANDALONE_KIND,
  type IntakeVerdict,
  type EpicRecord,
  type LandingReport,
  type Policy,
} from '@loom-ai/core';

type SpawnSyncFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; encoding: 'utf8' }
) => { stdout: string; status: number | null };

const _realSpawnSync: SpawnSyncFn = (cmd, args, opts) => {
  const r = nodeSpawnSync(cmd, args, { ...opts });
  return { stdout: r.stdout as string, status: r.status };
};

/**
 * Resolves the canonical DB path for a loom project directory (story-053).
 * Calls prepareRepoState so the one-time migration runs before any read,
 * ensuring status and JSON output always see the migrated loom-home state.
 */
function resolveDbPath(loomDir: string): string {
  const projectRoot = path.dirname(loomDir);
  let policy: { loom_home?: string } = {};
  try {
    policy = PolicyEngine.load(loomDir).policyData;
  } catch { /* tolerate missing/malformed policy */ }
  return prepareRepoState(projectRoot, policy).dbPath;
}

/** Audit actions that mark a worker as approaching/hitting a deadline. */
const STALL_ACTIONS = ['worker_timeout_warn', 'worker_watchdog_warn'];

const STATUS_ICONS: Record<string, string> = {
  pending: '⏳',
  running: '🔄',
  blocked: '🚫',
  pr_open: '🔀',
  done: '✅',
  failed: '❌',
  planning: '📝',
  planned: '📋',
  approved: '✔️ ',
  rejected: '✗ ',
  in_progress: '🔄',
  finalizing: '🚀',
  publish_pending: '📦',
  // Landing attempt statuses (cross-repo)
  staging: '⏳',
  merging: '🔀',
  landed: '✅',
  rolling_back: '⏮️',
  rolled_back: '↩️',
};

const PUBLISH_PENDING_LABEL = 'work complete · publish pending';

/**
 * The live phase suffix for an epic, mirroring the ADR-1 symmetry between the
 * planning and finalize overlays: `planning` surfaces `planning_phase`,
 * `finalizing` surfaces `finalize_phase`. Returns '' for any other status so a
 * planning epic never leaks a finalize phase and vice versa. Replaces the
 * opaque bare `(planning…)` placeholder title with the active phase.
 */
function epicPhaseSuffix(epic: {
  status: string;
  planning_phase?: string | null;
  finalize_phase?: string | null;
}): string {
  if (epic.status === 'planning' && epic.planning_phase) {
    return ` (${epic.planning_phase})`;
  }
  if (epic.status === 'finalizing' && epic.finalize_phase) {
    return ` (${epic.finalize_phase})`;
  }
  return '';
}

export interface StatusOptions {
  watch?: boolean;
  epicId?: string;
  /** Aggregate across every registered loom project, not just the cwd. */
  all?: boolean;
  /** Include archived runs in the listing (hidden by default). */
  archived?: boolean;
  /** Emit a machine-readable JSON payload instead of the human tree. */
  json?: boolean;
  /** Target the named registered project (absolute path). */
  project?: string;
  /** Override the project root (defaults to process.cwd()). Avoids process.chdir() in tests. */
  projectRoot?: string;
  /** Injectable spawnSync for testing. Defaults to the real spawnSync. */
  _spawnSync?: SpawnSyncFn;
}

export function runStatus(options: StatusOptions): void {
  if (options.project && options.all) {
    console.error('--project and --all are mutually exclusive');
    process.exitCode = 1;
    return;
  }

  // Validate --project once here so both the --json path and render() share the same check
  // and buildJsonStatus stays side-effect-free.
  let projectLoomDir: string | undefined;
  if (options.project) {
    const resolved = path.resolve(options.project);
    const entry = new ProjectRegistry().list().find((p) => p.root === resolved);
    if (!entry) {
      console.error(`Project not registered: ${resolved}`);
      process.exitCode = 1;
      return;
    }
    projectLoomDir = path.join(resolved, '.loom');
  }

  if (options.json) {
    const status = buildJsonStatus(options, projectLoomDir);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  function render(): void {
    const spawnFn = options._spawnSync ?? _realSpawnSync;
    if (projectLoomDir) {
      const resolved = path.resolve(options.project!);
      console.log(`\n━━ ${path.basename(resolved)}  (${resolved})`);
      renderLoomDir(projectLoomDir, options.epicId, options.archived, spawnFn);
      console.log('');
      return;
    }
    if (options.all) {
      const projects = new ProjectRegistry().list();
      if (projects.length === 0) {
        console.log('\nNo loom projects registered yet. Run `loom init` in a repo.\n');
        return;
      }
      for (const project of projects) {
        console.log(`\n━━ ${path.basename(project.root)}  (${project.root})`);
        renderLoomDir(path.join(project.root, '.loom'), options.epicId, options.archived, spawnFn);
      }
      console.log('');
      return;
    }
    const cwd = options.projectRoot ?? process.cwd();
    const loomDir = path.join(cwd, '.loom');
    let policy: { loom_home?: string } = {};
    try {
      policy = PolicyEngine.load(loomDir).policyData;
    } catch {
      // tolerate missing/malformed policy — render with default heuristic
    }
    const loomHomePath = resolveLoomHomePath(cwd, policy);
    const existsNote = fs.existsSync(loomHomePath) ? '' : ' (will be created on first use)';
    console.log(`   loom-home: ${loomHomePath}${existsNote}`);
    renderLoomDir(loomDir, options.epicId, options.archived, spawnFn);
    console.log('');
  }

  render();

  if (options.watch) {
    const interval = setInterval(() => {
      console.clear();
      render();
      if (process.exitCode) {
        clearInterval(interval);
        return;
      }
      if (allTerminal(options)) {
        clearInterval(interval);
        console.log('All stories reached terminal status. Exiting watch.');
        process.exit(0);
      }
    }, 10_000);

    process.on('SIGINT', () => {
      clearInterval(interval);
      process.exit(0);
    });
  }
}

/** One collapsed story row in the `--json` payload: exactly one entry per
 *  story_id, with older retry attempts gathered into `history[]`. */
interface JsonStory {
  id: string;
  title: string;
  status: string;
  pr_url?: string;
  started_at?: string;
  branch_name?: string;
  /** Earlier attempts (newest first), excluding the current row. Present only
   *  when the story was retried — closes the duplicate blocked+done leak by
   *  surfacing the old attempt HERE rather than as a second top-level row. */
  history?: { id: string; status: string; updated_at: string }[];
  /** Number of auto-recoveries for this story. Omitted when 0. */
  recovery_count?: number;
}

interface JsonEpic {
  id: string;
  title: string;
  status: string;
  /** 'standalone' when this entry represents a standalone story, not a full epic. */
  kind?: 'standalone';
  archived?: boolean;
  blocked?: true;
  blocked_reason?: 'integration_gate';
  intake_verdict: IntakeVerdict | null;
  integration_lag?: {
    commits_behind: number;
    threshold:      number;
    warn:           boolean;
  };
  stale_planning?: {
    idle_minutes:      number;
    threshold_minutes: number;
    warn:              boolean;
  };
  stories: JsonStory[];
}

interface JsonStatus {
  epics: JsonEpic[];
  loom_home?: string; // omitted in --all mode
}

/**
 * Machine-readable status, scoped like the human view (current project, or
 * every registered project with `--all`). Retry attempts are collapsed via
 * `listLatestByEpic` + `listHistoryByStory` — the SAME collapse the MCP
 * `loom_get_status` payload uses — so `--json` yields exactly one row per
 * story (old attempts in `history[]`), never a duplicate blocked+done pair.
 */
function buildJsonStatus(options: StatusOptions, projectLoomDir?: string): JsonStatus {
  let loomDirs: string[];
  if (projectLoomDir) {
    loomDirs = [projectLoomDir];
  } else {
    loomDirs = options.all
      ? new ProjectRegistry().list().map((p) => path.join(p.root, '.loom'))
      : [path.join(options.projectRoot ?? process.cwd(), '.loom')];
  }

  const epics: JsonEpic[] = [];
  const spawnFn = options._spawnSync ?? _realSpawnSync;
  for (const loomDir of loomDirs) {
    epics.push(...collectJsonEpics(loomDir, options.epicId, options.archived, spawnFn));
  }

  // Include resolved loom-home only for a single-project view (not --all).
  if (!options.all) {
    const loomDir = projectLoomDir ?? path.join(options.projectRoot ?? process.cwd(), '.loom');
    const projectRoot = path.dirname(loomDir);
    let policy: { loom_home?: string } = {};
    try {
      policy = PolicyEngine.load(loomDir).policyData;
    } catch {
      // tolerate missing/malformed policy — use default heuristic
    }
    const loomHome = resolveLoomHomePath(projectRoot, policy);
    return { epics, loom_home: loomHome };
  }
  return { epics };
}

function computeIntegrationLag(
  epicId: string,
  threshold: number,
  repoRoot: string,
  spawnFn: SpawnSyncFn
): { commits_behind: number; threshold: number; warn: boolean } {
  const result = spawnFn('git', ['rev-list', '--count', `epic/${epicId}..main`], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return { commits_behind: 0, threshold, warn: false };
  const count = parseInt(result.stdout.trim(), 10);
  if (isNaN(count)) return { commits_behind: 0, threshold, warn: false };
  return { commits_behind: count, threshold, warn: count >= threshold };
}

function computeStalePlanning(
  updatedAt: string,
  thresholdMinutes: number
): { idle_minutes: number; threshold_minutes: number; warn: boolean } {
  const idleMs = Date.now() - new Date(updatedAt).getTime();
  return {
    idle_minutes: Math.round(idleMs / 60000),
    threshold_minutes: thresholdMinutes,
    warn: idleMs / 60000 >= thresholdMinutes,
  };
}

function loadPolicy(loomDir: string): Policy {
  try {
    return PolicyEngine.load(loomDir).policyData;
  } catch {
    return PolicyEngine.defaultPolicy();
  }
}

function collectJsonEpics(
  loomDir: string,
  epicId?: string,
  includeArchived?: boolean,
  spawnFn: SpawnSyncFn = _realSpawnSync,
): JsonEpic[] {
  const dbPath = resolveDbPath(loomDir);
  if (!fs.existsSync(dbPath)) return [];
  const db = createDatabase(dbPath);
  const policy = loadPolicy(loomDir);
  const repoRoot = path.dirname(loomDir);
  const integrationBranch = policy.agents.integration_branch;
  const lagThreshold = policy.agents.integration_branch_lag_threshold;
  const stalePlanningMinutes = policy.agents.stale_planning_minutes;
  try {
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    const recoveryStore = new RecoveryStore(db);
    const allRows = epicId
      ? [epicStore.get(epicId)].filter(Boolean)
      : epicStore.list({ includeArchived, includeStandalone: true });

    const validRows = allRows.filter(Boolean) as EpicRecord[];
    const verdicts = epicStore.getIntakeVerdicts(validRows.map((e) => e.id));
    const out: JsonEpic[] = [];
    for (const epic of validRows) {
      const latest = agentStore.listLatestByEpic(epic.id);

      if (epic.kind === STANDALONE_KIND) {
        // Standalone story — surface the story id as the top-level id, never
        // the internal container epic id. If no agent exists yet (pre-dispatch),
        // emit a minimal entry using the container status.
        if (latest.length === 0) {
          out.push({
            id: epic.id,
            title: epic.title,
            status: epic.status,
            kind: 'standalone',
            ...(epic.archived_at ? { archived: true } : {}),
            intake_verdict: verdicts.get(epic.id) ?? null,
            stories: [],
          });
          continue;
        }
        const a = latest[0]; // standalone always has exactly one story
        const history = agentStore
          .listHistoryByStory(a.story_id)
          .filter((h) => h.id !== a.id);
        const recoveryCount = recoveryStore.getRecoveryCount(a.story_id);
        const story: JsonStory = {
          id: a.story_id,
          title: a.story_title ?? a.story_id,
          status: a.status,
          ...(a.pr_url ? { pr_url: a.pr_url } : {}),
          ...(a.started_at ? { started_at: a.started_at } : {}),
          ...(a.branch_name ? { branch_name: a.branch_name } : {}),
          ...(history.length > 0
            ? {
                history: history.map((h) => ({
                  id: h.id,
                  status: h.status,
                  updated_at: h.updated_at,
                })),
              }
            : {}),
          ...(recoveryCount > 0 ? { recovery_count: recoveryCount } : {}),
        };
        out.push({
          id: a.story_id,
          title: a.story_title ?? epic.title,
          status: a.status,
          kind: 'standalone',
          ...(epic.archived_at ? { archived: true } : {}),
          intake_verdict: verdicts.get(epic.id) ?? null,
          stories: [story],
        });
        continue;
      }

      // Normal epic — one row per story_id, collapse retries.
      const stories: JsonStory[] = latest.map((a) => {
        const history = agentStore
          .listHistoryByStory(a.story_id)
          .filter((h) => h.id !== a.id);
        const recoveryCount = recoveryStore.getRecoveryCount(a.story_id);
        return {
          id: a.story_id,
          title: a.story_title ?? a.story_id,
          status: a.status,
          ...(a.pr_url ? { pr_url: a.pr_url } : {}),
          ...(a.started_at ? { started_at: a.started_at } : {}),
          ...(a.branch_name ? { branch_name: a.branch_name } : {}),
          ...(history.length > 0
            ? {
                history: history.map((h) => ({
                  id: h.id,
                  status: h.status,
                  updated_at: h.updated_at,
                })),
              }
            : {}),
          ...(recoveryCount > 0 ? { recovery_count: recoveryCount } : {}),
        };
      });
      const integrationLag =
        integrationBranch === 'rolling' && !epic.archived_at
          ? computeIntegrationLag(epic.id, lagThreshold, repoRoot, spawnFn)
          : undefined;
      const stalePlanning =
        epic.status === 'planning'
          ? computeStalePlanning(epic.updated_at, stalePlanningMinutes)
          : undefined;
      out.push({
        id: epic.id,
        title: epic.title,
        status: epic.status,
        ...(epic.archived_at ? { archived: true } : {}),
        ...(deriveBlocked(epic) ?? {}),
        intake_verdict: verdicts.get(epic.id) ?? null,
        ...(integrationLag != null ? { integration_lag: integrationLag } : {}),
        ...(stalePlanning != null ? { stale_planning: stalePlanning } : {}),
        stories,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Renders a landing report section under an epic when an attempt exists. */
function renderLandingReport(report: LandingReport): void {
  const icon = STATUS_ICONS[report.status] ?? '?';
  console.log(`      ${icon} Landing ${report.attemptId}  [${report.status}]`);

  if (report.status === 'blocked' && report.blocker) {
    const b = report.blocker;
    console.log(`           blocked: ${b.check} on '${b.repoSlug}'`);
    console.log(`           reason: ${b.reason}`);
    console.log(`           retry: open a new landing attempt with new PRs (reverted PRs do not reopen — ADR-006)`);
  }

  if (report.status === 'rolling_back') {
    const reverting = report.repos.filter((r) => r.mergeState === 'revert_pending');
    const awaitingRevert = report.repos.filter((r) => r.mergeState === 'merged');
    if (reverting.length > 0) {
      console.log(`           reverting: ${reverting.map((r) => r.repoSlug).join(', ')}`);
    }
    if (awaitingRevert.length > 0) {
      console.log(`           awaiting revert: ${awaitingRevert.map((r) => r.repoSlug).join(', ')}`);
    }
  }

  if (report.status === 'rolled_back') {
    if (report.blocker) {
      const b = report.blocker;
      console.log(`           failure: ${b.check} on '${b.repoSlug}' — ${b.reason}`);
    }
    const repoLines = report.repos.map((r) => `${r.repoSlug}:${r.mergeState}`).join(', ');
    console.log(`           repos: ${repoLines}`);
    const cleanTag = report.cleanState ? 'yes — all repos at pre-landing state' : 'no — manual inspection required';
    console.log(`           clean state: ${cleanTag}`);
    console.log(`           retry: create a new landing attempt with new PRs (reverted PRs do not reopen — ADR-006)`);
  }
}

/** Renders one loom project's epic/agent tree. */
function renderLoomDir(
  loomDir: string,
  epicId?: string,
  includeArchived?: boolean,
  spawnFn: SpawnSyncFn = _realSpawnSync,
): void {
  const dbPath = resolveDbPath(loomDir);
  if (!fs.existsSync(dbPath)) {
    console.log('   Not yet planned — run `loom epic "<brief>"` here.');
    return;
  }
  const db = createDatabase(dbPath);
  const policy = loadPolicy(loomDir);
  const repoRoot = path.dirname(loomDir);
  const integrationBranch = policy.agents.integration_branch;
  const lagThreshold = policy.agents.integration_branch_lag_threshold;
  const stalePlanningMinutes = policy.agents.stale_planning_minutes;
  try {
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    const auditStore = new AuditLog(db);
    const recoveryStore = new RecoveryStore(db);
    const allRows = epicId
      ? [epicStore.get(epicId)].filter(Boolean)
      : epicStore.list({ includeArchived, includeStandalone: true });

    const epics = allRows.filter((e) => e && e.kind !== STANDALONE_KIND) as EpicRecord[];
    const standalones = allRows.filter((e) => e && e.kind === STANDALONE_KIND) as EpicRecord[];

    if (epics.length === 0 && standalones.length === 0) {
      const archivedCount = epicStore.listArchived().length;
      if (!includeArchived && archivedCount > 0) {
        console.log(
          `   No active epics. ${archivedCount} archived — show with \`loom status --archived\`.`
        );
      } else {
        console.log('   No epics found. Run `loom epic "<brief>"` to start.');
      }
      return;
    }

    const verdicts = epics.length > 0
      ? epicStore.getIntakeVerdicts(epics.map((e) => e.id))
      : new Map<string, IntakeVerdict | null>();

    // Single read-only LandingStore instance shared across all epics.
    // SHA provider throws loudly if beginAttempt is ever accidentally called.
    const landingStore = new LandingStore(db, () => { throw new Error('LandingStore is read-only in status context'); });

    for (const epic of epics) {
      if (!epic) continue;
      const icon = STATUS_ICONS[epic.status] ?? '?';
      const archivedTag = epic.archived_at ? '  🗄 [archived]' : '';
      // ADR-1 symmetric overlay: show the live planning/finalize phase next to
      // the status instead of the opaque `(planning…)` placeholder title.
      const phase = epicPhaseSuffix(epic);
      const statusLabel =
        epic.status === 'publish_pending' ? PUBLISH_PENDING_LABEL : epic.status;
      console.log(
        `\n   ${icon} Epic ${epic.id}: ${epic.title}  [${statusLabel}${phase}]${archivedTag}`
      );

      if (integrationBranch === 'rolling') {
        const lag = computeIntegrationLag(epic.id, lagThreshold, repoRoot, spawnFn);
        if (lag?.warn) {
          console.log(`        ⚠  Integration branch is ${lag.commits_behind} commits behind main (threshold: ${lag.threshold})`);
        }
      }
      if (epic.status === 'planning') {
        const stale = computeStalePlanning(epic.updated_at, stalePlanningMinutes);
        if (stale.warn) {
          console.log(`        ⚠  Planning has been idle for ${stale.idle_minutes} minutes (threshold: ${stale.threshold_minutes}m)`);
        }
      }

      if (epic.epic_pr_url) {
        console.log(`        PR: ${epic.epic_pr_url}`);
      }
      if (epic.status === 'failed' && epic.error) {
        console.log(`        error: ${epic.error}`);
      }
      if (epic.status === 'publish_pending' && epic.publish_note) {
        console.log(`        note: ${epic.publish_note}`);
      }
      if (deriveBlocked(epic)) {
        console.log(`        blocked: integration_gate`);
      }

      const gate = gateResultFor(auditStore, epic.id);
      if (gate) console.log(`        gate: ${gate}`);

      const v = verdicts.get(epic.id) ?? null;
      console.log(`        verdict: ${v ? `${v.type}/${v.size} (${v.confidence})` : 'no verdict'}`);

      if (epic.planner_tokens_input || epic.planner_tokens_output) {
        const inn = epic.planner_tokens_input ?? 0;
        const out = epic.planner_tokens_output ?? 0;
        const cached = epic.planner_tokens_cached ?? 0;
        const ms = epic.planner_ms ?? 0;
        const secs = Math.round(ms / 100) / 10;
        console.log(
          `        planner: ${(inn + out).toLocaleString()} tokens ` +
            `(${inn.toLocaleString()} in / ${out.toLocaleString()} out, ` +
            `${cached.toLocaleString()} cached) in ${secs}s`
        );
      }

      // Show one row per story_id — collapse retry attempts to the latest
      // (matches `loom_get_status`). A story that was blocked then retried
      // to done shows as 'done' once, with a "(retry N)" tag when the
      // attempt count exceeds 1.
      const agents = agentStore.listLatestByEpic(epic.id);
      if (agents.length === 0) {
        console.log('      No agents dispatched yet.');
      } else {
        for (const agent of agents) {
          const si = STATUS_ICONS[agent.status] ?? '?';
          const pr = agent.pr_url ? `  → ${agent.pr_url}` : '';
          const elapsed = agent.started_at
            ? ` (${elapsedStr(agent.started_at, agent.status === 'running' ? undefined : agent.updated_at)})`
            : '';
          const label = agent.story_title
            ? `${agent.story_id} — ${agent.story_title}`
            : agent.story_id;
          const stall =
            agent.status === 'running' ? stallReasonFor(auditStore, agent.id) : null;
          const stallTag = stall ? `  ⚠ ${stall}` : '';
          const attempts = agentStore.listHistoryByStory(agent.story_id).length;
          const retryTag = attempts > 1 ? `  (retry ${attempts - 1})` : '';
          const recoveryCount = recoveryStore.getRecoveryCount(agent.story_id);
          const recoveryTag = recoveryCount > 0 ? `  (recovered ${recoveryCount})` : '';
          const reviseTag = formatReviseTag(agent.revise_round);
          const modelTag = `  [${displayModel(agent.model)}]`;
          console.log(`      ${si} ${label}${elapsed}${stallTag}${retryTag}${recoveryTag}${reviseTag}${modelTag}${pr}`);
          if (agent.branch_name && agent.status !== 'done') {
            console.log(`           ${agent.branch_name}`);
          }
        }
      }

      // Show the latest cross-repo landing attempt for this epic, if any.
      // Landing report is independent of agent presence — show even when no agents have been dispatched.
      const latestAttemptId = landingStore.latestAttemptIdForEpic(epic.id);
      if (latestAttemptId) {
        try {
          const report = landingReport(latestAttemptId, landingStore);
          renderLandingReport(report);
        } catch {
          console.log('      ⚠ landing report unavailable');
        }
      }
    }

    // Render standalone stories with story framing (never as "epic-NNN with N stories").
    for (const container of standalones) {
      const agents = agentStore.listLatestByEpic(container.id);
      const archivedTag = container.archived_at ? '  🗄 [archived]' : '';
      if (agents.length === 0) {
        // Container exists but no agent dispatched yet (planning phase).
        const icon = STATUS_ICONS[container.status] ?? '?';
        const statusLabel =
          container.status === 'publish_pending' ? PUBLISH_PENDING_LABEL : container.status;
        console.log(`\n   ${icon} Story ${container.title}  [${statusLabel}]${archivedTag}`);
        continue;
      }
      // Exactly one story for a standalone container.
      const agent = agents[0];
      const si = STATUS_ICONS[agent.status] ?? '?';
      const pr = agent.pr_url ? `  → ${agent.pr_url}` : '';
      const elapsed = agent.started_at
        ? ` (${elapsedStr(agent.started_at, agent.status === 'running' ? undefined : agent.updated_at)})`
        : '';
      const label = agent.story_title
        ? `${agent.story_id} — ${agent.story_title}`
        : agent.story_id;
      const stall =
        agent.status === 'running' ? stallReasonFor(auditStore, agent.id) : null;
      const stallTag = stall ? `  ⚠ ${stall}` : '';
      const attempts = agentStore.listHistoryByStory(agent.story_id).length;
      const retryTag = attempts > 1 ? `  (retry ${attempts - 1})` : '';
      const recoveryCount = recoveryStore.getRecoveryCount(agent.story_id);
      const recoveryTag = recoveryCount > 0 ? `  (recovered ${recoveryCount})` : '';
      const reviseTag = formatReviseTag(agent.revise_round);
      const modelTag = `  [${displayModel(agent.model)}]`;
      console.log(`\n   ${si} Story ${label}  [${agent.status}]${elapsed}${stallTag}${retryTag}${recoveryTag}${reviseTag}${modelTag}${pr}${archivedTag}`);
      if (agent.branch_name && agent.status !== 'done') {
        console.log(`        ${agent.branch_name}`);
      }
    }
  } finally {
    db.close();
  }
}

function allTerminal(options: StatusOptions): boolean {
  let loomDirs: string[];
  if (options.project) {
    const resolved = path.resolve(options.project);
    const entry = new ProjectRegistry().list().find((p) => p.root === resolved);
    if (!entry) return true; // unregistered — treat as terminal so watch loop exits (render already errored)
    loomDirs = [path.join(resolved, '.loom')];
  } else {
    loomDirs = options.all
      ? new ProjectRegistry().list().map((p) => path.join(p.root, '.loom'))
      : [path.join(options.projectRoot ?? process.cwd(), '.loom')];
  }
  if (loomDirs.length === 0) return true;
  return loomDirs.every((dir) => loomDirTerminal(dir, options.epicId));
}

function loomDirTerminal(loomDir: string, epicId?: string): boolean {
  const dbPath = resolveDbPath(loomDir);
  if (!fs.existsSync(dbPath)) return true;
  const db = createDatabase(dbPath);
  try {
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    // Include standalone containers so the --watch loop also waits for them.
    const epics = epicId
      ? [epicStore.get(epicId)].filter(Boolean)
      : epicStore.list({ includeStandalone: true });
    if (epics.length === 0) return false;
    return epics.every((epic) =>
      epic ? agentStore.allTerminalForEpic(epic.id) : true
    );
  } finally {
    db.close();
  }
}

/** Latest integration-gate result for an epic, formatted for the status view. */
function gateResultFor(audit: AuditLog, epicId: string): string | null {
  const row = audit.latestActionByCommand(epicId, ['epic_integration_gate']);
  if (!row) return null;
  try {
    const detail = row.detail ? JSON.parse(row.detail) : {};
    const verdict = detail.ok ? '✅ passed' : '❌ FAILED';
    return detail.summary ? `${verdict} — ${detail.summary}` : verdict;
  } catch {
    return null;
  }
}

/** Stall reason for a running story from its latest timeout/watchdog warning. */
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

// For a terminal agent, pass its finish time (updated_at) so the displayed
// duration is the real processing time (start→finish), not now−start — which
// otherwise keeps growing forever and makes long-finished epics look like they
// ran for hours (S25). Running agents pass no end and get live elapsed.
function formatReviseTag(reviseRound: number | null | undefined): string {
  const n = reviseRound ?? 0;
  return n >= 1 ? `  (revise ${n})` : '';
}

function elapsedStr(startedAt: string, endedAt?: string): string {
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const spec: CommandDescription = {
  name: 'status',
  summary: 'Show epic and story status with PR links',
  whenToUse: 'The primary observability command. Use to check which epics and stories are running, blocked, done, or failed. Add --watch for a live-refreshing view.',
  arguments: [],
  options: [
    { name: '--watch', type: 'boolean', description: 'Refresh every 10s until all stories reach terminal status', changesOutputShape: false },
    { name: '--epic', type: 'string', description: 'Show only this epic', changesOutputShape: false },
    { name: '--all', type: 'boolean', description: 'Aggregate status across every registered loom project', changesOutputShape: false },
    { name: '--archived', type: 'boolean', description: 'Include archived runs (hidden by default)', changesOutputShape: false },
    { name: '--json', type: 'boolean', description: 'Emit machine-readable JSON payload', changesOutputShape: true },
    { name: '--project', type: 'string', description: 'Target the named registered project (absolute path)', changesOutputShape: false },
  ],
  output: {
    text: 'Human-readable tree of epics and stories with status icons and PR links',
    json: { supported: true, shape: '{ epics: { id, title, status, stories: { id, title, status, pr_url?, history? }[] }[], loom_home?: string }' },
  },
  examples: [
    { command: 'loom status', description: 'Show all epics in the current project' },
    { command: 'loom status --json', description: 'Emit machine-readable JSON' },
    { command: 'loom status --watch', description: 'Auto-refresh every 10 seconds' },
    { command: 'loom status --all', description: 'Show status for all registered projects' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Status shown successfully' },
    { code: 1, meaning: 'Project not registered or --project/--all conflict' },
  ],
  errors: ['--project and --all are mutually exclusive', 'Project not registered — run `loom init` first'],
  relationships: { prerequisites: ['init'], nextSteps: ['run', 'approve', 'retry', 'stop'] },
  aliases: ['st'],
};
