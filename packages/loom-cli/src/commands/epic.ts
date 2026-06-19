import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  openDatabase,
  PolicyEngine,
  createLLMClient,
  modelFor,
  Planner,
  BriefRefiner,
  AuditLog,
  EpicStore,
  derivePlaceholderTitle,
  evaluateBriefGate,
  validateCursorModels,
  classifyIntake,
  INTAKE_AUDIT_ACTION,
} from '@loom-ai/core';
import type { LLMClient, ClassifyResult } from '@loom-ai/core';
import { maybeWarnGatePreflight } from './gatePreflightWarning.js';
import { formatClarificationsNotice } from './briefGateMessage.js';
import { makePlanningPrinter } from './planningPrinter.js';

// Observe-only intake classification stage config; forwarded by loom weave, absent on loom epic path.
export type IntakeStage = {
  model: string;
  timeoutMs: number;
};

/**
 * @param opts.force  Skip the brief-quality gate for this invocation only. The
 *   refiner still runs and its critique is recorded; a `brief_gate_forced`
 *   audit row referencing the critique is written before the planner runs.
 * @param opts.llm    Test seam — inject a stub LLMClient. Production callers
 *   omit this and the client is built from policy.agents.llm_backend.
 * @param opts.cursorBin  Test seam — point the cursor_model probe at a stub
 *   `cursor-agent`. Production callers omit this; the real CLI is used.
 * @param opts.intake   Intake classification stage config; provided by `loom weave`,
 *   absent on `loom epic`. When present, classifyIntake fires after epic-id
 *   reservation and persists the verdict (best-effort, observe-only).
 * @param opts._classifyIntake  Test seam — inject a stub for classifyIntake.
 *   Only exercised when opts.intake is also provided. Production callers omit.
 */
