#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from './commands/init.js';
import { runGuardCheck, runGuardHook } from './commands/guard.js';
import { runStatus } from './commands/status.js';
import { runEpic } from './commands/epic.js';
import { runApprove, runReject } from './commands/gate.js';
import { runArchive, runUnarchive } from './commands/archive.js';
import { runRun } from './commands/run.js';
import { runRetry } from './commands/retry.js';
import { runWeb } from './commands/web.js';
import { runStop } from './commands/stop.js';
import { runRevert } from './commands/revert.js';
import { runReconcile } from './commands/reconcile.js';
import { runGuide } from './commands/guide.js';
import { runMcpList, runMcpAdd } from './commands/mcp.js';
import { runDoctor } from './commands/doctor.js';
import { runScanCommand, runOpportunitiesCommand } from './commands/scan.js';
import { runGateDryRunCommand } from './commands/doctorDryRunGate.js';
import { runCrossEpicGateCommand } from './commands/doctorCrossEpicGate.js';
import { runPropose } from './commands/propose.js';
import { runDiff } from './commands/diff.js';
import { runReview } from './commands/review.js';
import { runArtifacts } from './commands/artifacts.js';
import { runTraces } from './commands/traces.js';
import { runAudit } from './commands/audit.js';
import { runAutonomy } from './commands/autonomy.js';
import { runProjects } from './commands/projects.js';

// Read the version from this package's package.json at runtime so
// `loom --version` stays automatically in sync with the published
// version after each release — no source bump needed.
const PKG_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;

const program = new Command();

program
  .name('loom')
  .description('Loom — autonomous agentic engineering system')
  .version(PKG_VERSION);

// ─── loom doctor ────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Check prerequisites (Node, git, claude CLI, gh) and report what is missing')
  .option(
    '--dry-run-gate',
    'Execute the integration gate command ONCE in a throwaway worktree and report the outcome (opt-in only)'
  )
  .option(
    '--cross-epic-gate',
    'Merge every open epic branch into a throwaway union worktree and run the suite once — reports per-pair conflicts or the union suite result (opt-in only)'
  )
  .option(
    '--epics <ids>',
    'Comma-separated epic ids to restrict --cross-epic-gate to (default: every epic/* branch)'
  )
  .action(async (opts: { dryRunGate?: boolean; crossEpicGate?: boolean; epics?: string }) => {
    if (opts.crossEpicGate) {
      const epics = opts.epics
        ? opts.epics
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined;
      await runCrossEpicGateCommand(process.cwd(), epics);
      return;
    }
    if (opts.dryRunGate) {
      await runGateDryRunCommand(process.cwd());
      return;
    }
    runDoctor();
  });

// ─── loom init ─────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize loom in the current git repo (CLI-first; MCP server is opt-in)')
  .option('--cursor', 'Also write .cursor/mcp.json and .cursor/rules/loom.mdc')
  .option('--mcp', 'Also write .mcp.json so Claude Code connects the optional loom MCP server')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action((opts: { cursor?: boolean; yes?: boolean; mcp?: boolean }) => {
    runInit(opts);
  });

// ─── loom guard ────────────────────────────────────────────────────────────
const guard = program
  .command('guard')
  .description('Guardrail commands');

guard
  .command('check')
  .description('Check whether a command is allowed by policy (CLI / manual use)')
  .requiredOption('--command <cmd>', 'The command to validate')
  .action((opts: { command: string }) => {
    runGuardCheck(opts.command);
  });

guard
  .command('hook')
  .description('Read Claude Code PreToolUse JSON from stdin and enforce policy (used by .claude/settings.json hook)')
  .action(async () => {
    await runGuardHook();
  });

// ─── loom status ────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show epic and per-story status with PR links (use --json for machine-readable output)')
  .option('--watch', 'Refresh every 10s until all stories reach terminal status')
  .option('--epic <id>', 'Show only this epic')
  .option('--all', 'Aggregate status across every registered loom project')
  .option('--archived', 'Include archived runs (hidden by default)')
  .option('--json', 'Emit a machine-readable JSON payload (one row per story, retries under history[])')
  .action(
    (opts: {
      watch?: boolean;
      epic?: string;
      all?: boolean;
      archived?: boolean;
      json?: boolean;
    }) => {
      runStatus({
        watch: opts.watch,
        epicId: opts.epic,
        all: opts.all,
        archived: opts.archived,
        json: opts.json,
      });
    }
  );

