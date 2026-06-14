import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {
  PolicyEngine,
  openDatabase,
  createDatabase,
  EpicStore,
  AgentStore,
  AuditLog,
  DecisionTraceStore,
  ProjectRegistry,
  Planner,
  derivePlaceholderTitle,
  Supervisor,
  SkillStore,
  SkillGenerator,
  SkillLifecycle,
  SkillProposer,
  SkillUsageStore,
  modelFor,
  createGlobalLimiter,
  EpicFinalizer,
  EpicReverter,
  EpicReconciler,
  OperatorGuidance,
  CodeReviewAgent,
  BriefRefiner,
  evaluateBriefGate,
  StoryRetryService,
  AutonomyLevelSchema,
  setEpicAutonomy,
  EpicNotFoundError,
  runScan,
  LessonStore,
  OpportunityStore,
  proposeNextEpic,
  deriveBlocked,
} from '@loom-ai/core';
import type { ToolContext, ToolHandler } from './context.js';

const execFileP = promisify(execFile);

type LoadedPolicy = ReturnType<typeof PolicyEngine.load>['policyData'];

/**
 * Builds a fully-wired Supervisor + its global limiter for a background
 * dispatch. Shared by loom_approve_plan (first dispatch) and loom_retry_story
 * (re-dispatch) so the worker / skill / finalizer / reviewer wiring lives in
 * one place. Caller is responsible for `globalLimiter?.close()` after run().
 */
function buildDispatchSupervisor(
  ctx: ToolContext,
  db: ReturnType<typeof openDatabase>,
  policy: LoadedPolicy
): { supervisor: Supervisor; globalLimiter: ReturnType<typeof createGlobalLimiter> } {
  const skillStore = new SkillStore({ projectRoot: ctx.projectRoot });

  // Skill generation needs an LLM — wire it only if the backend builds AND the
  // policy hasn't disabled the loop.
  let skillGenerator: SkillGenerator | undefined;
  if (policy.agents.skill_generation !== 'off') {
    try {
      let autoProposer;
      if (policy.agents.skill_auto_propose !== 'off') {
        try {
          autoProposer = new SkillProposer({ audit: new AuditLog(db) });
        } catch {
          autoProposer = undefined;
        }
      }
      skillGenerator = new SkillGenerator({
        db,
        llm: ctx.createLLM(policy.agents.llm_backend),
        model: modelFor(policy, 'skill_gen'),
        skillStore,
        autoProposer,
        autoProposeMode: policy.agents.skill_auto_propose,
      });
    } catch {
      skillGenerator = undefined;
    }
  }

  const skillLifecycle = new SkillLifecycle({
    skillStore,
    usageStore: new SkillUsageStore(db),
  });

  // Default the machine-wide cap to the per-supervisor max_concurrent when
  // ~/.loom/config.json doesn't set max_global_workers — protects against
  // M concurrent supervisors collectively running M × max_concurrent workers
  // and exhausting the developer's Claude/Cursor session capacity.
  const globalLimiter = createGlobalLimiter(policy.agents.max_concurrent);
  let finalizerLlm;
  try {
    finalizerLlm = ctx.createLLM(policy.agents.llm_backend);
  } catch {
    finalizerLlm = undefined;
  }
  // Rolling integration is only coherent with one PR per epic; under
  // pr_strategy='per-story' there is no single epic branch to roll into.
  let integrationBranch = policy.agents.integration_branch;
  if (integrationBranch === 'rolling' && policy.agents.pr_strategy !== 'per-epic') {
    console.warn(
      "policy.agents.integration_branch='rolling' requires pr_strategy='per-epic'; " +
        `ignoring it under pr_strategy='${policy.agents.pr_strategy}'.`
    );
    integrationBranch = 'off';
  }
  // The bounded integrator only fires on a rolling merge-back conflict.
  let integrator = policy.agents.integrator;
  if (integrator === 'on' && integrationBranch !== 'rolling') {
    console.warn(
      "policy.agents.integrator='on' requires integration_branch='rolling'; ignoring it."
    );
    integrator = 'off';
  }

  const epicFinalizer = new EpicFinalizer({
    projectRoot: ctx.projectRoot,
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
    // Late-bound policy refresh — at finalize() entry the EpicFinalizer
    // re-reads these fields from disk so mid-run edits to .loom/policy.yaml
    // actually take effect (and emit an epic_policy_rebound audit row when
    // they do). Fixes the epic-008 case: empty allowed_remotes at approve
    // → PR never opened, even after the operator hardened the policy.
    // Honors the documented throw-vs-{} contract on
    // `LateboundFinalizerPolicy` — let `PolicyEngine.load` throw rather
    // than returning `{}`; the finalizer's `rebindLatebound` already wraps
    // this call in try/catch and treats a throw as a no-op (preserves the
    // current effective values). Returning `{}` would risk skipping legit
    // rebinds on a transient YAML parse error.
    refreshPolicy: () => {
      const live = PolicyEngine.load(ctx.loomDir).policyData;
      return {
        allowedRemotes: live.git.allowed_remotes,
        testCommand: live.agents.test_command,
        integrationGate: live.agents.integration_gate,
        pushGate: live.agents.push_gate,
        prAttribution: live.agents.pr_attribution,
      };
    },
  });

  let reviewAgent: CodeReviewAgent | undefined;
  if (policy.agents.review_strategy !== 'off') {
    try {
      const cross =
        policy.agents.review_model === 'cross' && policy.agents.review_model_id;
      // Reviewer timeout (PR 2.3): wire policy.agents.review_timeout_minutes
      // into the LLM client. The default 10-min ClaudeCliClient timeout
      // silently shipped large story diffs unreviewed (story-007-003 in the
      // multi-epic shared-client run); raising it here lets operators stop
      // that without recompiling.
      const reviewerTimeoutMs = policy.agents.review_timeout_minutes * 60_000;
      reviewAgent = new CodeReviewAgent({
        projectRoot: ctx.projectRoot,
        llm: cross
          ? ctx.createLLM('cursor-cli', { timeoutMs: reviewerTimeoutMs })
          : ctx.createLLM(policy.agents.llm_backend, { timeoutMs: reviewerTimeoutMs }),
        model: cross ? policy.agents.review_model_id! : policy.agents.model,
      });
    } catch {
      reviewAgent = undefined;
    }
  }

  const supervisor = new Supervisor({
    projectRoot: ctx.projectRoot,
    db,
    worker: ctx.createWorker({
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
      phases: policy.agents.phases,
      workerAuth: policy.agents.worker_auth,
    }),
    maxConcurrent: policy.agents.max_concurrent,
    skillStore,
    skillGenerator,
    skillLifecycle,
    skillGenerationMode: policy.agents.skill_generation,
    globalLimiter,
    epicFinalizer,
    watchdog: {
      enabled: policy.agents.analysis_only_watchdog === 'on',
    },
    integrationBranch,
    integrator,
    testCommand: policy.agents.test_command,
    contextNotes: policy.agents.context_notes,
    // Late-bound rebind for the integrator's gate — mirrors the EpicFinalizer's
    // refreshPolicy. A mid-run edit to `policy.agents.test_command` now also
    // changes which command `attemptIntegratorRecovery` runs to validate its
    // resolution (the EpicFinalizer fix above only covered finalize-time).
    // Note: do NOT catch a `PolicyEngine.load` failure here. The Supervisor's
    // `rebindIntegratorGateIfChanged` already wraps the call in try/catch and
    // treats a throw as a no-op (preserves the current command). Returning
    // `{}` instead would compare an `undefined` testCommand against the
    // effective value and silently clear a configured command on a transient
    // YAML parse error.
    refreshIntegratorPolicy: () => ({
      testCommand: PolicyEngine.load(ctx.loomDir).policyData.agents.test_command,
    }),
  });

  return { supervisor, globalLimiter };
}

