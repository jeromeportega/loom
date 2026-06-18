import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  createDatabase,
  EpicStore,
  AgentStore,
  AuditLog,
  ProjectRegistry,
  deriveBlocked,
} from '@loom-ai/core';

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
    if (projectLoomDir) {
      const resolved = path.resolve(options.project!);
      console.log(`\n━━ ${path.basename(resolved)}  (${resolved})`);
      renderLoomDir(projectLoomDir, options.epicId, options.archived);
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
        renderLoomDir(path.join(project.root, '.loom'), options.epicId, options.archived);
      }
      console.log('');
      return;
    }
    renderLoomDir(path.join(process.cwd(), '.loom'), options.epicId, options.archived);
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
}

interface JsonEpic {
  id: string;
  title: string;
  status: string;
  archived?: boolean;
  blocked?: true;
  blocked_reason?: 'integration_gate';
  stories: JsonStory[];
}

interface JsonStatus {
  epics: JsonEpic[];
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
      : [path.join(process.cwd(), '.loom')];
  }

  const epics: JsonEpic[] = [];
  for (const loomDir of loomDirs) {
    epics.push(...collectJsonEpics(loomDir, options.epicId, options.archived));
  }
  return { epics };
}

function collectJsonEpics(
  loomDir: string,
  epicId?: string,
  includeArchived?: boolean
): JsonEpic[] {
  const dbPath = path.join(loomDir, 'loom.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = createDatabase(dbPath);
  try {
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    const epicRows = epicId
      ? [epicStore.get(epicId)].filter(Boolean)
      : epicStore.list({ includeArchived });

    const out: JsonEpic[] = [];
    for (const epic of epicRows) {
      if (!epic) continue;
      // One row per story_id — collapse retries to the latest attempt and
      // surface older ones under `history`, matching `loom_get_status`.
      const latest = agentStore.listLatestByEpic(epic.id);
      const stories: JsonStory[] = latest.map((a) => {
        const history = agentStore
          .listHistoryByStory(a.story_id)
          .filter((h) => h.id !== a.id);
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
        };
      });
      out.push({
        id: epic.id,
        title: epic.title,
        status: epic.status,
        ...(epic.archived_at ? { archived: true } : {}),
        ...(deriveBlocked(epic) ?? {}),
        stories,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Renders one loom project's epic/agent tree. */
function renderLoomDir(loomDir: string, epicId?: string, includeArchived?: boolean): void {
  const dbPath = path.join(loomDir, 'loom.db');
  if (!fs.existsSync(dbPath)) {
    console.log('   Not yet planned — run `loom epic "<brief>"` here.');
    return;
  }
  const db = createDatabase(dbPath);
  try {
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    const auditStore = new AuditLog(db);
    const epics = epicId
      ? [epicStore.get(epicId)].filter(Boolean)
      : epicStore.list({ includeArchived });

    if (epics.length === 0) {
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
        continue;
      }

      for (const agent of agents) {
        const si = STATUS_ICONS[agent.status] ?? '?';
        const pr = agent.pr_url ? `  → ${agent.pr_url}` : '';
        const elapsed = agent.started_at
          ? ` (${elapsedStr(agent.started_at)})`
          : '';
        const label = agent.story_title
          ? `${agent.story_id} — ${agent.story_title}`
          : agent.story_id;
        const stall =
          agent.status === 'running' ? stallReasonFor(auditStore, agent.id) : null;
        const stallTag = stall ? `  ⚠ ${stall}` : '';
        const attempts = agentStore.listHistoryByStory(agent.story_id).length;
        const retryTag = attempts > 1 ? `  (retry ${attempts - 1})` : '';
        console.log(`      ${si} ${label}${elapsed}${stallTag}${retryTag}${pr}`);
        if (agent.branch_name && agent.status !== 'done') {
          console.log(`           ${agent.branch_name}`);
        }
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
      : [path.join(process.cwd(), '.loom')];
  }
  if (loomDirs.length === 0) return true;
  return loomDirs.every((dir) => loomDirTerminal(dir, options.epicId));
}

function loomDirTerminal(loomDir: string, epicId?: string): boolean {
  const dbPath = path.join(loomDir, 'loom.db');
  if (!fs.existsSync(dbPath)) return true;
  const db = createDatabase(dbPath);
  try {
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);
    const epics = epicId
      ? [epicStore.get(epicId)].filter(Boolean)
      : epicStore.list();
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

function elapsedStr(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
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
    json: { supported: true, shape: '{ epics: { id, title, status, stories: { id, title, status, pr_url?, history? }[] }[] }' },
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
};