export async function runEpic(
  brief: string,
  opts: {
    force?: boolean;
    verbose?: boolean;
    llm?: LLMClient;
    cursorBin?: string;
    intake?: IntakeStage;
    _classifyIntake?: typeof classifyIntake;
  } = {}
): Promise<void> {
  const force = opts.force === true;
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');

  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }
  if (!brief || brief.trim().length < 10) {
    console.error('Please provide a brief of at least a sentence: loom epic "<brief>"');
    process.exit(1);
  }

  const policy = PolicyEngine.load(loomDir).policyData;

  // Fail fast on a bad cursor_model before spending any LLM tokens. Exit only
  // on a confirmed-invalid id; an 'unavailable' probe (FR-8) or a boundary-
  // prefix alias (FR-1(b), `advisory`) is a warning that proceeds. The branch
  // shape is identical at all three call sites — the pass/fail behavior is
  // inherited from validateCursorModels, never re-derived here.
  const modelCheck = validateCursorModels(policy, opts.cursorBin);
  if (modelCheck?.status === 'invalid') {
    console.error(modelCheck.message);
    process.exit(1);
  } else if (modelCheck?.status === 'unavailable' || modelCheck?.advisory) {
    console.warn(modelCheck.message);
  }

  maybeWarnGatePreflight(projectRoot, policy);
  const db = openDatabase(loomDir);

  let llm: LLMClient;
  if (opts.llm) {
    llm = opts.llm;
  } else {
    try {
      llm = createLLMClient(policy.agents.llm_backend);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
      return;
    }
  }

  // Reserve the epic row at submission, BEFORE the refiner runs. The
  // synchronous better-sqlite3 insert makes the row durable ahead of the
  // first `await`, so `loom status` shows the new epic the instant `loom
  // epic` is invoked — and reservation order under concurrent submissions
  // follows submission order. This is the SINGLE allocation site for the
  // CLI path: `Planner.nextEpicId` runs here exactly once, and the planner
  // adopts this id (it skips its own self-allocation when given a
  // reservedId). The title starts as a derived placeholder (first Markdown
  // heading, else the brief's first 60 chars) and is replaced by the
  // planner's real title at completion via the existing seam.
  const reservedId = Planner.nextEpicId(db);
  const store = new EpicStore(db);
  store.beginPlanning(reservedId, brief);
  store.setTitle(reservedId, derivePlaceholderTitle(brief));

  // Observe-only intake classification (weave path only). Fires right after
  // epic-id reservation, before the brief-quality gate or planner. Best-effort:
  // any failure — timeout, parse error, or LLM error — is caught, recorded in
  // the audit log, and never propagated (FR-3). Planning always continues.
  if (opts.intake) {
    const doClassify = opts._classifyIntake ?? classifyIntake;
    let classResult: ClassifyResult = { ok: false, reason: 'llm_error', detail: 'unexpected' };
    try {
      classResult = await doClassify(brief, {
        llm,
        model: opts.intake.model,
        timeoutMs: opts.intake.timeoutMs,
      });
    } catch (e) {
      classResult = {
        ok: false,
        reason: 'llm_error',
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    const auditDetail: Record<string, unknown> = { epicId: reservedId, ok: classResult.ok };
    if (!classResult.ok) auditDetail.reason = classResult.reason;
    if (classResult.ok) auditDetail.verdict = classResult.verdict;
    new AuditLog(db).record({ action: INTAKE_AUDIT_ACTION, detail: auditDetail });
    if (classResult.ok) {
      store.recordIntakeVerdict(reservedId, classResult.verdict);
    }
  }

  // Brief-quality gate. Always runs — refuses briefs scoring below
  // policy.agents.min_brief_quality_score so the planner never spends
  // tokens on something underspecified. The critique is printed so the
  // operator can tighten the prompt and re-run. With --force the gate
  // decision is overridden for this invocation only: the refiner still
  // runs, its critique is recorded, and an audit row is written before
  // the planner starts.
  console.log('\n  Refining brief — quick clarification pass before planning.');
  const refiner = new BriefRefiner({
    projectRoot,
    llm,
    model: modelFor(policy, 'planning'),
  });
  let refinement;
  try {
    refinement = await refiner.refine(brief);
  } catch (err) {
    console.error('\n  Brief refinement failed:', (err as Error).message);
    process.exit(1);
    return;
  }
  const minScore = policy.agents.min_brief_quality_score;
  const verdict = evaluateBriefGate(refinement, minScore);

  if (force && verdict.outcome !== 'pass-clean') {
    // Forced past a gate rejection or a pass-with-clarifications. Record the
    // override — with the full critique embedded — BEFORE the planner runs
    // (ordering invariant / NFR-2). The synchronous better-sqlite3 insert
    // guarantees durability ahead of any planner work.
    new AuditLog(db).record({
      action: 'brief_gate_forced',
      command: brief.slice(0, 120),
      allowed: true,
      detail: {
        entry_point: 'cli',
        ready: verdict.ready,
        quality_score: verdict.quality_score,
        threshold: verdict.threshold,
        critique: refinement.critique,
        questions: refinement.questions,
      },
    });
    console.log(
      `  Brief scored ${refinement.quality_score}/10 (need >= ${minScore}) — ` +
        '--force override; gate bypassed and audit-logged. Proceeding.'
    );
  } else {
    switch (verdict.outcome) {
      case 'below-threshold': {
        console.error('');
        console.error(`  Brief scored ${refinement.quality_score}/10 (need >= ${minScore}).`);
        console.error('');
        if (refinement.questions.length > 0) {
          console.error('  Open questions to address:');
          for (const q of refinement.questions) console.error(`    • ${q}`);
          console.error('');
        }
        const c = refinement.critique;
        const issues = [
          ['Ambiguities', c.ambiguities],
          ['Missing scope', c.missing_scope],
          ['Untestable claims', c.untestable_claims],
          ['Hidden complexity', c.hidden_complexity],
        ] as const;
        for (const [label, items] of issues) {
          if (items.length === 0) continue;
          console.error(`  ${label}:`);
          for (const item of items) console.error(`    • ${item}`);
          console.error('');
        }
        if (refinement.refined_brief) {
          console.error('  Suggested refined brief:');
          console.error('');
          console.error(refinement.refined_brief.split('\n').map((l) => `    ${l}`).join('\n'));
          console.error('');
        }
        console.error('  Tighten the brief above and re-run `loom epic "<brief>"`.');
        // Clean terminal state for the gate-rejected run: flip the reserved row
        // (from reservation, before the refiner) to 'rejected' with the machine
        // verdict in `error` — NOT `reason`. A human reject writes `reason`; this
        // gate reject writes `error`, so provenance (operator vs quality gate)
        // stays distinguishable on the shared 'rejected' status.
        store.reject(
          reservedId,
          `brief gate: ${refinement.quality_score}/10 — ${firstCritiqueLine(refinement)}`
        );
        process.exit(1);
        return;
      }
      case 'pass-with-clarifications':
        console.error(formatClarificationsNotice(verdict, refinement));
        store.reject(reservedId, 'brief gate: passed with clarifications');
        process.exit(3);
        return;
      case 'pass-clean':
        console.log(`  Brief scored ${refinement.quality_score}/10 (>= ${minScore}). Proceeding.`);
        break;
    }
  }

  console.log('\n  Planning your epic — Analyst → PM → Architect.');
  console.log(`  Backend: ${policy.agents.llm_backend}. Runs headless, takes a few minutes.\n`);

  // Planner skill injection is DELIBERATELY OFF. The eval showed it caused
  // over-planning (small briefs inflating into 4-6 epics, 17-26 stories) —
  // injecting loom-brainstorm / loom-edge-case-review / loom-plan-review
  // bodies into the Analyst pushed the brief toward thorough state inventory,
  // which the PM expanded into more stories. Worker-time skill injection in
  // the Supervisor is unchanged — that is where skills add real value,
  // against actual code work.
  // core (PlanningOutputSink) redacts secrets before firing onPlanningEvent —
  // the printer is a pass-through and must never re-redact.
  const printer = makePlanningPrinter({ verbose: opts.verbose === true });
  const planner = new Planner({
    projectRoot,
    llm,
    model: modelFor(policy, 'planning'),
    db,
    sharedContract: policy.agents.shared_contract === 'on',
    qaPlanning: policy.agents.qa_planning === 'advisory',
    onPlanningEvent: printer.handle,
  });

  let result;
  try {
    result = await planner.run(brief, reservedId);
  } catch (err) {
    console.error('\n  Planning failed:', (err as Error).message);
    process.exit(1);
  }
  // Drain any partial line not terminated by a newline in the final streamed chunk.
  printer.flush();

  console.log('  Planning complete.\n');
  console.log(`  Run:           ${result.runId}`);
  console.log(`  Brief:         ${rel(projectRoot, result.briefPath)}`);
  console.log(`  PRD:           ${rel(projectRoot, result.prdPath)}`);
  console.log(`  Architecture:  ${rel(projectRoot, result.architecturePath)}`);
  console.log('');
  const plannerModel = modelFor(policy, 'planning');
  for (const epicId of result.epicIds) {
    // `model` is '' on the test-seam path where llm is null — guard before writing.
    if (plannerModel) store.setPlannerModel(epicId, plannerModel);
    console.log(`  ${epicId}`);
  }
  console.log('');
  console.log(
    `  ${result.epicIds.length} epic(s), ${result.storyCount} stories ` +
      `(${result.storiesEnriched} enriched with tech notes).`
  );
  const billed = result.usage.inputTokens + result.usage.outputTokens;
  console.log(
    `  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out ` +
      `(${result.usage.cacheReadTokens} cached). Billed: ${billed.toLocaleString()}.`
  );
  const budget = policy.agents.planning_token_budget;
  if (typeof budget === 'number' && billed > budget) {
    console.log(
      `  WARNING: planning ran over the configured budget — ` +
        `${billed.toLocaleString()} > ${budget.toLocaleString()}. ` +
        'See policy.agents.planning_token_budget.'
    );
  }
  console.log('');

  console.log('  Review the plan above, then:');
  console.log('    loom approve            approve all planned epics');
  console.log('    loom approve <epic-id>  approve one epic');
  console.log('    loom reject <epic-id> --reason "..."  reject an epic');
  console.log('');
}

function rel(root: string, abs: string): string {
  return path.relative(root, abs) || abs;
}

/**
 * The single most salient line of the gate critique, for the one-line verdict
 * stored on a rejected row's `error` column. Walks the critique categories in
 * the order an operator reads them, falls back to the first open question, and
 * finally to a generic note so the verdict is never an empty tail after the em
 * dash.
 */
function firstCritiqueLine(refinement: {
  critique: {
    ambiguities: string[];
    missing_scope: string[];
    untestable_claims: string[];
    hidden_complexity: string[];
  };
  questions: string[];
}): string {
  const c = refinement.critique;
  const first =
    c.ambiguities[0] ??
    c.missing_scope[0] ??
    c.untestable_claims[0] ??
    c.hidden_complexity[0] ??
    refinement.questions[0];
  return first ?? 'brief scored below the quality threshold';
}

export const spec: CommandDescription = {
  name: 'epic',
  summary: 'Plan an epic from a brief using the Analyst→PM→Architect pipeline',
  whenToUse: 'Use when you have a clear feature idea to plan. Pass a one-paragraph brief; loom runs the planning pipeline and outputs a structured epic YAML.',
  arguments: [
    { name: 'brief', type: 'string', required: true, description: 'One paragraph describing what to build' },
  ],
  options: [
    { name: '--force', type: 'boolean', description: 'Skip the brief-quality gate for this invocation (critique still produced and audit-logged)', changesOutputShape: false },
    { name: '--verbose', type: 'boolean', description: 'Stream live persona output to the terminal', changesOutputShape: true },
  ],
  output: { text: 'Epic id and summary of planned stories after the planning pipeline completes' },
  examples: [
    { command: 'loom epic "Add OAuth2 login with GitHub"', description: 'Plan a new epic from a brief' },
    { command: 'loom epic "Refactor auth module" --force', description: 'Plan without the brief quality gate' },
    { command: 'loom epic "Add OAuth2 login with GitHub" --verbose', description: 'Stream live persona output while planning' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic planned successfully' },
    { code: 1, meaning: 'loom not initialized, brief quality gate failed, or LLM error' },
    { code: 3, meaning: 'Brief passed with optional clarifications — re-run with --force to plan as-is' },
  ],
  errors: ['loom is not initialized — run `loom init` first', 'Brief quality score too low — revise or use --force', 'ANTHROPIC_API_KEY not set'],
  relationships: { prerequisites: ['init'], nextSteps: ['approve', 'artifacts', 'status'] },
};
