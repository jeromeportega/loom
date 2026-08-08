import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { LLMClient, LLMUsage } from '../llm/index.js';
import { addUsage, EMPTY_USAGE } from '../llm/index.js';
import { EpicStore, AuditLog, AgentStore, MetricsStore } from '../state/index.js';
import { withRunMetrics } from '../metrics/withRunMetrics.js';
import { SkillSelector } from '../skills/index.js';
import type { SkillStore } from '../skills/index.js';
import type { PlannerContext } from './context.js';
import { AnalystAgent } from './AnalystAgent.js';
import { PMAgent } from './PMAgent.js';
import { ArchitectAgent } from './ArchitectAgent.js';
import { QAAgent } from './QAAgent.js';
import { StandaloneStoryAgent } from './StandaloneStoryAgent.js';
import { SharedContract } from '../orchestrator/SharedContract.js';
import { loadOwnershipMap, computeWithinEpicOverlaps } from '../orchestrator/ContractOwnership.js';
import { deriveSameFileSerialization } from '../orchestrator/SerializeOverlaps.js';
import type { SerializationEdge } from '../orchestrator/SerializeOverlaps.js';
import { reconcileProvidesRequires } from './contractReconcile.js';
import type { ClosureResult } from './contractReconcile.js';
import { epicId, epicNumber, storyId, idNumber, planningPaths, planningRelPaths } from './paths.js';
import { PlanningOutputSink } from './PlanningOutputSink.js';
import type { PlanningEvent } from './PlanningEvent.js';
import { startPhase, endPhase } from '../metrics/timing.js';
import { activeCollector } from '../metrics/activeCollector.js';
import { buildRunAttribution } from '../metrics/runAttribution.js';
import { serializeEpic } from './epicSerializer.js';
import type { EpicYaml } from '../types.js';
import type { EffectiveRouting } from '../intake/routing.js';
// Physical-separation invariant: Planner.js must not contain value imports from
// the classifier module or the broader intake module tree (enforced at test time).
// These three helpers mirror the canonical definitions in routing.ts and are inlined
// here so the compiled JS carries no such references. A sync-check test in
// planner/__tests__/physicalSeparation.test.ts imports these exported copies and
// compares them against the routing.ts originals so any drift is caught at CI time.
export function _plannerIsStandalone(routing?: EffectiveRouting): boolean {
  return routing !== undefined && routing.size === 'story';
}
export function _plannerStandaloneStoryId(containerEpicId: string): string {
  return containerEpicId.replace(/^epic-/, 'story-');
}
export function _plannerStandaloneBranch(storyId: string): string {
  return `story/${storyId}`;
}
// Private aliases used within this module (avoid prefixed names in internal call sites).
const isStandalone = _plannerIsStandalone;
const standaloneStoryId = _plannerStandaloneStoryId;
const standaloneBranch = _plannerStandaloneBranch;

export interface PlanResult {
  runId: string;
  briefPath: string;
  prdPath: string;
  architecturePath: string;
  epicIds: string[];
  epicPaths: string[];
  storyCount: number;
  storiesEnriched: number;
  /**
   * True when the Architect tech_notes enrichment genuinely failed (no attempt
   * parsed after retries), vs a valid-but-empty result. The planning gate hard-
   * blocks a plan with failed enrichment. Always false on the standalone path
   * (which produces its own inline tech_notes without the Architect step).
   */
  techNotesEnrichmentFailed: boolean;
  /**
   * Plan-time provides/requires closure result (Slice 1 of the canonical
   * contract). Present on the full-epic path; absent on the standalone path
   * (a single story has no siblings to reconcile). `ok === false` means the
   * decomposition has an unsatisfiable story dependency and the CLI gate hard-
   * fails the plan. WARN-kind violations may be present with `ok === true`.
   */
  reconciliation?: ClosureResult;
  usage: LLMUsage;
  /**
   * Set only on the standalone-story path (intake_routing + size='story').
   * Carries the user-facing story-NNN id (derived from the container epicId)
   * so CLI surfaces can present the standalone story with story framing instead
   * of the epic-NNN container id. Absent on all full-epic and off-path runs.
   */
  standaloneStoryId?: string;
}