/** loom_policy_check — validate a shell command against the guardrail policy. */
const policyCheck: ToolHandler = async (ctx, args) => {
  const command = String(args.command ?? '');
  const engine = PolicyEngine.load(ctx.loomDir);
  return engine.check(command);
};

/** Audit actions that mark a worker as approaching (or hitting) a deadline. */
const STALL_ACTIONS = ['worker_timeout_warn', 'worker_watchdog_warn'];

/**
 * Derives a running story's stall reason from its most recent timeout/watchdog
 * warning, or undefined if it has none. The reason ('stall' | 'cap' | 'budget'
 * | 'analysis-only') comes from the audit row's JSON detail.
 */
function stallInfo(audit: AuditLog, agentId: string): string | undefined {
  const row = audit.latestActionForAgent(agentId, STALL_ACTIONS);
  if (!row) return undefined;
  if (row.action === 'worker_watchdog_warn') return 'analysis-only';
  try {
    const detail = row.detail ? JSON.parse(row.detail) : {};
    return typeof detail.reason === 'string' ? detail.reason : 'stall';
  } catch {
    return 'stall';
  }
}

/**
 * For an agent currently in the transient 'integrating' state, return the
 * current bounded-integrator attempt number and the elapsed seconds since
 * that attempt started. Filtered by AGENT_ID rather than story_id — every
 * retry of a story creates a fresh agent_id (`agent-<storyId>-<hash>`), so
 * scoping to the current agent's audit rows guarantees the metadata reflects
 * THIS integrator episode and not a leftover row from a prior failed run
 * on the same story. Returns undefined for clean-merge integrations (no
 * recovery attempt row was written under this agent_id).
 */
function integratorProgress(
  audit: AuditLog,
  agentId: string
): { attempt_number: number; elapsed_seconds: number } | undefined {
  const row = audit.latestActionForAgent(agentId, ['epic_integration_attempt']);
  if (!row) return undefined;
  let attempt: number | undefined;
  try {
    const detail = row.detail ? JSON.parse(row.detail) : {};
    if (typeof detail.attempt === 'number') attempt = detail.attempt;
  } catch {
    // ignore — fall through
  }
  const startedMs = Date.parse(row.timestamp);
  const elapsed = Number.isFinite(startedMs)
    ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
    : 0;
  return { attempt_number: attempt ?? 1, elapsed_seconds: elapsed };
}

/**
 * loom_get_status — epic + per-story agent status tree.
 *
 * Federates across every loom-init'ed repo on the machine by default so a
 * chat client asking "what is loom doing right now?" gets every active
 * run, not just the one rooted at the invoking project. Each epic
 * carries `project_name` / `project_root` attribution. Filters:
 *
 *   - `epic_id`  — narrow to one epic; searches the current project
 *                  first, then peers (first match wins).
 *   - `project`  — absolute path of a registered project; scopes the
 *                  response to just that project.
 *
 * Backwards-compatible: the shape is a superset of the previous one
 * (status + stories preserved; project attribution added).
 */
