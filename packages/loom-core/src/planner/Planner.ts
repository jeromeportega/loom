import type Database from 'better-sqlite3';
import type { LLMClient, LLMUsage } from '../llm/index.js';
import { addUsage, EMPTY_USAGE } from '../llm/index.js';
import { EpicStore } from '../state/index.js';
import { SkillSelector } from '../skills/index.js';
import type { SkillStore } from '../skills/index.js';
import type { PlannerContext } from './context.js';
import { AnalystAgent } from './AnalystAgent.js';
import { PMAgent } from './PMAgent.js';
import { ArchitectAgent } from './ArchitectAgent.js';
import { QAAgent } from './QAAgent.js';
import { SharedContract } from '../orchestrator/SharedContract.js';
import { epicId, epicNumber, planningRelPaths } from './paths.js';
import { PlanningOutputSink } from './PlanningOutputSink.js';
import type { PlanningEvent } from './PlanningEvent.js';

export interface PlanResult {
  runId: string;
  briefPath: string;
  prdPath: string;
  architecturePath: string;
  epicIds: string[];
  epicPaths: string[];
  storyCount: number;
  storiesEnriched: number;
  usage: LLMUsage;
}

export interface PlannerOptions {
  projectRoot: string;
  llm: LLMClient;
  model: string;
  db: Database.Database;
  /**
   * Optional skill store. When set, skills relevant to the brief are selected
   * and injected into the planning personas — loom's bundled skills (and any
   * project/global ones) shape how the plan is produced.
   */
  skillStore?: SkillStore;
  /**
   * policy.agents.shared_contract === 'on'. Drives the Architect's optional
   * shared-contract pass and its per-epic persistence for worker injection.
   */
  sharedContract?: boolean;
  /**
   * policy.agents.qa_planning === 'advisory'. Runs the QA persona (Tessa)
   * after the Architect to enrich every story with a risk-based test plan.
   */
  qaPlanning?: boolean;
  /**
   * Optional lifecycle sink for planning output. When set, receives
   * already-redacted text chunks and phase-transition events as each persona
   * runs. Used by the CLI (--verbose flag) and the web dashboard (SSE feed).
   * Absent = capture still happens (tail is written to DB), no in-process fan-out.
   */
  onPlanningEvent?: (e: PlanningEvent) => void;
}

/**
 * Orchestrates the planning pipeline: Analyst -> PM -> Architect, fully
 * headless. Persists the resulting epics to the DB with status 'planned' and
 * leaves them awaiting the human approval gate (`loom approve`).
 */
export class Planner {
  constructor(private opts: PlannerOptions) {}

  /**
   * Selects bundled/project/global skills relevant to a brief and returns
   * their bodies, in priority order. Empty when no skillStore is configured.
   */
  private selectSkills(brief: string): string[] {
    const store = this.opts.skillStore;
    if (!store) return [];
    const manifests = store.discover();
    return SkillSelector.selectByText(brief, manifests, 4)
      .map((m) => store.load(m.name))
      .filter((body): body is string => body !== null);
  }

  /** Returns the epic id the next planning run will start numbering from. */
  static nextEpicId(db: Database.Database): string {
    const epicStore = new EpicStore(db);
    // Include archived epics — id numbering must be globally unique across
    // ALL rows (archived ones still hold their primary key), or a new run
    // could collide with an archived epic's id.
    const maxNum = epicStore
      .list({ includeArchived: true })
      .reduce((max, e) => Math.max(max, epicNumber(e.id)), 0);
    return epicId(maxNum + 1);
  }