export interface PlannerOptions {
  projectRoot: string;
  /**
   * Pre-resolved planning root (e.g. `RepoStatePaths.planningRoot`).
   * When absent, defaults to `<projectRoot>/.loom/planning` for backward
   * compatibility with callers that pre-date loom-home relocation.
   */
  planningRoot?: string;
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
   * SHARED_CONTRACT === 'on'. Drives the Architect's optional
   * shared-contract pass and its per-epic persistence for worker injection.
   */
  sharedContract?: boolean;
  /**
   * QA_PLANNING === 'advisory'. Runs the QA persona (Tessa)
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
  /**
   * Effective routing from the intake classifier. When present the PM agent
   * appends a sizing constraint block to its task B prompt (story-045-002).
   * Absent ⇒ PM prompt is byte-identical to the legacy baseline (NFR-1).
   */
  routing?: EffectiveRouting;
}

/**
 * Orchestrates the planning pipeline: Analyst -> PM -> Architect, fully
 * headless. Persists the resulting epics to the DB with status 'planned' and
 * leaves them awaiting the human approval gate (`loom approve`).
 */
export class Planner {
  constructor(private opts: PlannerOptions) {}

  private get planningRoot(): string {
    return this.opts.planningRoot ?? path.join(this.opts.projectRoot, '.loom', 'planning');
  }

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
    // Include archived and standalone rows — id numbering is shared across ALL
    // rows regardless of prefix ('epic-NNN' or 'story-NNN'). idNumber() parses
    // both so a story-NNN row is never invisible to the counter (NFR-4).
    const maxNum = epicStore
      .list({ includeArchived: true, includeStandalone: true })
      .reduce((max, e) => Math.max(max, idNumber(e.id)), 0);
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
    if (isStandalone(this.opts.routing)) {
      return withRunMetrics(
        { scope: 'standalone_story', store: new MetricsStore(this.opts.db) },
        () => this.runBody(brief, reservedId),
      );
    }
    return withRunMetrics(
      { scope: 'epic', store: new MetricsStore(this.opts.db) },
      () => this.runBody(brief, reservedId),
    );
  }

  private async runBody(brief: string, reservedId?: string): Promise<PlanResult> {
    const epicStore = new EpicStore(this.opts.db);
    const startedAt = Date.now();

    let runId: string;
    if (reservedId !== undefined) {
      // Pre-reserved by the caller: adopt the id, do not allocate again. The
      // row already exists (status 'planning') so we skip beginPlanning here.
      // The caller reserves BEFORE classification knows the size, so a
      // standalone run arrives with an epic-NNN id — repoint the reserved row
      // to its story-NNN identity (story-059-002) so runStandalone's PK is the
      // story id, never an epic-NNN container. No-op for non-standalone runs.
      runId = isStandalone(this.opts.routing)
        ? epicStore.repointReservationToStandalone(reservedId)
        : reservedId;
    } else {
      // Globally-unique id numbering: draw from the shared counter that spans
      // both 'epic-NNN' and 'story-NNN' rows (nextEpicId counts via idNumber).
      const nextId = Planner.nextEpicId(this.opts.db);

      if (isStandalone(this.opts.routing)) {
        // Standalone path: format the number as story-NNN. Reserve the row
        // immediately (before any LLM work) so concurrent planners cannot
        // allocate the same number (analogous to beginPlanning for epics).
        runId = storyId(idNumber(nextId));
        if (idNumber(runId) === 0) {
          throw new Error(
            `[internal] standalone runId resolved to story-000 — nextEpicId returned unexpected format: ${nextId}`
          );
        }
        epicStore.beginStandalonePlanning(runId, brief);
      } else {
        // Epic path: reserve the row IMMEDIATELY so observers (`loom web`,
        // `loom status`) can see "what kicked off this job?" before the
        // Analyst → PM → Architect chain finishes (~5 min). The placeholder
        // is updated through phases and flipped to 'planned' at the end.
        // On a planner crash, the catch block below records status 'failed'
        // with the error message in `epics.error` — distinct from a human
        // 'rejected' verdict (ADR-4, FR-5).
        runId = nextId;
        epicStore.beginPlanning(runId, brief);
      }
    }
    const startNum = idNumber(runId);

    // Create a planning output sink that captures streamed text, redacts
    // secrets, and flushes to epics.planning_log_tail on the periodic timer.
    // This happens regardless of onPlanningEvent — the tail is always durable.
    const sink = new PlanningOutputSink(runId, epicStore, this.opts.onPlanningEvent);

    // Wrap the LLM so every complete() call injects onText into the request.
    // Agents use ctx.llm and never call this.opts.llm directly, so the
    // wrap is transparent — no agent needs to be modified.
    const wrappedLlm: LLMClient = {
      complete: (req) =>
        this.opts.llm.complete({
          ...req,
          onText: (d) => { req.onText?.(d); sink.handleChunk(d); },
        }),
    };

    const ctx: PlannerContext = {
      projectRoot: this.opts.projectRoot,
      planningRoot: this.planningRoot,
      llm: wrappedLlm,
      model: this.opts.model,
      runId,
      skills: this.selectSkills(brief),
      sharedContract: this.opts.sharedContract,
      qaPlanning: this.opts.qaPlanning,
      routing: this.opts.routing,
    };
    const rel = planningRelPaths(runId, this.planningRoot, this.opts.projectRoot);
    let usage: LLMUsage = { ...EMPTY_USAGE };

    sink.start();
    try {
      // ─── Analyst: brief -> project-brief.md ───────────────────────────
      startPhase('analyst');
      sink.setPhase('analyst');
      const analyst = await new AnalystAgent(ctx).run(brief);
      usage = addUsage(usage, analyst.usage);
      endPhase('analyst');

      // ─── Routing branch: standalone story or full epic pipeline ───────
      // Branch AFTER the Analyst so the refined brief is available on both
      // paths. isStandalone(undefined) === false: the off-path and any
      // classification failure can never enter the standalone branch.
      if (isStandalone(this.opts.routing)) {
        return await this.runStandalone(runId, startedAt, epicStore, ctx, analyst, usage);
      }

      epicStore.updatePlanningPhase(runId, 'pm');

      // ─── PM: brief -> prd.md + epic YAMLs ─────────────────────────────
      startPhase('pm');
      sink.setPhase('pm');
      const pm = await new PMAgent(ctx).run(analyst.briefContent, startNum);
      usage = addUsage(usage, pm.usage);
      endPhase('pm');
      epicStore.updatePlanningPhase(runId, 'architect');

      // ─── Architect: prd + epics -> architecture.md + enriched epics ───
      startPhase('architect');
      sink.setPhase('architect');
      const architect = await new ArchitectAgent(ctx).run(pm.prdContent, pm.epics);
      usage = addUsage(usage, architect.usage);
      endPhase('architect');

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

  /**
   * Standalone-story path: Analyst output → StandaloneStoryAgent → one Story.
   * No PM, no Architect decomposition pass. Persists:
   *   - epics row with kind='standalone' and status='planned'
   *   - one agents row with story_id and branch_name per §5 identity scheme
   *   - one YAML file (EpicYaml envelope with the single story) on disk
   */
  private async runStandalone(
    runId: string,
    startedAt: number,
    epicStore: EpicStore,
    ctx: PlannerContext,
    analyst: Awaited<ReturnType<AnalystAgent['run']>>,
    usageSoFar: LLMUsage
  ): Promise<PlanResult> {
    // runId IS already story-NNN (formatted by Planner.run before calling here).
    // No epic-NNN derivation — the story id is the primary identity (NFR-4).
    if (!runId.startsWith('story-')) {
      throw new Error(`[internal] runStandalone: expected story-NNN id, got '${runId}'`);
    }
    const { story, usage: storyUsage } = await new StandaloneStoryAgent(ctx).run(
      analyst.briefContent,
      runId
    );
    const usage = addUsage(usageSoFar, storyUsage);
    const durationMs = Date.now() - startedAt;
    const rel = planningRelPaths(runId, this.planningRoot, this.opts.projectRoot);
    const paths = planningPaths(this.planningRoot, runId);

    // Write the YAML file before the transaction so a disk-full error doesn't
    // leave the DB row committed but the plan file missing.
    const epicYaml: EpicYaml = {
      epic_id: runId,
      title: story.title,
      status: 'planned',
      priority: 'must-have',
      prd_ref: rel.brief,
      requirements: [],
      stories: [story],
    };
    fs.mkdirSync(paths.epicsDir, { recursive: true });
    const yamlPath = paths.epicFile(runId);
    fs.writeFileSync(yamlPath, serializeEpic(epicYaml));

    // Atomically commit epics + agents in one transaction. The row's PK IS
    // story-NNN — no epic-NNN container intermediate. Covering both writes
    // prevents a crash between them from leaving either:
    //  - an epics row with kind='standalone' but no agents row → Supervisor finds a stuck epic
    //  - an agents row with no epics row → FK violation
    const agentStore = new AgentStore(this.opts.db);
    this.opts.db.transaction(() => {
      epicStore.createStandalone(runId, story.title);
      const agent = agentStore.create(runId, runId, story.title);
      agentStore.updateStatus(agent.id, 'pending', { branch_name: standaloneBranch(runId) });
    })();

    // Both paths (brief and yaml) are known at this point — write in one call.
    epicStore.updatePaths(runId, { brief_path: rel.brief, yaml_path: rel.epicFile(runId) });
    epicStore.updateTokens(runId, usage, durationMs);

    // Terminal region (story-065-004): set run attribution before withRunMetrics.finally fires.
    // Fail-open (ADR-006) — attribution errors must never abort the planning run.
    try {
      const priorRunCount = (this.opts.db
        .prepare('SELECT COUNT(*) AS n FROM run_metrics WHERE story_id = ?')
        .get(runId) as { n: number } | undefined)?.n ?? 0;
      const sr = this.opts.routing;
      activeCollector()?.setAttribution(buildRunAttribution({
        scope: 'standalone_story',
        storyId: runId,
        intakeVerdict: (sr?.size === 'story' || sr?.size === 'epic') ? sr.size : undefined,
        intakeKind: sr?.type,
        storyCount: 1,
        retryCount: priorRunCount,
        cleanRetryCount: 0,
        autoRecoveryCount: 0,
        outcome: 'done',
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
      }));
    } catch {
      // fail-open — attribution must never propagate into the planning run
    }

    return {
      runId,
      briefPath: analyst.briefPath,
      prdPath: '',
      architecturePath: '',
      epicIds: [runId],
      epicPaths: [yamlPath],
      storyCount: 1,
      // StandaloneStoryAgent produces a fully specified story (including tech_notes)
      // in a single pass — equivalent to what the Architect's enrichment pass does
      // for the epic pipeline. Report 1 so CLI output is accurate.
      storiesEnriched: 1,
      // Standalone produces its own inline tech_notes (no Architect step), so
      // enrichment can never be in the failed state here.
      techNotesEnrichmentFailed: false,
      usage,
      // Signal to CLI surfaces that this is a standalone story (runId IS story-NNN).
      standaloneStoryId: runId,
    };
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
      // can read it by epic id at dispatch (gated by SHARED_CONTRACT).
      if (architect.sharedContract && architect.sharedContract.trim().length > 0) {
        SharedContract.write(this.opts.projectRoot, epic.epic_id, architect.sharedContract);
      }
    }

    const storyCount = architect.epics.reduce((n, e) => n + e.stories.length, 0);

    // Serialize same-file story groups: derive dependency edges for stories
    // that edit the same file, ensuring they integrate sequentially.
    const audit = new AuditLog(this.opts.db);
    applySameFileSerialization(architect.epics, this.opts.projectRoot, audit, runId, this.planningRoot);

    // Reconciliation gate input (computed AFTER serialization so the `unordered`
    // ordering check sees any dependency edges the serializer injected). Universe
    // = every story across every epic/repo in the run, since `requires` resolves
    // by global story id. The CLI hard-fails when `ok === false`.
    const reconciliation = reconcileProvidesRequires(
      architect.epics.flatMap((e) => e.stories)
    );

    // Terminal region (story-065-004): set run attribution for the epic planning path.
    // Fail-open (ADR-006) — attribution errors must never abort the planning run.
    try {
      const priorRunCount = (this.opts.db
        .prepare('SELECT COUNT(*) AS n FROM run_metrics WHERE epic_id = ?')
        .get(runId) as { n: number } | undefined)?.n ?? 0;
      const r = this.opts.routing;
      activeCollector()?.setAttribution(buildRunAttribution({
        scope: 'epic',
        epicId: runId,
        intakeVerdict: (r?.size === 'story' || r?.size === 'epic') ? r.size : undefined,
        intakeKind: r?.type,
        storyCount,
        retryCount: priorRunCount,
        cleanRetryCount: 0,
        autoRecoveryCount: 0,
        outcome: 'done',
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
      }));
    } catch {
      // fail-open — attribution must never propagate into the planning run
    }

    return {
      runId,
      briefPath: analyst.briefPath,
      prdPath: pm.prdPath,
      architecturePath: architect.architecturePath,
      epicIds: architect.epics.map((e) => e.epic_id),
      epicPaths: pm.epicPaths,
      storyCount,
      storiesEnriched: architect.storiesEnriched,
      techNotesEnrichmentFailed: architect.techNotesEnrichmentFailed,
      reconciliation,
      usage,
    };
  }
}