const getStatus: ToolHandler = async (ctx, args) => {
  const epicIdFilter = args.epic_id ? String(args.epic_id) : null;
  const projectFilter = args.project ? String(args.project) : null;
  const includeArchived = args.include_archived === true;
  // Breaking default change (v0.6): scope to the current project unless the
  // caller explicitly opts into machine-wide federation. `project` (a single
  // explicit root) still takes precedence and is unaffected.
  const allProjects = args.all_projects === true;

  const renderEpic = (
    epic: ReturnType<EpicStore['get']> | NonNullable<ReturnType<EpicStore['get']>>,
    agentStore: AgentStore,
    auditStore: AuditLog,
    projectRoot: string,
    isCurrent: boolean
  ) => {
    if (!epic) return null;
    // Group by story_id so a retry doesn't double-render a story (old
    // failed attempt PLUS new successful one). Older attempts are still
    // surfaced via a `history` array per story.
    const latest = agentStore.listLatestByEpic(epic.id);
    const stories = latest.map((a) => {
      const history = agentStore
        .listHistoryByStory(a.story_id)
        .filter((h) => h.id !== a.id);
      const allAttempts = [a, ...history];
      // Sum cost + request count across every attempt — a retry's spend is
      // additive, not replaced by the latest attempt's figures.
      const totalCostUsd = allAttempts.reduce(
        (s, r) => s + (r.cost_usd ?? 0),
        0
      );
      const totalRequests = allAttempts.reduce(
        (s, r) => s + (r.request_count ?? 0),
        0
      );
      const stall = a.status === 'running' ? stallInfo(auditStore, a.id) : undefined;
      const integrator =
        a.status === 'integrating' ? integratorProgress(auditStore, a.id) : undefined;
      return {
        id: a.story_id,
        title: a.story_title ?? a.story_id,
        status: a.status,
        ...(a.worktree_path ? { worktree_path: a.worktree_path } : {}),
        ...(a.branch_name ? { branch_name: a.branch_name } : {}),
        ...(a.worker_pid ? { worker_pid: a.worker_pid } : {}),
        ...(a.pr_url ? { pr_url: a.pr_url } : {}),
        ...(a.started_at ? { started_at: a.started_at } : {}),
        ...(a.log_tail ? { log_tail: a.log_tail } : {}),
        ...(a.review_status ? { review_status: a.review_status } : {}),
        ...(a.review_summary ? { review_summary: a.review_summary } : {}),
        ...(stall ? { stalled: true, stall_reason: stall } : {}),
        ...(integrator ? { integrator } : {}),
        ...(totalCostUsd > 0 ? { total_cost_usd: totalCostUsd } : {}),
        ...(totalRequests > 0 ? { total_requests: totalRequests } : {}),
        ...(history.length > 0
          ? {
              history: history.map((h) => ({
                id: h.id,
                status: h.status,
                updated_at: h.updated_at,
                ...(h.cost_usd != null ? { cost_usd: h.cost_usd } : {}),
                ...(h.request_count != null ? { request_count: h.request_count } : {}),
              })),
            }
          : {}),
      };
    });
    // Epic-level totals: worker spend + planner spend. Planner request count
    // covers Analyst+PM+Architect plus shared_contract/qa_planning calls.
    const workerCostUsd = stories.reduce(
      (s, st) => s + (st.total_cost_usd ?? 0),
      0
    );
    const workerRequests = stories.reduce(
      (s, st) => s + (st.total_requests ?? 0),
      0
    );
    const plannerRequests = epic.planner_request_count ?? 0;
    const epicTotalCostUsd = workerCostUsd;
    const epicTotalRequests = workerRequests + plannerRequests;
    return {
      id: epic.id,
      title: epic.title,
      status: epic.status,
      // ADR-1 symmetric overlays — surface the live phase only while its status
      // is active, so a planning epic never leaks finalize_phase and vice versa.
      ...(epic.status === 'planning' && epic.planning_phase
        ? { planning_phase: epic.planning_phase }
        : {}),
      ...(epic.status === 'finalizing' && epic.finalize_phase
        ? { finalize_phase: epic.finalize_phase }
        : {}),
      // Gate-blocked indicator: present only for in_progress + gate.
      ...(deriveBlocked(epic) ?? {}),
      // The epic PR URL of record, once the finalizer has recorded it.
      ...(epic.epic_pr_url ? { epic_pr_url: epic.epic_pr_url } : {}),
      // Runtime failure message — present only for a 'failed' epic.
      ...(epic.status === 'failed' && epic.error ? { error: epic.error } : {}),
      ...(epic.archived_at ? { archived: true } : {}),
      project_name: path.basename(projectRoot),
      project_root: projectRoot,
      is_current_project: isCurrent,
      ...(epicTotalCostUsd > 0 ? { total_cost_usd: epicTotalCostUsd } : {}),
      ...(epicTotalRequests > 0 ? { total_requests: epicTotalRequests } : {}),
      ...(plannerRequests > 0 ? { planner_request_count: plannerRequests } : {}),
      stories,
    };
  };

  const out: ReturnType<typeof renderEpic>[] = [];

  const scanProject = (loomDir: string, projectRoot: string, isCurrent: boolean) => {
    let db;
    let owns = false;
    try {
      if (isCurrent) {
        // Current project uses the shared (singleton) connection. We don't
        // own its lifecycle — leave the cleanup to whoever opened it.
        db = openDatabase(loomDir);
      } else {
        // Peer projects MUST use a fresh non-singleton connection so we
        // don't accidentally alias-then-close the current-project DB.
        db = createDatabase(path.join(loomDir, 'loom.db'));
        owns = true;
      }
    } catch {
      return;
    }
    try {
      const epicStore = new EpicStore(db);
      const agentStore = new AgentStore(db);
      const auditStore = new AuditLog(db);
      if (epicIdFilter) {
        const e = epicStore.get(epicIdFilter);
        if (e) out.push(renderEpic(e, agentStore, auditStore, projectRoot, isCurrent));
      } else {
        for (const e of epicStore.list({ includeArchived })) {
          out.push(renderEpic(e, agentStore, auditStore, projectRoot, isCurrent));
        }
      }
    } finally {
      if (owns) {
        try { db.close(); } catch {}
      }
    }
  };

  if (projectFilter) {
    // Scoped lookup: only the requested project.
    const known = new ProjectRegistry().list();
    const entry = known.find((p) => p.root === projectFilter);
    if (!entry) return { status: 'error', message: `Project not registered: ${projectFilter}` };
    const isCurrent = entry.root === ctx.projectRoot;
    scanProject(path.join(entry.root, '.loom'), entry.root, isCurrent);
  } else {
    // Default: the current project only. Federation across registered peers
    // is opt-in via all_projects:true (the pre-v0.6 default behavior).
    scanProject(ctx.loomDir, ctx.projectRoot, true);
    if (allProjects) {
      const peers = new ProjectRegistry().list().filter((p) => p.root !== ctx.projectRoot);
      for (const peer of peers) {
        const peerLoomDir = path.join(peer.root, '.loom');
        if (!fs.existsSync(peerLoomDir)) continue;
        scanProject(peerLoomDir, peer.root, false);
      }
    }
  }

  // Sort: current project first, then by updated semantics not available
  // here — fall back to insertion order which already puts current first.
  return { epics: out.filter((e) => e != null) };
};

/** loom_get_audit_log — recent audit entries, optionally scoped to an agent
 *  or a story. `story_id` matches across every retry attempt (each retry has
 *  a fresh `agent-<story>-<hash>` id) AND picks up rolling-integrator rows
 *  whose `command` is the story id with no agent_id attached. */
const getAuditLog: ToolHandler = async (ctx, args) => {
  const db = openDatabase(ctx.loomDir);
  const audit = new AuditLog(db);
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  let entries;
  if (args.story_id) {
    entries = audit.getByStory(String(args.story_id), limit ?? 50);
  } else if (args.agent_id) {
    entries = audit.getByAgent(String(args.agent_id), limit ?? 50);
  } else {
    entries = audit.recent(limit ?? 20);
  }
  return { entries };
};