// ─── loom epic ──────────────────────────────────────────────────────────────
program
  .command('epic')
  .description('Plan an epic from a brief (runs the Analyst → PM → Architect pipeline)')
  .argument('<brief>', 'One paragraph describing what to build')
  .option(
    '--force',
    'Skip the brief-quality gate for this invocation; the critique is still produced and audit-logged'
  )
  .action(async (brief: string, opts: { force?: boolean }) => {
    await runEpic(brief, { force: opts.force });
  });

// ─── loom approve / reject (human gate) ─────────────────────────────────────
program
  .command('approve')
  .description('Approve planned epic(s) and release them for execution')
  .argument('[epic-id]', 'Epic to approve; omit to approve all planned epics')
  .option('--run', 'After approving, chain into `loom run <epic-id>` to dispatch immediately (requires an explicit epic id)')
  .action(async (epicId: string | undefined, opts: { run?: boolean }) => {
    await runApprove(epicId, { run: opts.run });
  });

program
  .command('reject')
  .description('Reject a planned epic')
  .argument('<epic-id>', 'Epic to reject')
  .option('--reason <reason>', 'Why the epic is being rejected')
  .action((epicId: string, opts: { reason?: string }) => {
    runReject(epicId, opts.reason);
  });

// ─── loom archive / unarchive ───────────────────────────────────────────────
program
  .command('archive')
  .description('Hide a run from status/web/MCP views (non-destructive)')
  .argument('<epic-id>', 'Epic to archive (e.g. epic-001)')
  .action((epicId: string) => {
    runArchive(epicId);
  });

program
  .command('unarchive')
  .description('Restore an archived run to the default views')
  .argument('<epic-id>', 'Epic to unarchive (e.g. epic-001)')
  .action((epicId: string) => {
    runUnarchive(epicId);
  });

// ─── loom run ───────────────────────────────────────────────────────────────
program
  .command('run')
  .description('Dispatch story agents for approved epics (the supervisor)')
  .argument('[epic-ids...]', 'Specific epics to run; omit to run all approved epics')
  .option(
    '--checkpoint <boundary>',
    'Pause after the next "story" or "epic" instead of completing everything'
  )
  .option('--verbose', 'Stream live worker stdout/stderr to the terminal')
  .action(async (epicIds: string[], opts: { checkpoint?: string; verbose?: boolean }) => {
    const checkpoint = opts.checkpoint;
    if (checkpoint && checkpoint !== 'story' && checkpoint !== 'epic') {
      console.error('--checkpoint must be "story" or "epic"');
      process.exit(1);
    }
    await runRun(epicIds, {
      checkpoint: checkpoint as 'story' | 'epic' | undefined,
      verbose: opts.verbose,
    });
  });

// ─── loom retry ───────────────────────────────────────────────────────────────
program
  .command('retry')
  .description(
    'Reset a failed/blocked story and re-run it. Lease-aware: a live run re-dispatches it; otherwise this command dispatches. Grants a fresh auto-retry budget.'
  )
  .argument('<story-id>', 'Story id to retry (e.g. story-001-003)')
  .option(
    '--clean',
    'Tear down the story\'s worktree + branch (and those stacked on it) so it re-runs from scratch instead of resuming'
  )
  .option('--reason <text>', 'Optional explanation recorded with the retry in the audit log')
  .action(async (storyId: string, opts: { clean?: boolean; reason?: string }) => {
    await runRetry(storyId, { clean: opts.clean, reason: opts.reason });
  });

// ─── loom web ───────────────────────────────────────────────────────────────
program
  .command('web')
  .description('Launch the loom web dashboard (localhost-only, random token)')
  .option('-p, --port <n>', 'Port to bind (default: 8765, with free-port search)', (v: string) => parseInt(v, 10))
  .option('--no-open', "Don't auto-open the browser")
  .option('--read-only', 'Serve GET routes without authentication; mutations require the write token (also: LOOM_WEB_READONLY=1)')
  .action(async (opts: { port?: number; open?: boolean; readOnly?: boolean }) => {
    await runWeb({ port: opts.port, noOpen: opts.open === false, readOnly: opts.readOnly });
  });

