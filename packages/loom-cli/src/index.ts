#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInit, spec as initSpec } from './commands/init.js';
import { runGuardCheck, runGuardHook, specCheck as guardCheckSpec, specHook as guardHookSpec } from './commands/guard.js';
import { runStatus, spec as statusSpec } from './commands/status.js';
import { runEpic, spec as epicSpec } from './commands/epic.js';
import { runApprove, runReject, spec as approveSpec, specReject as rejectSpec } from './commands/gate.js';
import { runArchive, runUnarchive, spec as archiveSpec, specUnarchive } from './commands/archive.js';
import { runRun, spec as runSpec } from './commands/run.js';
import { runRetry, spec as retrySpec } from './commands/retry.js';
import { runWeb, spec as webSpec } from './commands/web.js';
import { runStop, spec as stopSpec } from './commands/stop.js';
import { runRevert, spec as revertSpec } from './commands/revert.js';
import { runReconcile, spec as reconcileSpec } from './commands/reconcile.js';
import { runPublish, spec as publishSpec } from './commands/publish.js';
import { runFinalize, spec as finalizeSpec } from './commands/finalize.js';
import { runRelease, spec as releaseSpec } from './commands/release.js';
import { runGuide, spec as guideSpec } from './commands/guide.js';
import { runMcpList, runMcpAdd, specList as mcpListSpec, specAdd as mcpAddSpec } from './commands/mcp.js';
import { runDoctor, runCapabilitiesMode, spec as doctorSpec } from './commands/doctor.js';
import { runScanCommand, runOpportunitiesCommand, spec as scanSpec, specOpportunities } from './commands/scan.js';
import { runGateDryRunCommand } from './commands/doctorDryRunGate.js';
import { runCrossEpicGateCommand } from './commands/doctorCrossEpicGate.js';
import { runPropose, spec as proposeSpec } from './commands/propose.js';
import { runDiff, spec as diffSpec } from './commands/diff.js';
import { runReview, spec as reviewSpec } from './commands/review.js';
import { runArtifacts, spec as artifactsSpec } from './commands/artifacts.js';
import { runTraces, spec as tracesSpec } from './commands/traces.js';
import { runAudit, spec as auditSpec } from './commands/audit.js';
import { runCost, spec as costSpec } from './commands/cost.js';
import { runAutonomy, spec as autonomySpec } from './commands/autonomy.js';
import { runProjects, spec as projectsSpec } from './commands/projects.js';
import { runPullGuidance, spec as pullGuidanceSpec } from './commands/pullGuidance.js';
import { runProject, spec as projectSpec } from './commands/project.js';
import { runWeave, spec as weaveSpec } from './commands/weave.js';
import { runMigrate, spec as migrateSpec } from './commands/migrate.js';
import { runRetrieveSearch, runRetrieveRead, specSearch as retrieveSearchSpec, specRead as retrieveReadSpec } from './commands/retrieve.js';
import { applySpec } from './describe/applySpec.js';
import { registerDescribe } from './commands/describe.js';
import { handleTopLevelError } from './errorHandling.js';

// Read the version from this package's package.json at runtime so
// `loom --version` stays automatically in sync with the published
// version after each release — no source bump needed.
const PKG_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;