/** loom_start_epic — run the planning pipeline (blocks until planned). */
const startEpic: ToolHandler = async (ctx, args) => {
  const brief = String(args.brief ?? '');
  if (brief.trim().length < 10) {
    return { status: 'error', message: 'brief must be at least a sentence' };
  }
  const force = args.force === true;

  const policy = PolicyEngine.load(ctx.loomDir).policyData;

  let llm;
  try {
    llm = ctx.createLLM(policy.agents.llm_backend);
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }

  // Brief-quality gate. Always runs — refuses briefs scoring below
  // policy.agents.min_brief_quality_score so the planner never spends
  // tokens on something underspecified. The structured critique gives
  // the chat client what it needs to walk the user through tightening
  // the brief. With force: true the gate decision is overridden for this
  // call only; the refiner still runs and its critique is audit-logged.
  const refiner = new BriefRefiner({
    projectRoot: ctx.projectRoot,
    llm,
    model: modelFor(policy, 'planning'),
  });
  const refinement = await refiner.refine(brief);
  const min = policy.agents.min_brief_quality_score;
  const verdict = evaluateBriefGate(refinement, min);
  if (!verdict.pass && !force) {
    return {
      status: 'rejected',
      reason: 'brief_quality_below_threshold',
      ready: verdict.ready,
      quality_score: refinement.quality_score,
      min_quality_score: min,
      critique: refinement.critique,
      questions: refinement.questions,
      refined_brief: refinement.refined_brief,
      message:
        `Brief scored ${refinement.quality_score}/10 (need >= ${min}). ` +
        `Walk the user through the questions and re-call loom_start_epic ` +
        `with a tightened brief. The threshold is set per repo via ` +
        `policy.agents.min_brief_quality_score.`,
    };
  }

  // Planner skill injection is OFF by design — curation lives at the
  // orchestrator (pi-as-Claude via loom-skill-curator), not the planner.
  // See packages/loom-cli/src/commands/epic.ts for the rationale.
  const db = openDatabase(ctx.loomDir);

  const forcedPastGate = !verdict.pass && force;
  if (forcedPastGate) {
    // Forced past a gate rejection. Record the override — with the full
    // critique embedded — BEFORE the planner runs (ordering invariant /
    // NFR-2). The synchronous better-sqlite3 insert guarantees durability
    // ahead of any planner work.
    new AuditLog(db).record({
      action: 'brief_gate_forced',
      command: brief.slice(0, 120),
      allowed: true,
      detail: {
        entry_point: 'mcp',
        ready: verdict.ready,
        quality_score: verdict.quality_score,
        threshold: verdict.threshold,
        critique: refinement.critique,
        questions: refinement.questions,
      },
    });
  }

  // In-process continuation (story-005-004): fire the planner and return the
  // reserved epic id within seconds rather than blocking for the full
  // Analyst → PM → Architect chain (~minutes). We reserve the row HERE, at the
  // single allocation site, then hand the id to the planner as `reservedId` so
  // it adopts it rather than self-allocating a second time (epic-007 / FR-5:
  // one `nextEpicId` per submission). The synchronous better-sqlite3 inserts
  // make the row durable before this handler returns, so the id we report is
  // already a 'planning' row — immediately re-attachable via loom_get_status /
  // `loom status`. The planning work continues in this process via
  // ctx.background.
  //
  // Trade-off (the honest state): because the continuation is in-process and
  // detached, a process exit before planning completes leaves the epic in
  // 'planning' — not silently 'planned' or 'failed'. A crash inside the
  // planner lands the epic as 'failed' with a retrievable error message
  // (see Planner.run's catch → EpicStore.fail). story-006 tracks moving this
  // continuation to a durable out-of-process runner.
  const runId = Planner.nextEpicId(db);
  const epicStore = new EpicStore(db);
  epicStore.beginPlanning(runId, brief);
  epicStore.setTitle(runId, derivePlaceholderTitle(brief));
  const planning = new Planner({
    projectRoot: ctx.projectRoot,
    llm,
    model: modelFor(policy, 'planning'),
    db,
    sharedContract: policy.agents.shared_contract === 'on',
    qaPlanning: policy.agents.qa_planning === 'advisory',
  }).run(brief, runId);
  ctx.background(`plan ${runId}`, planning);

  return {
    status: 'planning',
    ...(forcedPastGate ? { forced: true } : {}),
    run_id: runId,
    epic_ids: [runId],
    message:
      `Planning started for ${runId} and continues in the background. ` +
      `Poll loom_get_status (or run \`loom status\`) to watch it advance ` +
      `through the planning phases; once it reaches 'planned', review the ` +
      `artifacts and call loom_approve_plan.`,
  };
};

/**
 * loom_approve_plan — approve a planned epic and kick off story dispatch in
 * the background. Returns immediately; the client polls loom_get_status.
 */
const approvePlan: ToolHandler = async (ctx, args) => {
  const epicId = String(args.epic_id ?? '');
  const db = openDatabase(ctx.loomDir);
  const epicStore = new EpicStore(db);

  const epic = epicStore.get(epicId);
  if (!epic) {
    return { status: 'error', message: `Epic "${epicId}" not found` };
  }
  if (epic.status !== 'planned') {
    return {
      status: 'error',
      message: `Epic "${epicId}" is "${epic.status}", not "planned"`,
    };
  }

  const policy = PolicyEngine.load(ctx.loomDir).policyData;
  // Persist the full snapshot BEFORE we transition to 'approved' so a crash
  // mid-approve never leaves an approved epic with no recorded snapshot.
  // The supervisor diffs against this at finalize/integrate to detect
  // mid-run edits to late-bound fields and emits epic_policy_rebound rows.
  try {
    epicStore.setPolicySnapshot(epicId, JSON.stringify(policy));
  } catch {
    // Snapshot persistence is observability — never block approve on it.
  }
  epicStore.updateStatus(epicId, 'approved');

  const { supervisor, globalLimiter } = buildDispatchSupervisor(ctx, db, policy);

  ctx.background(
    `dispatch ${epicId}`,
    supervisor.run([epicId]).finally(() => globalLimiter?.close())
  );

  return {
    status: 'dispatching',
    epic_id: epicId,
    message: 'Epic approved. Story agents are dispatching — poll loom_get_status.',
  };
};

/** loom_reject_plan — reject a planned epic. */
const rejectPlan: ToolHandler = async (ctx, args) => {
  const epicId = String(args.epic_id ?? '');
  const reason = args.reason ? String(args.reason) : undefined;
  const db = openDatabase(ctx.loomDir);
  const epicStore = new EpicStore(db);

  const epic = epicStore.get(epicId);
  if (!epic) {
    return { status: 'error', message: `Epic "${epicId}" not found` };
  }
  if (epic.status !== 'planned') {
    return {
      status: 'error',
      message: `Epic "${epicId}" is "${epic.status}", not "planned"`,
    };
  }

  epicStore.updateStatus(epicId, 'rejected', reason);
  return { status: 'rejected', epic_id: epicId };
};

