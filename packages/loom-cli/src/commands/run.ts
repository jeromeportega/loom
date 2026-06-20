import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  openDatabase,
  PolicyEngine,
  Supervisor,
  EpicStore,
  createWorker,
  SkillStore,
  SkillGenerator,
  SkillLifecycle,
  SkillUsageStore,
  SkillProposer,
  AuditLog,
  createLLMClient,
  CursorCliClient,
  modelFor,
  createGlobalLimiter,
  EpicFinalizer,
  CodeReviewAgent,
  stallConfigWarning,
  validateCursorModels,
  registerReviewerSkills,
} from '@loom-ai/core';
import type { WorkerEvent, SkillEvent } from '@loom-ai/core';
import { maybeWarnGatePreflight } from './gatePreflightWarning.js';
import { printOverlapAdvisory } from '../crossEpicOverlap.js';

export interface RunOptions {
  checkpoint?: 'story' | 'epic';
  /** Stream live worker stdout/stderr to the terminal, line by line. */
  verbose?: boolean;
  /**
   * Test seam — point the cursor_model probe at a stub `cursor-agent`.
   * Production callers omit this; the real CLI is used.
   */
  cursorBin?: string;
  /**
   * Suppress the cross-epic overlap advisory at dispatch start. A chained
   * approve→run (story-007-004's `loom approve --run`) already printed it at
   * approve time; this flag stops the same advisory printing twice.
   */
  suppressOverlap?: boolean;
}

const STATUS_MARK: Record<string, string> = {
  done: '✓ done    ',
  pr_open: '↗ pr_open ',
  failed: '✗ failed  ',
  blocked: '- blocked ',
};

/**
 * Pretty-prints worker lifecycle events. In default mode you see one line on
 * dispatch and one on completion per story. With --verbose you also see the
 * worker's live stdout/stderr, line-buffered per story and prefixed with the
 * story id so concurrent workers stay readable.
 */
function makeEventPrinter(opts: { verbose: boolean }): (event: WorkerEvent) => void {
  const lineBuffers = new Map<string, string>();

  function flushPartial(storyId: string): void {
    const carry = lineBuffers.get(storyId);
    if (carry && carry.length > 0) {
      process.stdout.write(`  [${storyId}] ${carry}\n`);
      lineBuffers.delete(storyId);
    }
  }

  return (event) => {
    if (event.type === 'dispatched') {
      console.log(`  → dispatched ${event.storyId}  (${event.branchName})`);
      return;
    }
    if (event.type === 'completed') {
      flushPartial(event.storyId);
      const mark = STATUS_MARK[event.status] ?? `  ${event.status}  `;
      console.log(`  ${mark} ${event.storyId} — ${event.summary}`);
      return;
    }
    if (event.type === 'output' && opts.verbose) {
      const carry = lineBuffers.get(event.storyId) ?? '';
      const text = carry + event.chunk;
      const parts = text.split('\n');
      const last = parts.pop() ?? '';
      for (const line of parts) {
        process.stdout.write(`  [${event.storyId}] ${line}\n`);
      }
      lineBuffers.set(event.storyId, last);
    }
  };
}

/**
 * Aggregate of skill events seen during a run. Renders into a single
 * "loom learned this run" summary block — the moment the self-learning
 * loop pays off should be visible, not buried in audit rows.
 */
export interface SkillEventTally {
  generated: string[];
  promoted: Array<{ name: string; reason: string }>;
  demoted: Array<{ name: string; reason: string }>;
  candidatesInjected: number;
}

export interface SkillEventReporter {
  printer: (event: SkillEvent) => void;
  tally: SkillEventTally;
}

/**
 * Renders skill lifecycle events alongside worker events so the operator
 * can see candidates being injected, promoted, demoted, and generated — the
 * loop is otherwise invisible. Also tallies the run so {@link renderSkillSummary}
 * can show a single "loom learned this run" block at completion.
 */