// Pure factory: registers every command without calling .parse().
// The bin entry point calls buildProgram().parse() so tests can import
// buildProgram without triggering Commander's argv parsing.
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('loom')
    .description('Loom — autonomous agentic engineering system')
    .version(PKG_VERSION);

  // ─── loom doctor ────────────────────────────────────────────────────────────
  applySpec(program.command('doctor'), doctorSpec)
    .action(async (opts: { dryRunGate?: boolean; crossEpicGate?: boolean; epics?: string; capabilities?: boolean }) => {
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
      if (opts.capabilities) {
        runCapabilitiesMode({ program });
        return;
      }
      await runDoctor();
    });

  // ─── loom init ─────────────────────────────────────────────────────────────
  // Keeps bespoke wiring to preserve the -y shorthand for --yes.
  program
    .command('init')
    .description(initSpec.summary)
    .option('--cursor', 'Also write .cursor/rules/loom.mdc for Cursor IDE integration')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action((opts: { cursor?: boolean; yes?: boolean }) => {
      runInit(opts);
    });

  // ─── loom guard ────────────────────────────────────────────────────────────
  const guard = program
    .command('guard')
    .description('Guardrail commands');

  // Keeps bespoke wiring to preserve Commander requiredOption behaviour on --command.
  guard
    .command('check')
    .description(guardCheckSpec.summary)
    .requiredOption('--command <cmd>', 'The shell command to validate against policy')
    .action((opts: { command: string }) => {
      runGuardCheck(opts.command);
    });

  applySpec(guard.command('hook'), guardHookSpec)
    .action(async () => {
      await runGuardHook();
    });

  // ─── loom status ────────────────────────────────────────────────────────────
  applySpec(program.command('status'), statusSpec)
    .action(
      (opts: {
        watch?: boolean;
        epic?: string;
        all?: boolean;
        archived?: boolean;
        json?: boolean;
        project?: string;
      }) => {
        runStatus({
          watch: opts.watch,
          epicId: opts.epic,
          all: opts.all,
          archived: opts.archived,
          json: opts.json,
          project: opts.project,
        });
      }
    );

  // ─── loom epic ──────────────────────────────────────────────────────────────
  applySpec(program.command('epic'), epicSpec)
    .action(async (brief: string, opts: { force?: boolean; verbose?: boolean }) => {
      await runEpic(brief, { force: opts.force, verbose: opts.verbose });
    });

  // ─── loom weave ─────────────────────────────────────────────────────────────
  applySpec(program.command('weave'), weaveSpec)
    .action(async (brief: string, opts: { force?: boolean; verbose?: boolean }) => {
      await runWeave(brief, { force: opts.force, verbose: opts.verbose });
    });

  // ─── loom approve / reject (human gate) ─────────────────────────────────────
  applySpec(program.command('approve'), approveSpec)
    .action(async (epicId: string | undefined, opts: { run?: boolean }) => {
      await runApprove(epicId, { run: opts.run });
    });

  applySpec(program.command('reject'), rejectSpec)
    .action((epicId: string, opts: { reason?: string }) => {
      runReject(epicId, opts.reason);
    });

  // ─── loom archive / unarchive ───────────────────────────────────────────────
  applySpec(program.command('archive'), archiveSpec)
    .action((epicId: string) => {
      runArchive(epicId);
    });

  applySpec(program.command('unarchive'), specUnarchive)
    .action((epicId: string) => {
      runUnarchive(epicId);
    });

  // ─── loom run ───────────────────────────────────────────────────────────────
  // Keeps bespoke wiring to preserve the variadic [epic-ids...] argument.
  program
    .command('run')
    .description(runSpec.summary)
    .argument('[epic-ids...]', 'Specific epics to run; omit to run all approved epics')
    .option('--checkpoint <value>', 'Pause after the next "story" or "epic" boundary instead of running to completion')
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
  applySpec(program.command('retry'), retrySpec)
    .action(async (storyId: string, opts: { clean?: boolean; reason?: string; force?: boolean }) => {
      await runRetry(storyId, { clean: opts.clean, reason: opts.reason, force: opts.force });
    });

  // ─── loom web ───────────────────────────────────────────────────────────────
  // Keeps bespoke wiring to preserve the -p shorthand for --port.
  program
    .command('web')
    .description(webSpec.summary)
    .option('-p, --port <n>', 'Port to bind (default: 8765, with free-port search)', (v: string) => parseInt(v, 10))
    .option('--no-open', "Don't auto-open the browser")
    .option('--read-only', 'Serve GET routes without authentication; mutations require the write token (also: LOOM_WEB_READONLY=1)')
    .action(async (opts: { port?: number; open?: boolean; readOnly?: boolean }) => {
      await runWeb({ port: opts.port, noOpen: opts.open === false, readOnly: opts.readOnly });
    });

  // ─── loom stop ──────────────────────────────────────────────────────────────
  // Keeps bespoke wiring to preserve the variadic [story-ids...] argument.
  program
    .command('stop')
    .description(stopSpec.summary)
    .argument('[story-ids...]', 'Story ids to stop individually; omit to halt the whole run')
    .option('--epic <value>', 'Stop every running worker in this epic only (leaves other epics running)')
    .option('--reason <value>', 'Explanation recorded in the audit log (defaults to "cli")')
    .option('--and-retry', 'After stopping, poll until terminal (30 s timeout), then enqueue a retry')
    .action(async (storyIds: string[], opts: { epic?: string; reason?: string; andRetry?: boolean }) => {
      await runStop(storyIds, opts);
    });

  // ─── loom guide ─────────────────────────────────────────────────────────────
  // Keeps bespoke wiring to preserve the variadic [message...] second argument.
  program
    .command('guide')
    .description(guideSpec.summary)
    .argument('<story-id>', 'Story id (e.g. story-001-003)')
    .argument('[message...]', 'Free-form guidance text (omit when using --clear)')
    .option('--clear', 'Remove the guidance file for this story')
    .option('--author <value>', 'Tag the entry with an author label (defaults to "operator")')
    .action((storyId: string, messageParts: string[], opts: { clear?: boolean; author?: string }) => {
      runGuide(storyId, messageParts.join(' '), opts);
    });

  // ─── loom revert ────────────────────────────────────────────────────────────
  applySpec(program.command('revert'), revertSpec)
    .action((epicId: string, opts: { remote?: boolean; reason?: string }) => {
      runRevert(epicId, opts);
    });

  // ─── loom reconcile ─────────────────────────────────────────────────────────
  applySpec(program.command('reconcile'), reconcileSpec)
    .action((epicId: string, opts: { pr?: string }) => runReconcile(epicId, { pr: opts.pr }));

  // ─── loom publish ────────────────────────────────────────────────────────────
  applySpec(program.command('publish'), publishSpec)
    .action(async (epicId: string) => {
      await runPublish(epicId);
    });

  // ─── loom finalize ───────────────────────────────────────────────────────────
  applySpec(program.command('finalize'), finalizeSpec)
    .action(async (epicId: string, opts: { resume?: boolean }) => {
      await runFinalize(epicId, { resume: opts.resume });
    });

  // ─── loom release ────────────────────────────────────────────────────────────
  applySpec(program.command('release'), releaseSpec)
    .action((version: string) => {
      runRelease(version);
    });

  // ─── loom diff ────────────────────────────────────────────────────────────
  applySpec(program.command('diff'), diffSpec)
    .action(async (id: string, opts: { maxBytes?: string | number; stat?: boolean; json?: boolean }) => {
      await runDiff(id, {
        maxBytes: opts.maxBytes !== undefined ? parseInt(String(opts.maxBytes), 10) : undefined,
        stat: opts.stat,
        json: opts.json,
      });
    });

  // ─── loom review ──────────────────────────────────────────────────────────
  applySpec(program.command('review'), reviewSpec)
    .action((storyId: string, opts: { json?: boolean }) => {
      runReview(storyId, { json: opts.json });
    });

  // ─── loom artifacts ───────────────────────────────────────────────────────
  applySpec(program.command('artifacts'), artifactsSpec)
    .action((epicId: string, opts: { section?: string; json?: boolean }) => {
      runArtifacts(epicId, { section: opts.section, json: opts.json });
    });

  // ─── loom traces ──────────────────────────────────────────────────────────
  applySpec(program.command('traces'), tracesSpec)
    .action((opts: { story?: string; agent?: string; epic?: string; limit?: string | number; json?: boolean }) => {
      runTraces({
        ...opts,
        limit: opts.limit !== undefined ? parseInt(String(opts.limit), 10) : undefined,
      });
    });

  // ─── loom audit ───────────────────────────────────────────────────────────
  applySpec(program.command('audit'), auditSpec)
    .action((opts: { story?: string; agent?: string; limit?: string | number; json?: boolean }) => {
      runAudit({
        ...opts,
        limit: opts.limit !== undefined ? parseInt(String(opts.limit), 10) : undefined,
      });
    });

  // ─── loom cost ────────────────────────────────────────────────────────────
  applySpec(program.command('cost'), costSpec)
    .action((opts: { run?: string | number; epic?: string; aggregate?: boolean; json?: boolean }) => {
      runCost({
        run: opts.run !== undefined ? parseInt(String(opts.run), 10) : undefined,
        epic: opts.epic,
        aggregate: opts.aggregate,
        json: opts.json,
      });
    });

  // ─── loom autonomy ────────────────────────────────────────────────────────
  applySpec(program.command('autonomy'), autonomySpec)
    .action((epicId: string, level: string | undefined, opts: { json?: boolean }) => {
      runAutonomy(epicId, level, { json: opts.json });
    });

  // ─── loom projects ────────────────────────────────────────────────────────
  applySpec(program.command('projects'), projectsSpec)
    .action((opts: { json?: boolean }) => {
      runProjects({ json: opts.json });
    });

  // ─── loom pull-guidance ──────────────────────────────────────────────────────
  applySpec(program.command('pull-guidance'), pullGuidanceSpec)
    .action((storyId: string, opts: { json?: boolean }) => {
      runPullGuidance(storyId, { json: opts.json });
    });

  // ─── loom project ─────────────────────────────────────────────────────────────
  applySpec(program.command('project'), projectSpec)
    .action((projectRoot: string, opts: { json?: boolean }) => {
      runProject(projectRoot, { json: opts.json });
    });

  // ─── loom migrate ────────────────────────────────────────────────────────────
  applySpec(program.command('migrate'), migrateSpec)
    .action((opts: { dryRun?: boolean; relocateCommittedArtifacts?: boolean }) => {
      runMigrate({ dryRun: opts.dryRun, relocateCommittedArtifacts: opts.relocateCommittedArtifacts });
    });

  // ─── loom retrieve ─────────────────────────────────────────────────────────
  const retrieve = program
    .command('retrieve')
    .description('Cross-repo read-only retrieval (requires cross_repo.enabled=true in policy.yaml)');

  // Bespoke wiring (no applySpec) so we can declare required options; the spec
  // is registered separately in collectSpecs() for completeness coverage.
  retrieve
    .command('search')
    .description(retrieveSearchSpec.summary)
    .requiredOption('--repo <slug>', 'Slug of the registered repository to search')
    .requiredOption('--query <q>', 'Fixed string to search for (git grep -F)')
    .option('--glob <g>', 'Optional path glob to restrict the search (e.g. "*.ts")')
    .action(async (opts: { repo: string; query: string; glob?: string }) => {
      await runRetrieveSearch(opts);
    });

  retrieve
    .command('read')
    .description(retrieveReadSpec.summary)
    .requiredOption('--repo <slug>', 'Slug of the registered repository to read from')
    .requiredOption('--path <p>', 'Relative file path within the repository')
    .option('--lines <a:b>', 'Optional line range as <start>:<end> (e.g. "10:50")')
    .action(async (opts: { repo: string; path: string; lines?: string }) => {
      await runRetrieveRead({ repo: opts.repo, filePath: opts.path, lines: opts.lines });
    });

  // <register additional commands>
  registerDescribe(program);

  // ─── loom mcp ───────────────────────────────────────────────────────────────
  const mcp = program
    .command('mcp')
    .description('Provision approved MCP servers from the org registry');

  applySpec(mcp.command('list'), mcpListSpec)
    .action(() => {
      runMcpList();
    });

  applySpec(mcp.command('add'), mcpAddSpec)
    .action((name: string) => {
      runMcpAdd(name);
    });

  // ─── loom scan ──────────────────────────────────────────────────────────────
  applySpec(program.command('scan'), scanSpec)
    .action(async (opts: { json?: boolean; project?: string }) => {
      await runScanCommand({ json: opts.json, project: opts.project });
    });

  // ─── loom opportunities ─────────────────────────────────────────────────────
  applySpec(program.command('opportunities'), specOpportunities)
    .action((opts: { json?: boolean }) => {
      runOpportunitiesCommand({ json: opts.json });
    });

  // ─── loom propose ───────────────────────────────────────────────────────────
  applySpec(program.command('propose'), proposeSpec)
    .action(async (opts: { topLessons?: string | number; topOpps?: string | number; json?: boolean }) => {
      let topLessons: number | undefined;
      if (opts.topLessons !== undefined) {
        topLessons = parseInt(String(opts.topLessons), 10);
        if (isNaN(topLessons) || topLessons < 1) {
          console.error('error: --top-lessons must be a positive integer');
          process.exit(1);
        }
      }
      let topOpps: number | undefined;
      if (opts.topOpps !== undefined) {
        topOpps = parseInt(String(opts.topOpps), 10);
        if (isNaN(topOpps) || topOpps < 1) {
          console.error('error: --top-opps must be a positive integer');
          process.exit(1);
        }
      }
      await runPropose({ topLessons, topOpps, json: opts.json });
    });

  return program;
}

// package.json#bin → dist/index.js directly (no wrapper), so require.main === module
// is true when Node invokes the CLI entry point and false when tests import buildProgram.
if (require.main === module) {
  // Catch non-policy errors that handleTopLevelError rethrows from the .catch() chain;
  // they become unhandled rejections — print with stack so developers can debug them.
  process.on('unhandledRejection', (err) => {
    if (err instanceof Error) {
      process.stderr.write((err.stack ?? err.message) + '\n');
    } else {
      process.stderr.write(String(err) + '\n');
    }
    process.exit(1);
  });
  buildProgram().parseAsync().catch(handleTopLevelError);
}

export { handleTopLevelError };