/**
 * loom_stop_agent — cancel ONE running worker by story id. Looks up the
 * agent's stored worker_pid and sends SIGTERM directly; the Supervisor sees
 * the worker exit normally and records it as failed with a "cancelled by
 * user" summary. Safe to call from any process — works whether the
 * Supervisor runs in this process or a separate `loom run`.
 */
const stopAgent: ToolHandler = async (ctx, args) => {
  const storyId = String(args.story_id ?? '');
  if (!storyId) {
    return { status: 'error', message: 'story_id is required' };
  }
  const reason = args.reason ? String(args.reason) : 'cancelled by user';

  const db = openDatabase(ctx.loomDir);
  const agentStore = new AgentStore(db);
  const audit = new AuditLog(db);
  const agent = agentStore.getByStory(storyId);

  if (!agent) {
    return { status: 'error', message: `No agent for story "${storyId}"` };
  }
  if (agent.status !== 'running') {
    return {
      status: 'noop',
      story_id: storyId,
      agent_status: agent.status,
      message: `Agent for "${storyId}" is "${agent.status}", not running.`,
    };
  }
  if (!agent.worker_pid) {
    return {
      status: 'error',
      story_id: storyId,
      message: 'Agent is running but no worker_pid recorded — cannot target the child process.',
    };
  }

  try {
    process.kill(agent.worker_pid, 'SIGTERM');
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'worker process already gone'
      : (err as Error).message;
    audit.record({
      agent_id: agent.id,
      action: 'stop_agent',
      command: storyId,
      allowed: false,
      detail: { reason, error: msg },
    });
    return { status: 'error', story_id: storyId, message: msg };
  }

  audit.record({
    agent_id: agent.id,
    action: 'stop_agent',
    command: storyId,
    allowed: true,
    detail: { reason, pid: agent.worker_pid },
  });

  return {
    status: 'stopping',
    story_id: storyId,
    pid: agent.worker_pid,
    message: `SIGTERM sent to worker for ${storyId}; it will report as failed.`,
  };
};

/**
 * loom_guide_agent — append a guidance message a running (or pending)
 * worker will read at story-start / on revision. Operator side-channel
 * for soft-lock recovery and mid-run steering. Requires the project's
 * policy to set agents.operator_guidance: 'on'.
 */
const guideAgent: ToolHandler = async (ctx, args) => {
  const storyId = String(args.story_id ?? '');
  const message = String(args.message ?? '');
  if (!storyId) return { status: 'error', message: 'story_id is required' };
  if (args.clear === true) {
    const db = openDatabase(ctx.loomDir);
    new OperatorGuidance({ projectRoot: ctx.projectRoot, db }).clear(storyId);
    return { status: 'cleared', story_id: storyId };
  }
  if (!message.trim()) {
    return { status: 'error', message: 'message is required (or pass clear: true)' };
  }
  const db = openDatabase(ctx.loomDir);
  const author = args.author ? String(args.author) : undefined;
  const guidance = new OperatorGuidance({ projectRoot: ctx.projectRoot, db });
  const entry = guidance.add(storyId, message, { author });
  return {
    status: 'added',
    story_id: storyId,
    timestamp: entry.timestamp,
    file: guidance.fileFor(storyId),
    message:
      'Guidance recorded. The worker reads .loom/guidance/<story-id>.md at story-start and ' +
      'on revisions when policy.agents.operator_guidance=on.',
  };
};

/**
 * loom_pull_guidance — worker-side pull of operator guidance since the
 * last call (Phase 2 of live agent guidance). For backends that can't
 * accept mid-spawn stdin injection (cursor-cli), the worker calls this
 * tool between major tool calls to pick up steering. Returns
 * { content: <delta string> | null, has_more: false }.
 *
 * Independent of `loom_guide_agent` / per-revision pickup — this is the
 * pull side that complements the supervisor's stdin-push (which only
 * works for the claude-cli backend). See
 * docs/research/live-agent-guidance.md.
 */
const pullGuidance: ToolHandler = async (ctx, args) => {
  const storyId = String(args.story_id ?? '');
  if (!storyId) return { status: 'error', message: 'story_id is required' };
  const db = openDatabase(ctx.loomDir);
  const guidance = new OperatorGuidance({ projectRoot: ctx.projectRoot, db });
  return guidance.pullSince(storyId);
};

/**
 * loom_revert_epic — tear down an epic. Wraps the EpicReverter service
 * so chat clients have the same surface as `loom revert`. Local-only by
 * default; pass remote: true to also delete the upstream branch and close
 * the PR.
 */
const revertEpic: ToolHandler = async (ctx, args) => {
  const epicId = String(args.epic_id ?? '');
  if (!epicId) return { status: 'error', message: 'epic_id is required' };
  const policy = PolicyEngine.load(ctx.loomDir).policyData;
  const db = openDatabase(ctx.loomDir);
  const reverter = new EpicReverter({
    projectRoot: ctx.projectRoot,
    db,
    allowedRemotes: policy.git.allowed_remotes,
  });
  const result = reverter.revert(epicId, {
    remote: args.remote === true,
    reason: args.reason ? String(args.reason) : undefined,
  });
  return result;
};

/**
 * loom_reconcile_epic — verify a stranded-but-merged epic and flip it to done.
 * Wraps EpicReconciler so chat clients have the same surface as `loom reconcile`.
 * Identical inputs yield identical outcomes — both surfaces call the same
 * EpicReconciler.reconcile() implementation (ADR-2).
 */
const reconcileEpic: ToolHandler = async (ctx, args) => {
  const epicId = String(args.epic_id ?? '');
  if (!epicId) return { status: 'error', message: 'epic_id is required' };
  const db = openDatabase(ctx.loomDir);
  const reconciler = new EpicReconciler({
    projectRoot: ctx.projectRoot,
    db,
    ...(args._gitBin ? { gitBin: String(args._gitBin) } : {}),
    ...(args._ghBin ? { ghBin: String(args._ghBin) } : {}),
  });
  const result = reconciler.reconcile(epicId, {
    prUrl: args.pr_url ? String(args.pr_url) : undefined,
  });
  return result;
};