/**
 * Integration hook called in `persistPlanResult` after Architect Task C and
 * optional QA enrichment. For each epic that has a shared contract, detects
 * stories editing the same file (via `computeWithinEpicOverlaps`) and adds
 * dependency edges that serialize them into a total order, so no two same-file
 * stories remain mutually unordered at dispatch time.
 *
 * Mutates `story.dependencies` (adds the new edge id) and `story.dependency_reasons`
 * (adds machine-readable provenance). Rewrites the epic YAML on disk. Writes one
 * `AuditLog.record()` row per serialized file with action
 * `'plan_serialize_same_file'`.
 *
 * No-op when no contract exists for an epic, or when no within-epic overlaps
 * are detected (ADR-004 degrade path). Never throws — the caller's happy path
 * must not be blocked by advisory enrichment.
 */
export function applySameFileSerialization(
  epics: EpicYaml[],
  projectRoot: string,
  audit: AuditLog,
  runId?: string,
  planningRoot?: string,
): void {
  if (epics.length === 0) return;

  // All epics in a planning run share <planningRoot>/<runId>/epics/.
  // The caller passes the true runId; we fall back to epics[0].epic_id for
  // single-epic callers (tests, standalone) where they are the same.
  const resolvedRunId = runId ?? epics[0].epic_id;
  const effectivePlanningRoot = planningRoot ?? path.join(projectRoot, '.loom', 'planning');
  const paths = planningPaths(effectivePlanningRoot, resolvedRunId);

  for (const epic of epics) {
    // Per-epic guard: advisory serialization must never abort the planning run.
    try {
      let ownerMap;
      try {
        ownerMap = loadOwnershipMap(projectRoot, epic.epic_id);
      } catch {
        continue; // no contract file → degrade gracefully
      }
      if (!ownerMap) continue;

      const overlaps = computeWithinEpicOverlaps(ownerMap);
      if (overlaps.length === 0) continue;

      const edges = deriveSameFileSerialization(epic.stories, overlaps);
      if (edges.length === 0) continue;

      // Mutate stories in memory: add dependency and provenance.
      for (const edge of edges) {
        const story = epic.stories.find((s) => s.id === edge.from);
        if (!story) continue;

        if (!story.dependencies.includes(edge.dependsOn)) {
          story.dependencies.push(edge.dependsOn);
        }

        if (!story.dependency_reasons) story.dependency_reasons = [];
        const alreadyRecorded = story.dependency_reasons.some(
          (r) => r.depends_on === edge.dependsOn && r.path === edge.path
        );
        if (!alreadyRecorded) {
          story.dependency_reasons.push({
            depends_on: edge.dependsOn,
            reason: 'same-file-conflict-avoidance',
            path: edge.path,
          });
        }
      }

      // Rewrite the epic YAML with the enriched story data.
      try {
        fs.writeFileSync(
          paths.epicFile(epic.epic_id),
          serializeEpic(epic, 'and serialized (overlap resolution)'),
        );
      } catch (err) {
        // ENOENT means the parent dir doesn't exist yet (e.g. tests that don't
        // pre-create the YAML). Rethrow anything else (disk full, permissions)
        // so the outer catch records it and continues gracefully.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      // One audit row per shared file (Seam-6).
      const edgesByPath = new Map<string, SerializationEdge[]>();
      for (const edge of edges) {
        const list = edgesByPath.get(edge.path);
        if (list) list.push(edge);
        else edgesByPath.set(edge.path, [edge]);
      }

      for (const [filePath, fileEdges] of edgesByPath) {
        // Reconstruct the total order from fileEdges (already emitted in chain
        // order by deriveSameFileSerialization) rather than re-sorting
        // overlap.owners, which may include cross-epic owner entries.
        const chain: string[] = [];
        for (const e of fileEdges) {
          if (!chain.includes(e.dependsOn)) chain.push(e.dependsOn);
          if (!chain.includes(e.from)) chain.push(e.from);
        }

        audit.record({
          action: 'plan_serialize_same_file',
          command: epic.epic_id,
          detail: {
            path: filePath,
            chain,
            added_edges: fileEdges.map((e) => ({ from: e.from, dependsOn: e.dependsOn })),
          },
        });
      }
    } catch {
      // Unexpected error: skip this epic and continue to the next.
    }
  }
}