  /**
   * Runs the planning pipeline for `brief`.
   *
   * `reservedId` decides WHO allocates the epic id — exactly one site does it
   * per submission:
   *   - present → the caller (e.g. `runEpic`) already allocated via
   *     `nextEpicId` and reserved the row via `beginPlanning`; the planner
   *     adopts it as the runId and does NOT self-allocate or re-reserve (a
   *     second `beginPlanning` would collide on the primary key).
   *   - absent → today's behavior, unchanged for the MCP/test path: the planner
   *     self-allocates via `nextEpicId` and reserves the row itself.
   */
  async run(brief: string, reservedId?: string): Promise<PlanResult> {
    const epicStore = new EpicStore(this.opts.db);
    const startedAt = Date.now();

    let runId: string;
    if (reservedId !== undefined) {
      // Pre-reserved by the caller: adopt the id, do not allocate again. The
      // row already exists (status 'planning') so we skip beginPlanning here.
      runId = reservedId;
    } else {
      // Globally-unique epic numbering: start after the highest existing epic.
      runId = Planner.nextEpicId(this.opts.db);

      // Reserve the epic row IMMEDIATELY so observers (`loom web`,
      // `loom status`) can see "what kicked off this job?" before the
      // Analyst → PM → Architect chain finishes (~5 min). The placeholder
      // is updated through phases and flipped to 'planned' at the end.
      // On a planner crash, the catch block below records status 'failed'
      // with the error message in `epics.error` — distinct from a human
      // 'rejected' verdict (ADR-4, FR-5).
      epicStore.beginPlanning(runId, brief);
    }
    const startNum = epicNumber(runId);

    // Create a planning output sink that captures streamed text, redacts
    // secrets, and flushes to epics.planning_log_tail on the periodic timer.
    // This happens regardless of onPlanningEvent — the tail is always durable.
    const sink = new PlanningOutputSink(runId, epicStore, this.opts.onPlanningEvent);

    // Wrap the LLM so every complete() call injects onText into the request.
    // Agents use ctx.llm and never call this.opts.llm directly, so the
    // wrap is transparent — no agent needs to be modified.
    const wrappedLlm: LLMClient = {
      complete: (req) =>
        this.opts.llm.complete({ ...req, onText: (d) => sink.handleChunk(d) }),
    };

    const ctx: PlannerContext = {
      projectRoot: this.opts.projectRoot,
      llm: wrappedLlm,
      model: this.opts.model,
      runId,
      skills: this.selectSkills(brief),
      sharedContract: this.opts.sharedContract,
      qaPlanning: this.opts.qaPlanning,
    };
    const rel = planningRelPaths(runId);
    let usage: LLMUsage = { ...EMPTY_USAGE };

    sink.start();
    try {
      // ─── Analyst: brief -> project-brief.md ───────────────────────────
      sink.setPhase('analyst');
      const analyst = await new AnalystAgent(ctx).run(brief);
      usage = addUsage(usage, analyst.usage);
      epicStore.updatePlanningPhase(runId, 'pm');

      // ─── PM: brief -> prd.md + epic YAMLs ─────────────────────────────
      sink.setPhase('pm');
      const pm = await new PMAgent(ctx).run(analyst.briefContent, startNum);
      usage = addUsage(usage, pm.usage);
      epicStore.updatePlanningPhase(runId, 'architect');

      // ─── Architect: prd + epics -> architecture.md + enriched epics ───
      sink.setPhase('architect');
      const architect = await new ArchitectAgent(ctx).run(pm.prdContent, pm.epics);
      usage = addUsage(usage, architect.usage);

      // ─── QA (opt-in): enrich each story with a risk-based test plan ───
      // Runs after the Architect so it can plan tests against the real
      // architecture + per-story tech_notes. Mutates architect.epics in place
      // and rewrites the YAML; soft-fails without aborting the run.
      if (this.opts.qaPlanning) {
        const qa = await new QAAgent(ctx).run(
          pm.prdContent,
          architect.architectureContent,
          architect.epics
        );
        usage = addUsage(usage, qa.usage);
      }

      return await this.persistPlanResult(
        epicStore,
        runId,
        rel,
        usage,
        startedAt,
        analyst,
        pm,
        architect
      );
    } catch (err) {
      // Planning was killed mid-chain (crash, OOM, provider error). Record
      // it as a terminal infra failure — status 'failed' with the error
      // MESSAGE (not the full stack — Security Model) retrievable from
      // `epics.error`. This is deliberately distinct from a human
      // 'rejected' verdict (ADR-4, FR-5): a crash is not a decision.
      try {
        epicStore.fail(runId, (err as Error).message);
      } catch {
        // Best-effort cleanup; rethrow the original error regardless.
      }
      throw err;
    } finally {
      sink.stop();
    }
  }

  private async persistPlanResult(
    epicStore: EpicStore,
    runId: string,
    rel: ReturnType<typeof planningRelPaths>,
    usage: LLMUsage,
    startedAt: number,
    analyst: Awaited<ReturnType<AnalystAgent['run']>>,
    pm: Awaited<ReturnType<PMAgent['run']>>,
    architect: Awaited<ReturnType<ArchitectAgent['run']>>
  ): Promise<PlanResult> {

    // ─── Persist epics to the DB ────────────────────────────────────────────
    // The first architect epic id == runId, which already exists as the
    // 'planning' placeholder from beginPlanning(). We complete it in place
    // (preserves user_brief, created_at). Additional epics (epic-002+) get
    // fresh rows.
    const durationMs = Date.now() - startedAt;
    for (const epic of architect.epics) {
      if (epic.epic_id === runId) {
        epicStore.completePlanning(epic.epic_id, epic.title);
        epicStore.updatePaths(epic.epic_id, {
          brief_path: rel.brief,
          prd_path: rel.prd,
          yaml_path: rel.epicFile(epic.epic_id),
        });
      } else {
        epicStore.create(epic.epic_id, epic.title, rel.epicFile(epic.epic_id));
        epicStore.updatePaths(epic.epic_id, {
          brief_path: rel.brief,
          prd_path: rel.prd,
        });
      }
      // Record planner cost on every epic of the run. Multi-epic runs share
      // the same totals; aggregate by run elsewhere if dedupe is needed.
      epicStore.updateTokens(epic.epic_id, usage, durationMs);

      // Materialize the shared contract per-epic so the worker-prompt builder
      // can read it by epic id at dispatch (gated by policy.agents.shared_contract).
      if (architect.sharedContract && architect.sharedContract.trim().length > 0) {
        SharedContract.write(this.opts.projectRoot, epic.epic_id, architect.sharedContract);
      }
    }

    const storyCount = architect.epics.reduce((n, e) => n + e.stories.length, 0);

    return {
      runId,
      briefPath: analyst.briefPath,
      prdPath: pm.prdPath,
      architecturePath: architect.architecturePath,
      epicIds: architect.epics.map((e) => e.epic_id),
      epicPaths: pm.epicPaths,
      storyCount,
      storiesEnriched: architect.storiesEnriched,
      usage,
    };
  }
}