// ─── loom stop ──────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Halt the supervisor (no args), SIGTERM specific worker(s) by story id, or stop all workers in one epic with --epic')
  .argument('[story-ids...]', 'Story ids to stop individually; omit to halt the whole run')
  .option('--epic <epic-id>', 'Stop every running worker in this epic only (leaves other epics running)')
  .option('--reason <text>', 'Optional explanation recorded in the audit log (defaults to "cli")')
  .action((storyIds: string[], opts: { epic?: string; reason?: string }) => {
    runStop(storyIds, opts);
  });

// ─── loom guide ─────────────────────────────────────────────────────────────
program
  .command('guide')
  .description('Append a guidance message for one running worker — reads at next dispatch/revision when policy.agents.operator_guidance=on')
  .argument('<story-id>', 'Story id (e.g. story-001-003)')
  .argument('[message...]', 'Free-form guidance text (omit when using --clear)')
  .option('--clear', 'Remove the guidance file for this story')
  .option('--author <name>', 'Tag the entry with an author label (defaults to "operator")')
  .action((storyId: string, messageParts: string[], opts: { clear?: boolean; author?: string }) => {
    runGuide(storyId, messageParts.join(' '), opts);
  });

// ─── loom revert ────────────────────────────────────────────────────────────
program
  .command('revert')
  .description('Tear down an epic: delete the epic + story branches locally, flip DB status. --remote also deletes the upstream branch and closes the PR.')
  .argument('<epic-id>', 'Epic id (e.g. epic-001)')
  .option('--remote', 'Also delete the remote epic branch and close any loom-opened PR. Requires the project remote to match policy.git.allowed_remotes.')
  .option('--reason <text>', 'Optional explanation recorded with the revert in audit_log')
  .action((epicId: string, opts: { remote?: boolean; reason?: string }) => {
    runRevert(epicId, opts);
  });

// ─── loom reconcile ─────────────────────────────────────────────────────────
program
  .command('reconcile')
  .description('Reconcile a stranded-but-merged epic to done. Verifies the PR was merged (via gh or git ancestry) then flips the epic status.')
  .argument('<epic-id>', 'Epic id (e.g. epic-001)')
  .option('--pr <url>', 'PR URL to verify via gh (squash-merged epics REQUIRE this)')
  .action((epicId: string, opts: { pr?: string }) => {
    runReconcile(epicId, { pr: opts.pr });
  });

// ─── loom diff ────────────────────────────────────────────────────────────
program
  .command('diff')
  .description('Show a story or epic diff (git diff base..branch). Read-only.')
  .argument('<id>', 'Story id (story-XXX-YYY) or epic id (epic-XXX)')
  .option('--max-bytes <n>', 'Truncate the diff body at N bytes (default 200000)', (v: string) => parseInt(v, 10))
  .option('--no-stat', 'Omit the leading --stat summary')
  .option('--json', 'Emit JSON: { base, head, bytes, truncated, diff, stat }')
  .action(async (id: string, opts: { maxBytes?: number; stat?: boolean; json?: boolean }) => {
    await runDiff(id, { maxBytes: opts.maxBytes, stat: opts.stat, json: opts.json });
  });

// ─── loom review ──────────────────────────────────────────────────────────
program
  .command('review')
  .description("Show a story's review verdict and summary (block-and-revise output)")
  .argument('<story-id>', 'Story id (e.g. story-001-003)')
  .option('--json', 'Emit JSON: { story_id, review_status, review_summary }')
  .action((storyId: string, opts: { json?: boolean }) => {
    runReview(storyId, { json: opts.json });
  });