/**
 * loom_retry_story — retry one failed/blocked story and re-dispatch its epic
 * in the background. Delegates the guards + (optional) clean teardown +
 * dependent cascade to the shared StoryRetryService, then reuses the same
 * Supervisor wiring as loom_approve_plan to re-run. Returns immediately;
 * the client polls loom_get_status.
 *
 * KNOWN HAZARD — one-shot stdio orphaning (documented, NOT fixed here).
 * Like loom_approve_plan, this hands the dispatch to `ctx.background(...)` and
 * returns `dispatching` immediately. The MCP server runs over a single
 * `StdioServerTransport` (see ../server.ts). A client that spawns the loom MCP
 * server per call and tears it down once the single tool response is read — the
 * "one-shot stdio" pattern — kills this process while the backgrounded
 * supervisor (and every worker subprocess it has spawned) is still running,
 * orphaning the dispatch mid-flight: stories are left `running` with no
 * supervisor to finalize them, and the worker children may be reparented and
 * abandoned. The CLI form (`loom retry`) does not have this hazard because its
 * process lives for the whole dispatch. The robust MCP surface is a long-lived
 * server (the default for Claude Code / Cursor), where the background task
 * outlives the single call. Mitigations (a persisted dispatch queue, or
 * blocking until the run drains) are out of scope for story-006-006, which only
 * documents the hazard — operators on one-shot stdio should prefer the CLI.
 */
const retryStory: ToolHandler = async (ctx, args) => {
  const storyId = String(args.story_id ?? '');
  if (!storyId) return { status: 'error', message: 'story_id is required' };
  const clean = args.clean === true;
  const reason = args.reason ? String(args.reason) : undefined;

  const db = openDatabase(ctx.loomDir);
  const retry = new StoryRetryService({
    projectRoot: ctx.projectRoot,
    db,
    clean,
    reason,
  });
  const prep = retry.prepare(storyId);
  if (prep.status !== 'ready') {
    // 'rejected' (running story / live run holds the epic) or 'error'
    // (unknown story/epic) — surface as-is; nothing was dispatched.
    return {
      status: prep.status,
      story_id: storyId,
      epic_id: prep.epicId,
      message: prep.message,
    };
  }

  const policy = PolicyEngine.load(ctx.loomDir).policyData;
  const { supervisor, globalLimiter } = buildDispatchSupervisor(ctx, db, policy);
  ctx.background(
    `retry ${storyId}`,
    supervisor.run([prep.epicId!]).finally(() => globalLimiter?.close())
  );

  return {
    status: 'dispatching',
    story_id: storyId,
    epic_id: prep.epicId,
    clean,
    will_resume: prep.willResume,
    reset_stories: prep.resetStories,
    message:
      `${prep.message} Story agents are re-dispatching — poll loom_get_status.`,
  };
};

/**
 * loom_stop_epic — cancel every running worker for one epic in a single
 * call. Mirrors loom_stop_agent's PID-targeted SIGTERM but iterates the
 * agents belonging to the named epic. Workers in any non-running status
 * are reported as noop'd; the supervisor's other epics continue.
 */