export function makeSkillEventReporter(): SkillEventReporter {
  const tally: SkillEventTally = {
    generated: [],
    promoted: [],
    demoted: [],
    candidatesInjected: 0,
  };
  const printer = (event: SkillEvent): void => {
    if (event.type === 'injected') {
      // Skip bundled/active baseline noise — these inject every run. Surface
      // only candidates and skills the operator actually wants to track.
      if (event.lifecycle === 'candidate') {
        tally.candidatesInjected += 1;
        const provenance = event.generatedFromStoryId
          ? ` (from ${event.generatedFromStoryId})`
          : '';
        console.log(
          `  + candidate skill "${event.skillName}"${provenance} canary-injected into ${event.storyId}`
        );
      }
      return;
    }
    if (event.type === 'generated') {
      tally.generated.push(event.skillName);
      console.log(
        `  ★ skill "${event.skillName}" generated (candidate) from ${event.storyId}`
      );
      return;
    }
    if (event.type === 'promoted') {
      tally.promoted.push({ name: event.skillName, reason: event.reason });
      console.log(
        `  ↑ skill "${event.skillName}" promoted: ${event.from} -> ${event.to} (${event.reason})`
      );
      return;
    }
    if (event.type === 'demoted') {
      tally.demoted.push({ name: event.skillName, reason: event.reason });
      console.log(
        `  ↓ skill "${event.skillName}" demoted: ${event.from} -> ${event.to} (${event.reason})`
      );
      return;
    }
  };
  return { printer, tally };
}

/**
 * One-block summary of what the self-learning loop did this run. Empty
 * tally returns an empty array (caller decides whether to print anything).
 * Kept pure for testability — the CLI prints these lines via console.log.
 */
export function renderSkillSummary(tally: SkillEventTally): string[] {
  const empty =
    tally.generated.length === 0 &&
    tally.promoted.length === 0 &&
    tally.demoted.length === 0;
  if (empty) return [];
  const lines: string[] = ['  loom learned this run:'];
  if (tally.generated.length > 0) {
    const names = tally.generated.map((n) => `"${n}"`).join(', ');
    lines.push(
      `    ★ ${tally.generated.length} new candidate skill${tally.generated.length === 1 ? '' : 's'} extracted: ${names}`
    );
  }
  for (const p of tally.promoted) {
    lines.push(`    ↑ "${p.name}" promoted to active — ${p.reason}`);
  }
  for (const d of tally.demoted) {
    lines.push(`    ↓ "${d.name}" demoted to disabled — ${d.reason}`);
  }
  return lines;
}

/**
 * Renders the run-end PR tail. For each processed epic that recorded an epic PR
 * URL (the finalizer's durable `epic_pr_url`), print the real URL. When no epic
 * produced a PR, fall back to the generic "run `loom status`" pointer so a
 * PR-less run (gated / skipped / failed finalize) still tells the operator
 * where to look. Pure for testability — the CLI prints each returned line.
 */
export function renderPrTail(
  epics: Array<{ id: string; epic_pr_url?: string | null }>
): string[] {
  const withUrls = epics.filter((e) => e.epic_pr_url);
  if (withUrls.length === 0) {
    return ['  Run `loom status` for per-story detail and PR links.'];
  }
  if (withUrls.length === 1) {
    return [`  PR: ${withUrls[0].epic_pr_url}`];
  }
  return [
    '  PRs:',
    ...withUrls.map((e) => `    ${e.id}: ${e.epic_pr_url}`),
  ];
}