// ─── loom artifacts ───────────────────────────────────────────────────────
program
  .command('artifacts')
  .description("Show an epic's planning artifacts (brief, PRD, architecture, epic YAML)")
  .argument('<epic-id>', 'Epic id (e.g. epic-001)')
  .option('--section <name>', 'Print one body: brief | prd | architecture | epic_yaml')
  .option('--json', 'Emit JSON with paths + all artifact bodies')
  .action((epicId: string, opts: { section?: string; json?: boolean }) => {
    runArtifacts(epicId, { section: opts.section, json: opts.json });
  });

// ─── loom traces ──────────────────────────────────────────────────────────
program
  .command('traces')
  .description('Show captured worker reasoning (decision traces). Scope to exactly one of --story/--agent/--epic.')
  .option('--story <id>', 'Story id to scope to')
  .option('--agent <id>', 'Agent id to scope to')
  .option('--epic <id>', 'Epic id to scope to')
  .option('--limit <n>', 'Max rows to return', (v: string) => parseInt(v, 10))
  .option('--json', 'Emit JSON: { traces: [...] }')
  .action((opts: { story?: string; agent?: string; epic?: string; limit?: number; json?: boolean }) => {
    runTraces(opts);
  });

// ─── loom audit ───────────────────────────────────────────────────────────
program
  .command('audit')
  .description('Show recent audit_log entries. Optionally scope to --story or --agent.')
  .option('--story <id>', 'Story id (matches across retries)')
  .option('--agent <id>', 'Agent id to scope to')
  .option('--limit <n>', 'Max rows to return (default 20)', (v: string) => parseInt(v, 10))
  .option('--json', 'Emit JSON: { entries: [...] }')
  .action((opts: { story?: string; agent?: string; limit?: number; json?: boolean }) => {
    runAudit(opts);
  });

// ─── loom autonomy ────────────────────────────────────────────────────────
program
  .command('autonomy')
  .description('Set or show an epic autonomy level (full-auto | checkpoint | manual)')
  .argument('<epic-id>', 'Epic id (e.g. epic-001)')
  .argument('[level]', 'full-auto | checkpoint | manual; omit to show the current value')
  .option('--json', 'Emit JSON: { id, autonomy_level }')
  .action((epicId: string, level: string | undefined, opts: { json?: boolean }) => {
    runAutonomy(epicId, level, { json: opts.json });
  });

// ─── loom projects ────────────────────────────────────────────────────────
program
  .command('projects')
  .description('List loom-initialized repos on this machine')
  .option('--json', 'Emit JSON: { projects: [...] }')
  .action((opts: { json?: boolean }) => {
    runProjects({ json: opts.json });
  });

// ─── loom mcp ───────────────────────────────────────────────────────────────
const mcp = program
  .command('mcp')
  .description('Provision approved MCP servers from the org registry');

mcp
  .command('list')
  .description('List approved MCP servers from the configured registry')
  .action(() => {
    runMcpList();
  });

mcp
  .command('add')
  .description('Add an approved MCP server to .mcp.json and .cursor/mcp.json')
  .argument('<name>', 'Registry server name')
  .action((name: string) => {
    runMcpAdd(name);
  });

// ─── loom scan ──────────────────────────────────────────────────────────────
program
  .command('scan')
  .description('Run signal scanners and produce a ranked opportunity board (one LLM call)')
  .option('--json', 'Emit structured JSON output')
  .action(async (opts: { json?: boolean }) => {
    await runScanCommand({ json: opts.json });
  });

// ─── loom opportunities ─────────────────────────────────────────────────────
program
  .command('opportunities')
  .description('Show the current opportunity board (reads existing store, no scan)')
  .option('--json', 'Emit structured JSON output')
  .action((opts: { json?: boolean }) => {
    runOpportunitiesCommand({ json: opts.json });
  });

// ─── loom propose ───────────────────────────────────────────────────────────
program
  .command('propose')
  .description('Propose the next epic from top-ranked lessons + open opportunities (one LLM call)')
  .action(async () => {
    await runPropose();
  });

// ─── loom serve ─────────────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start the optional loom MCP server (stdio transport). The CLI is the primary surface; prefer running loom commands directly.')
  .action(async () => {
    // Dynamically import to keep CLI startup fast when MCP is not needed
    const { startMcpServer } = await import('@loom-ai/mcp');
    await startMcpServer();
  });

program.parse();