const stopEpic: ToolHandler = async (ctx, args) => {
  const epicId = String(args.epic_id ?? '');
  if (!epicId) return { status: 'error', message: 'epic_id is required' };
  const reason = args.reason ? String(args.reason) : 'cancelled by user';

  const db = openDatabase(ctx.loomDir);
  const epicStore = new EpicStore(db);
  const agentStore = new AgentStore(db);
  const audit = new AuditLog(db);

  const epic = epicStore.get(epicId);
  if (!epic) return { status: 'error', message: `Epic "${epicId}" not found` };

  const agents = agentStore.listByEpic(epicId);
  const stopped: Array<{ story_id: string; pid: number }> = [];
  const noop: Array<{ story_id: string; agent_status: string }> = [];
  const errors: Array<{ story_id: string; message: string }> = [];

  for (const agent of agents) {
    if (agent.status !== 'running') {
      noop.push({ story_id: agent.story_id, agent_status: agent.status });
      continue;
    }
    if (!agent.worker_pid) {
      errors.push({
        story_id: agent.story_id,
        message: 'running but no worker_pid recorded',
      });
      continue;
    }
    try {
      process.kill(agent.worker_pid, 'SIGTERM');
      stopped.push({ story_id: agent.story_id, pid: agent.worker_pid });
      audit.record({
        agent_id: agent.id,
        action: 'stop_agent',
        command: agent.story_id,
        allowed: true,
        detail: { reason, pid: agent.worker_pid, source: 'loom_stop_epic', epic_id: epicId },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === 'ESRCH' ? 'worker process already gone' : (err as Error).message;
      errors.push({ story_id: agent.story_id, message: msg });
      audit.record({
        agent_id: agent.id,
        action: 'stop_agent',
        command: agent.story_id,
        allowed: false,
        detail: { reason, error: msg, source: 'loom_stop_epic', epic_id: epicId },
      });
    }
  }

  // Aggregate row at the epic level so the audit log explains why the
  // stop_agent rows above are correlated.
  audit.record({
    agent_id: undefined,
    action: 'stop_epic',
    command: epicId,
    allowed: true,
    detail: {
      reason,
      stopped: stopped.length,
      noop: noop.length,
      errors: errors.length,
    },
  });

  return {
    status: 'stopping',
    epic_id: epicId,
    stopped,
    noop,
    errors,
    message:
      stopped.length === 0
        ? `No running workers in ${epicId} (${noop.length} non-running, ${errors.length} errored).`
        : `SIGTERM sent to ${stopped.length} worker(s) in ${epicId}.`,
  };
};

/**
 * loom_archive_epic — hide a run from the default loom_get_status / status /
 * web views (and from supervisor selection) without deleting it. Pass
 * archived:false to restore. Non-destructive and audit-logged; works on an
 * epic in any status.
 */
const archiveEpic: ToolHandler = async (ctx, args) => {
  const epicId = String(args.epic_id ?? '');
  if (!epicId) return { status: 'error', message: 'epic_id is required' };
  const archive = args.archived !== false; // default true

  const db = openDatabase(ctx.loomDir);
  const epicStore = new EpicStore(db);
  const audit = new AuditLog(db);

  const epic = epicStore.get(epicId);
  if (!epic) return { status: 'error', message: `Epic "${epicId}" not found` };

  const alreadyArchived = epic.archived_at != null;
  if (archive && alreadyArchived) {
    return { status: 'noop', epic_id: epicId, archived: true, message: `Epic "${epicId}" is already archived.` };
  }
  if (!archive && !alreadyArchived) {
    return { status: 'noop', epic_id: epicId, archived: false, message: `Epic "${epicId}" is not archived.` };
  }

  if (archive) epicStore.archive(epicId);
  else epicStore.unarchive(epicId);

  audit.record({
    action: archive ? 'epic_archived' : 'epic_unarchived',
    command: epicId,
  });

  return {
    status: archive ? 'archived' : 'unarchived',
    epic_id: epicId,
    archived: archive,
    message: archive
      ? `Epic "${epicId}" archived — hidden from default views. Pass include_archived to loom_get_status to see it.`
      : `Epic "${epicId}" unarchived — back in the default views.`,
  };
};

/**
 * loom_get_decision_traces — worker reasoning captured to SQLite. Exactly one
 * of agent_id / story_id / epic_id is required to bound the lookup. Returns
 * the raw trace rows (kind, subject, rationale, ts) — caller decides how to
 * present them.
 */
const getDecisionTraces: ToolHandler = async (ctx, args) => {
  const db = openDatabase(ctx.loomDir);
  const store = new DecisionTraceStore(db);
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  let traces;
  if (args.agent_id) {
    traces = store.getByAgent(String(args.agent_id), limit ?? 200);
  } else if (args.story_id) {
    traces = store.getByStory(String(args.story_id), limit ?? 500);
  } else if (args.epic_id) {
    traces = store.getByEpic(String(args.epic_id), limit ?? 2000);
  } else {
    return {
      status: 'error',
      message: 'exactly one of agent_id / story_id / epic_id is required',
    };
  }
  return { traces };
};

/**
 * loom_get_diff — `git diff <epic.base_sha>..<branch>` for a story or an
 * epic. Read-only: a single `git diff` call inside the project root, no
 * mutation. Bounded by max_bytes so a huge diff doesn't blow the MCP
 * response budget.
 */
const getDiff: ToolHandler = async (ctx, args) => {
  const db = openDatabase(ctx.loomDir);
  const epicStore = new EpicStore(db);
  const agentStore = new AgentStore(db);
  const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : 200_000;
  const includeStat = args.include_stat !== false;

  let epicId: string | undefined;
  let branch: string;
  if (args.story_id) {
    const agent = agentStore.getByStory(String(args.story_id));
    if (!agent) {
      return {
        status: 'error',
        message: `No agent for story "${String(args.story_id)}"`,
      };
    }
    epicId = agent.epic_id;
    branch = `story/${agent.story_id}`;
  } else if (args.epic_id) {
    epicId = String(args.epic_id);
    branch = `epic/${epicId}`;
  } else {
    return {
      status: 'error',
      message: 'one of story_id / epic_id is required',
    };
  }

  const epic = epicStore.get(epicId);
  if (!epic || !epic.base_sha) {
    return {
      status: 'error',
      message: `Epic "${epicId}" has no base_sha — was it dispatched?`,
    };
  }

  const range = `${epic.base_sha}..${branch}`;
  try {
    const { stdout: diff } = await execFileP(
      'git',
      ['--no-pager', 'diff', range],
      { cwd: ctx.projectRoot, maxBuffer: 50_000_000 },
    );
    const truncated = diff.length > maxBytes;
    const body = truncated ? diff.slice(0, maxBytes) : diff;
    let stat: string | undefined;
    if (includeStat) {
      const { stdout } = await execFileP(
        'git',
        ['--no-pager', 'diff', '--stat', range],
        { cwd: ctx.projectRoot, maxBuffer: 256_000 },
      );
      stat = stdout;
    }
    return {
      base: epic.base_sha,
      head: branch,
      bytes: diff.length,
      truncated,
      diff: body,
      ...(stat ? { stat } : {}),
    };
  } catch (err) {
    return {
      status: 'error',
      message: `git diff ${range} failed: ${(err as Error).message}`,
    };
  }
};

/**
 * loom_get_planning_artifacts — read the brief / PRD / architecture / epic
 * YAML for one epic. Paths come from the epic record; architecture lives next
 * to the brief by convention. Missing files are surfaced as null, not errors.
 */
const getPlanningArtifacts: ToolHandler = async (ctx, args) => {
  const epicId = String(args.epic_id ?? '');
  if (!epicId) return { status: 'error', message: 'epic_id is required' };
  const db = openDatabase(ctx.loomDir);
  const epic = new EpicStore(db).get(epicId);
  if (!epic) return { status: 'error', message: `Epic "${epicId}" not found` };

  const readMaybe = (rel: string | null): string | null => {
    if (!rel) return null;
    const abs = path.join(ctx.projectRoot, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  };

  const briefBody = readMaybe(epic.brief_path);
  const prdBody = readMaybe(epic.prd_path);
  const epicYamlBody = readMaybe(epic.yaml_path);

  // Architecture isn't tracked on the epic row; it lives next to the brief.
  let architectureBody: string | null = null;
  if (epic.brief_path) {
    const archRel = path.join(path.dirname(epic.brief_path), 'architecture.md');
    architectureBody = readMaybe(archRel);
  }

  return {
    epic_id: epicId,
    paths: {
      brief: epic.brief_path,
      prd: epic.prd_path,
      epic_yaml: epic.yaml_path,
    },
    brief: briefBody,
    prd: prdBody,
    architecture: architectureBody,
    epic_yaml: epicYamlBody,
  };
};

/**
 * loom_get_review — the block-and-revise reviewer's verdict for one story.
 * review_summary is markdown produced by the CodeReviewAgent; review_status
 * is one of pending / approved / blocked / errored.
 */
const getReview: ToolHandler = async (ctx, args) => {
  const storyId = String(args.story_id ?? '');
  if (!storyId) return { status: 'error', message: 'story_id is required' };
  const db = openDatabase(ctx.loomDir);
  const agent = new AgentStore(db).getByStory(storyId);
  if (!agent) {
    return { status: 'error', message: `No agent for story "${storyId}"` };
  }
  if (!agent.review_status && !agent.review_summary) {
    return {
      status: 'noop',
      story_id: storyId,
      message: 'No review recorded — review_strategy may be off or the worker has not finished.',
    };
  }
  return {
    story_id: storyId,
    review_status: agent.review_status,
    review_summary: agent.review_summary,
  };
};

/**
 * loom_list_projects — every loom-initialized repo on this machine, as
 * recorded in ~/.loom/projects.json. The registry self-heals (prunes
 * directories that no longer exist) on read. Pre-requisite for a
 * multi-repo-aware MCP client (issue #15).
 */
const listProjects: ToolHandler = async () => {
  const projects = new ProjectRegistry().list();
  return { projects };
};

/**
 * loom_get_project — one registered project's record, optionally with its
 * latest epic status. Useful when an MCP client wants to drill into one
 * project from the list.
 */
const getProject: ToolHandler = async (_ctx, args) => {
  const root = String(args.root ?? '');
  if (!root) return { status: 'error', message: 'root is required' };
  const entry = new ProjectRegistry().list().find((p) => p.root === root);
  if (!entry) {
    return { status: 'error', message: `Project "${root}" not registered` };
  }
  // Optionally probe the project's DB for its latest epic. Best-effort —
  // a half-initialized project still returns the registry entry.
  let latestEpic: { id: string; status: string; title: string } | undefined;
  try {
    const projectLoomDir = path.join(root, '.loom');
    if (fs.existsSync(path.join(projectLoomDir, 'loom.db'))) {
      const db = openDatabase(projectLoomDir);
      const epics = new EpicStore(db).list();
      const last = epics[epics.length - 1];
      if (last) latestEpic = { id: last.id, status: last.status, title: last.title };
    }
  } catch {
    // ignore — registry record is still useful
  }
  return {
    project: entry,
    ...(latestEpic ? { latest_epic: latestEpic } : {}),
  };
};

/**
 * loom_set_autonomy — set the autonomy level for an epic. Delegates to the
 * shared setEpicAutonomy core action so the persisted value and audit row are
 * identical to the web route path (FR-3).
 */
const setAutonomy: ToolHandler = async (ctx, args) => {
  const epicId = String(args.epic_id ?? '');
  if (!epicId) return { status: 'error', message: 'epic_id is required' };

  const parse = AutonomyLevelSchema.safeParse(args.level);
  if (!parse.success) {
    return { status: 'error', message: 'invalid level; must be one of: full-auto, checkpoint, manual' };
  }

  const db = openDatabase(ctx.loomDir);
  const epicStore = new EpicStore(db);
  const auditLog = new AuditLog(db);

  try {
    return setEpicAutonomy({ epicStore, auditLog }, epicId, parse.data, 'mcp');
  } catch (err) {
    if (err instanceof EpicNotFoundError) {
      return { status: 'error', message: err.message };
    }
    throw err;
  }
};

/**
 * loom_scan_signals — run signal scanners and return the ranked opportunity
 * board. Mirrors loom_get_status in structure: open the project DB, build an
 * LLM client from policy, run the full scan pipeline (scanners → signals →
 * one LLM clustering call → persist → return). Operator-invoked only (ADR-006).
 */
const scanSignals: ToolHandler = async (ctx, args) => {
  const projectFilter = args.project ? String(args.project) : null;

  let effectiveProjectRoot = ctx.projectRoot;
  let effectiveLoomDir = ctx.loomDir;

  if (projectFilter) {
    const known = new ProjectRegistry().list().map(e => e.root);
    if (!known.includes(projectFilter)) {
      return { status: 'error', message: `Unknown project root: ${projectFilter}` };
    }
    effectiveProjectRoot = projectFilter;
    effectiveLoomDir = path.join(projectFilter, '.loom');
  }

  const db = openDatabase(effectiveLoomDir);
  const policy = PolicyEngine.load(effectiveLoomDir).policyData;
  const auditLog = new AuditLog(db);

  let llm;
  try {
    llm = ctx.createLLM(policy.agents.llm_backend);
  } catch (err) {
    return { status: 'error', message: `Failed to create LLM client: ${(err as Error).message}` };
  }

  const model = modelFor(policy, 'planning');

  const result = await runScan({
    db,
    projectRoot: effectiveProjectRoot,
    llm,
    model,
    auditLog,
  });

  return {
    signalsObserved: result.signalsObserved,
    signalsStaled: result.signalsStaled,
    opportunities: result.opportunities.map(o => ({
      id: o.id,
      title: o.title,
      rationale: o.rationale,
      score: o.score,
      rank: o.rank,
      signal_count: o.signal_count,
      status: o.status,
      evidence: o.evidence,
      scoped_epic_id: o.scoped_epic_id,
    })),
  };
};

/**
 * loom_propose — propose the next epic by combining top-ranked lessons with
 * top open opportunities. EXPLICIT TRIGGER ONLY (NFR-3): no scheduler path.
 * Exactly one BriefRefiner LLM call. Returns { ok, epicId? } or { ok, critique }.
 */
const proposeEpic: ToolHandler = async (ctx, args) => {
  const db = openDatabase(ctx.loomDir);
  try {
    const policy = PolicyEngine.load(ctx.loomDir).policyData;

    let llm;
    try {
      llm = ctx.createLLM(policy.agents.llm_backend);
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    }

    const model = modelFor(policy, 'planning');
    const topLessons = typeof args.top_lessons === 'number' ? args.top_lessons : undefined;
    const topOpps = typeof args.top_opps === 'number' ? args.top_opps : undefined;

    const result = await proposeNextEpic(
      {
        lessonStore: new LessonStore(db),
        opportunityStore: new OpportunityStore(db),
        refiner: new BriefRefiner({ projectRoot: ctx.projectRoot, llm, model }),
        planner: new Planner({ projectRoot: ctx.projectRoot, llm, model, db }),
        epicStore: new EpicStore(db),
        audit: new AuditLog(db),
        minBriefQualityScore: policy.agents.min_brief_quality_score,
      },
      { topLessons, topOpps }
    );

    if (result.ok) {
      return { ok: true, epicId: result.epicId };
    }
    return { ok: false, critique: result.critique };
  } finally {
    db.close();
  }
};

export const HANDLERS: Record<string, ToolHandler> = {
  loom_policy_check: policyCheck,
  loom_get_status: getStatus,
  loom_get_audit_log: getAuditLog,
  loom_start_epic: startEpic,
  loom_approve_plan: approvePlan,
  loom_reject_plan: rejectPlan,
  loom_stop_agent: stopAgent,
  loom_stop_epic: stopEpic,
  loom_retry_story: retryStory,
  loom_revert_epic: revertEpic,
  loom_reconcile_epic: reconcileEpic,
  loom_archive_epic: archiveEpic,
  loom_guide_agent: guideAgent,
  loom_pull_guidance: pullGuidance,
  loom_get_decision_traces: getDecisionTraces,
  loom_get_diff: getDiff,
  loom_get_planning_artifacts: getPlanningArtifacts,
  loom_get_review: getReview,
  loom_list_projects: listProjects,
  loom_get_project: getProject,
  loom_set_autonomy: setAutonomy,
  loom_scan_signals: scanSignals,
  loom_propose: proposeEpic,
};

export type { ToolContext };