export async function runRun(epicIds: string[], opts: RunOptions = {}): Promise<void> {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');

  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const policy = PolicyEngine.load(loomDir).policyData;
  const stallWarning = stallConfigWarning(policy);
  if (stallWarning) console.warn(`  ${stallWarning}`);

  // Fail fast on a bad cursor_model before any worker spawns. Exit only on a
  // confirmed-invalid id; an 'unavailable' probe (FR-8) or a boundary-prefix
  // alias (FR-1(b), `advisory`) is a warning that proceeds. The branch shape is
  // identical at all three call sites — the pass/fail behavior is inherited
  // from validateCursorModels, never re-derived here.
  const modelCheck = validateCursorModels(policy, opts.cursorBin);
  if (modelCheck?.status === 'invalid') {
    console.error(modelCheck.message);
    process.exit(1);
  } else if (modelCheck?.status === 'unavailable' || modelCheck?.advisory) {
    console.warn(modelCheck.message);
  }

  maybeWarnGatePreflight(projectRoot, policy);
  const db = openDatabase(loomDir);
  const skillStore = new SkillStore({ projectRoot });

  // Self-learning needs an LLM. Skip it (with a note) if the backend cannot be
  // built — skills still get injected into workers, they just are not generated.
  // policy.agents.skill_generation = 'off' is the user-facing cost knob; the
  // Supervisor honors it regardless of whether the generator is constructed.
  let skillGenerator: SkillGenerator | undefined;
  if (policy.agents.skill_generation === 'off') {
    skillGenerator = undefined;
    console.log('  (skill generation disabled by policy: skill_generation=off)');
  } else {
    try {
      // Wire the auto-propose pipeline only when policy turns it on AND
      // the operator has a sources.yaml. The proposer constructor is
      // best-effort — a malformed sources.yaml is surfaced by
      // `loom skills sync`, not silently here.
      let autoProposer: SkillProposer | undefined;
      if (policy.agents.skill_auto_propose !== 'off') {
        try {
          autoProposer = new SkillProposer({
            audit: new AuditLog(db),
          });
        } catch {
          autoProposer = undefined;
        }
      }
      skillGenerator = new SkillGenerator({
        db,
        llm: createLLMClient(policy.agents.llm_backend),
        model: modelFor(policy, 'skill_gen'),
        skillStore,
        autoProposer,
        autoProposeMode: policy.agents.skill_auto_propose,
      });
    } catch (err) {
      skillGenerator = undefined;
      console.log(`  (skill generation disabled: ${(err as Error).message})`);
    }
  }

  const skillLifecycle = new SkillLifecycle({
    skillStore,
    usageStore: new SkillUsageStore(db),
  });

  // Skill-event reporter — prints live ★/↑/↓/+ lines AND accumulates a
  // tally we render as "loom learned this run:" at completion. Visibility
  // is the whole point of the self-learning loop: the moment it pays off
  // should not be buried in audit rows.
  const skillReporter = makeSkillEventReporter();

  // Machine-level concurrency cap. When ~/.loom/config.json sets
  // max_global_workers, that wins. Otherwise we default to this supervisor's
  // own max_concurrent so several parallel `loom run`s on one machine don't
  // collectively run N × max_concurrent workers — the multi-epic shared-
  // client run's over-subscription pattern.
  const globalLimiter = createGlobalLimiter(policy.agents.max_concurrent);

  // Per-epic PR strategy: workers skip the per-story PR, and a finalizer
  // merges story branches into `epic/<id>` and opens one PR per epic. When
  // the LLM client is available the finalizer also asks PrDescriptionAgent
  // to write the PR body — falling back to the hand-rolled body on error.
  let finalizerLlm: ReturnType<typeof createLLMClient> | undefined;
  try {
    finalizerLlm = createLLMClient(policy.agents.llm_backend);
  } catch {
    finalizerLlm = undefined;
  }
  // Rolling integration is only coherent with one PR per epic — under
  // pr_strategy='per-story' each story opens its own PR, so there is no single
  // epic branch to roll into. Fall back to 'off' (with a warning) in that case.
  let integrationBranch = policy.agents.integration_branch;
  if (integrationBranch === 'rolling' && policy.agents.pr_strategy !== 'per-epic') {
    console.warn(
      "  policy.agents.integration_branch='rolling' requires pr_strategy='per-epic'; " +
        `ignoring it under pr_strategy='${policy.agents.pr_strategy}'.`
    );
    integrationBranch = 'off';
  }
  // The bounded integrator only fires on a rolling merge-back conflict, so it is
  // meaningless without the rolling branch. Disable it (with a warning) if the
  // operator turned it on without rolling.
  let integrator = policy.agents.integrator;
  if (integrator === 'on' && integrationBranch !== 'rolling') {
    console.warn(
      "  policy.agents.integrator='on' requires integration_branch='rolling'; " +
        'ignoring it.'
    );
    integrator = 'off';
  }

  const epicFinalizer = new EpicFinalizer({
    projectRoot,
    db,
    allowedRemotes: policy.git.allowed_remotes,
    prStrategy: policy.agents.pr_strategy,
    llmClient: finalizerLlm,
    llmModel: policy.agents.model,
    prAttribution: policy.agents.pr_attribution,
    pushGate: policy.agents.push_gate,
    integrationGate: policy.agents.integration_gate,
    testCommand: policy.agents.test_command,
    integrationBranch,
    // Late-bound policy rebind — mirrors the MCP `buildDispatchSupervisor`.
    // At finalize entry, re-read the late-bound fields from disk so a
    // mid-run edit to .loom/policy.yaml (the postmortem scenario: operator
    // fills in `allowed_remotes` after approve) actually takes effect. Do
    // NOT catch a PolicyEngine.load failure here — EpicFinalizer.rebindLatebound
    // already wraps the call in try/catch and treats a throw as a no-op.
    refreshPolicy: () => {
      const live = PolicyEngine.load(loomDir).policyData;
      return {
        allowedRemotes: live.git.allowed_remotes,
        testCommand: live.agents.test_command,
        integrationGate: live.agents.integration_gate,
        pushGate: live.agents.push_gate,
        prAttribution: live.agents.pr_attribution,
      };
    },
  });

  // Code reviewer — best-effort. Defaults to the worker's LLM/model so
  // reviewer == worker brain; flips to a separate Cursor-CLI session
  // targeting policy.agents.review_model_id when review_model='cross'.
  // Both paths stay session-based (claude-cli or cursor-cli).
  let reviewAgent: CodeReviewAgent | undefined;
  let reviewerLlm: ReturnType<typeof createLLMClient> | undefined;
  if (policy.agents.review_strategy !== 'off') {
    try {
      const cross =
        policy.agents.review_model === 'cross' && policy.agents.review_model_id;
      // Reviewer wall-clock — wire policy.agents.review_timeout_minutes so
      // large-diff reviews don't silently time out at the hardcoded 10-min
      // ClaudeCliClient default. Mirrors the MCP path.
      const reviewerTimeoutMs = policy.agents.review_timeout_minutes * 60_000;
      reviewerLlm = cross
        ? undefined
        : createLLMClient(policy.agents.llm_backend, { timeoutMs: reviewerTimeoutMs });
      reviewAgent = new CodeReviewAgent({
        projectRoot,
        llm: cross
          ? new CursorCliClient({ timeoutMs: reviewerTimeoutMs })
          : reviewerLlm!,
        model: cross ? policy.agents.review_model_id! : policy.agents.model,
      });
    } catch (err) {
      reviewAgent = undefined;
      reviewerLlm = undefined;
      console.log(`  (code review disabled: ${(err as Error).message})`);
    }
  }

  // Register LLM-backed reviewer skills when the Review Forge path is active.
  // Must be called before the first reviewer invocation (ADR-001 ordering).
  if (policy.agents.review_strategy === 'block-and-revise' && reviewerLlm) {
    registerReviewerSkills({
      llm: reviewerLlm,
      model: policy.agents.model,
      projectRoot,
    });
  }

  // Build worker options as a named variable so TypeScript's structural typing
  // allows the epic-030 fields (hungRequestMs, declared by story-030-002 on
  // WorkerFactoryOptions) to pass through without excess-property errors.
  const workerOpts = {
    backend: policy.agents.worker_backend,
    allowedRemotes: policy.git.allowed_remotes,
    cursorModel: policy.agents.cursor_model,
    model: policy.agents.model,
    prStrategy: policy.agents.pr_strategy,
    reviewAgent,
    reviewStrategy: policy.agents.review_strategy,
    reviewReviseTrigger: policy.agents.review_revise_trigger,
    maxReviewRevisions: policy.agents.review_max_passes,
    budgetTokensPerStory: policy.agents.budget_tokens_per_story,
    operatorGuidance: policy.agents.operator_guidance,
    sharedContract: policy.agents.shared_contract,
    contextNotes: policy.agents.context_notes,
    stallMs: policy.agents.story_stall_minutes * 60_000,
    absoluteCapMs: policy.agents.story_absolute_cap_minutes * 60_000,
    // epic-030: tighter hung-request bound; seconds→ms (story-030-002 consumes)
    hungRequestMs: policy.agents.hung_request_seconds * 1000,
    phases: policy.agents.phases,
    workerAuth: policy.agents.worker_auth,
    adaptiveCost: policy.agents.adaptive_cost,
    db,
    llm: reviewerLlm,
  };

  // Build supervisor options as a named variable so the epic-030 field
  // (autoResumeAttempts, declared by story-030-003 on SupervisorOptions) passes
  // through TypeScript's structural typing without excess-property errors.
  const supervisorOpts = {
    projectRoot,
    db,
    worker: createWorker(workerOpts),
    maxConcurrent: policy.agents.max_concurrent,
    skillStore,
    skillGenerator,
    skillLifecycle,
    checkpoint: opts.checkpoint,
    globalLimiter,
    onWorkerEvent: makeEventPrinter({ verbose: opts.verbose === true }),
    onSkillEvent: skillReporter.printer,
    skillGenerationMode: policy.agents.skill_generation,
    epicFinalizer,
    watchdog: {
      enabled: policy.agents.analysis_only_watchdog === 'on',
    },
    integrationBranch,
    integrator,
    testCommand: policy.agents.test_command,
    contextNotes: policy.agents.context_notes,
    // Late-bound rebind for the integrator's gate — mirrors MCP. A mid-run
    // edit to `policy.agents.test_command` changes which command
    // `attemptIntegratorRecovery` re-runs to validate its resolution. The
    // Supervisor wraps this call in try/catch, so do NOT swallow throws here.
    refreshIntegratorPolicy: () => ({
      testCommand: PolicyEngine.load(loomDir).policyData.agents.test_command,
    }),
    workerModel:
      policy.agents.worker_backend === 'cursor-cli'
        ? policy.agents.cursor_model
        : policy.agents.model,
    // epic-030: auto-resume cap (raw count, not ms; story-030-003 consumes)
    autoResumeAttempts: policy.agents.auto_resume_attempts,
  };

  const supervisor = new Supervisor(supervisorOpts);

  const target = epicIds.length > 0 ? epicIds.join(', ') : 'all approved epics';
  console.log(`\n  Dispatching story agents for ${target}.`);
  if (opts.checkpoint) {
    console.log(`  Checkpoint mode: will pause after the next ${opts.checkpoint}.`);
  }
  console.log(
    `  Up to ${policy.agents.max_concurrent} run concurrently. ` +
      'Track with `loom status`; stop anytime with `loom stop`.'
  );
  if (globalLimiter) {
    console.log(
      `  Machine-wide cap: ${globalLimiter.capacity} workers across all loom runs.`
    );
  }
  console.log('');

  // Cross-epic overlap advisory at dispatch start (FR-7). Warns about files a
  // to-be-dispatched epic shares with another in-flight epic's contract; never
  // blocks the run. Suppressed on a chained approve→run, which already printed
  // it at approve time. Targets: the explicit ids, else every approved epic
  // the supervisor is about to pick up.
  if (!opts.suppressOverlap) {
    const advisoryTargets =
      epicIds.length > 0
        ? epicIds
        : new EpicStore(db).listByStatus('approved').map((e) => e.id);
    for (const id of advisoryTargets) {
      printOverlapAdvisory(projectRoot, id);
    }
  }

  let result;
  try {
    result = await supervisor.run(epicIds.length > 0 ? epicIds : undefined);
  } catch (err) {
    console.error('  Supervisor failed:', (err as Error).message);
    globalLimiter?.close();
    process.exit(1);
  }
  globalLimiter?.close();

  if (result.epicsProcessed.length === 0) {
    console.log('  No approved epics to run. Approve a plan first: `loom approve`.');
    if (result.epicsSkipped.length > 0) {
      console.log(`  Skipped (not approved / not found): ${result.epicsSkipped.join(', ')}`);
    }
    return;
  }

  console.log(`  Epics processed: ${result.epicsProcessed.join(', ')}`);
  if (result.epicsSkipped.length > 0) {
    console.log(`  Skipped: ${result.epicsSkipped.join(', ')}`);
  }
  console.log('');
  console.log(`  Stories: ${result.storiesTotal} total`);
  console.log(`    done:    ${result.storiesDone}`);
  console.log(`    failed:  ${result.storiesFailed}`);
  console.log(`    blocked: ${result.storiesBlocked}`);
  if (result.storiesPending > 0) {
    console.log(`    pending: ${result.storiesPending}`);
  }
  console.log('');
  if (result.halted) {
    console.log(
      `  Halted early with ${result.storiesPending} story(ies) pending — ` +
        'review, then continue with `loom run`.'
    );
  }
  // "loom learned this run" — only printed if the self-learning loop
  // actually did something this run. Silence when there's nothing to say.
  const skillSummaryLines = renderSkillSummary(skillReporter.tally);
  for (const line of skillSummaryLines) {
    console.log(line);
  }
  if (skillSummaryLines.length > 0) {
    console.log('');
  }
  // Read the persisted epic PR URL of record per processed epic (ADR-7 —
  // don't widen SupervisorRunResult; one extra EpicStore.get() per epic at run
  // end is negligible). For PR-producing runs the tail prints the actual URL
  // instead of the generic "run loom status for PR links" fallback.
  const epicStore = new EpicStore(db);
  const processedEpics = result.epicsProcessed.map((id) => {
    const row = epicStore.get(id);
    return { id, epic_pr_url: row?.epic_pr_url ?? null };
  });
  for (const line of renderPrTail(processedEpics)) {
    console.log(line);
  }
  console.log('');
}

export const spec: CommandDescription = {
  name: 'run',
  summary: 'Dispatch story agents for approved epics',
  whenToUse: 'Use after approving an epic to start the supervisor and dispatch worker agents for each story. Omit epic ids to run all approved epics.',
  arguments: [
    { name: 'epic-ids', type: 'string', required: false, description: 'Specific epic ids to run; omit to run all approved epics' },
  ],
  options: [
    { name: '--checkpoint', type: 'enum', description: 'Pause after the next "story" or "epic" boundary instead of running to completion', changesOutputShape: false },
    { name: '--verbose', type: 'boolean', description: 'Stream live worker stdout/stderr to the terminal', changesOutputShape: false },
  ],
  output: { text: 'Real-time progress of story dispatch, completion, and PR links' },
  examples: [
    { command: 'loom run', description: 'Dispatch all approved epics' },
    { command: 'loom run epic-001', description: 'Dispatch only epic-001' },
    { command: 'loom run epic-001 --checkpoint story', description: 'Pause after each story completes' },
    { command: 'loom run --verbose', description: 'Stream worker output to the terminal' },
  ],
  exitCodes: [
    { code: 0, meaning: 'All stories dispatched and completed' },
    { code: 1, meaning: 'No approved epics, invalid arguments, or supervisor error' },
  ],
  errors: ['No approved epics to run', '--checkpoint must be "story" or "epic"', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['approve'], nextSteps: ['status', 'stop', 'retry'] },
};
