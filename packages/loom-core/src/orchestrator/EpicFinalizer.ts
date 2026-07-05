import { execFileSync } from 'node:child_process';
import { minimatch } from 'minimatch';
import type Database from 'better-sqlite3';
import { EpicStore, AgentStore, AuditLog, LeaseStore } from '../state/index.js';
import type { Story, EpicRecord } from '../types.js';
import type { AutoRetrospective } from './AutoRetrospective.js';
import { EpicYamlSchema } from '../types.js';
import { gitSafe, defaultRemote, remoteUrl } from './git.js';
import { WorktreeManager } from './WorktreeManager.js';
import { IntegrationGate } from './IntegrationGate.js';
import type { GateMode, GateOutcome } from './IntegrationGate.js';
import { IntegrationBranch } from './IntegrationBranch.js';
import type { PrStrategy } from './BaseCliWorker.js';
import type { LLMClient } from '../llm/index.js';
import { PrDescriptionAgent } from '../review/index.js';
import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import { SignalLedger } from './signalStore.js';
import { renderBuildSignalAnalysis } from './signalRender.js';
import { resolveLoomHomePath } from '../home/resolveLoomHomePath.js';
import { ensureLoomHome } from '../home/ensureLoomHome.js';
import { routeArtifacts } from '../home/artifactRouter.js';
import { commitArtifacts } from '../home/commitArtifacts.js';

export interface EpicFinalizerOptions {
  projectRoot: string;
  db: Database.Database;
  /** policy.git.allowed_remotes — gates where loom may push. */
  allowedRemotes: string[];
  /** policy.agents.pr_strategy — controls whether finalize runs at all. */
  prStrategy: PrStrategy;
  /**
   * Optional LLM client + model — when set, the finalizer asks the
   * PrDescriptionAgent to generate the PR body from the diff + commit log +
   * story context. Falls back to a hand-rolled body when unset or on error.
   */
  llmClient?: LLMClient;
  llmModel?: string;
  /**
   * policy.agents.pr_attribution — when 'on', the finalizer prepends a
   * "Loom built this" provenance block to every PR body so reviewers can
   * tell loom generated it. Off by default (operators opt in per repo).
   */
  prAttribution?: 'off' | 'on';
  /**
   * policy.agents.push_gate — when 'confirm', the finalizer stops at the
   * local merge. No push, no PR. The operator inspects the diff and runs
   * `git push` + `gh pr create` themselves. Off by default — the existing
   * push-immediately-after-merge behavior.
   */
  pushGate?: 'off' | 'confirm';
  /**
   * policy.agents.integration_gate — runs the build/test suite on the merged
   * epic branch before the PR opens. 'off' skips it; 'warn' annotates + audits
   * on failure but still opens the PR; 'block' withholds the PR on failure.
   * Default 'off' here so existing callers/tests are unchanged; the CLI/MCP
   * wire the policy value through.
   */
  integrationGate?: GateMode;
  /** policy.agents.test_command — explicit gate command (else auto-detected). */
  testCommand?: string;
  /** policy.agents.integration_gate_timeout_minutes, in ms. */
  integrationGateTimeoutMs?: number;
  /** Injectable gate (tests). Defaults to one built from the fields above. */
  gate?: IntegrationGate;
  /**
   * policy.agents.integration_branch. When 'rolling', the Supervisor already
   * merged each story into a live `epic/<id>` as it completed, so finalize
   * skips the big-bang merge: it reconciles any unmerged story (crash safety),
   * runs the gate in the integration worktree, and pushes. 'off' (default) is
   * the legacy big-bang merge in the main checkout.
   */
  integrationBranch?: 'off' | 'rolling';
  /**
   * Late-bound policy refresh. The supervisor / approve handler captures a
   * snapshot at approve time, but several finalize-relevant fields can change
   * mid-run (the operator hardens test_command, fills in allowed_remotes, etc.).
   * When set, finalize() calls this at entry, re-reads the listed fields, and
   * uses the live values. Emits an `epic_policy_rebound` audit row if any
   * field differs from the snapshot, so operators see exactly when their
   * edit took effect (or didn't).
   *
   * Throw vs `{}` contract: `rebindLatebound` wraps this in try/catch and
   * treats a throw as a NO-OP (preserves the current effective values). The
   * call site should LET a `PolicyEngine.load` failure throw rather than
   * silently returning `{}` — returning empty makes the `undefined` guards
   * below treat a transient YAML parse error as "no fields set" and would
   * skip rebinds even when policy intentionally changed values. See
   * `Supervisor.rebindIntegratorGateIfChanged` for the integrator twin.
   */
  refreshPolicy?: () => LateboundFinalizerPolicy;
  /**
   * Injectable push seam (tests). Defaults to `git push -u <remote> <branch>`.
   * Lets a unit test drive the push step deterministically — without a real
   * remote or network — while keeping `finalize()`'s signature unchanged.
   */
  pushBranch?: (remote: string, branch: string) => { ok: boolean; output: string };
  /**
   * Injectable PR-open seam (tests). Defaults to `gh pr create …`. Returns the
   * captured PR URL (or undefined when `gh` printed none). A throw is treated
   * exactly like a `gh` failure — the existing pushed-but-no-PR fallback. Lets
   * a unit test exercise the happy PR path with no shell / network.
   */
  openPr?: (input: { branch: string; title: string; body: string }) => string | undefined;
  /**
   * Injectable open-PR probe (FR-11). After this epic's PR is recorded, the
   * finalizer asks "do OTHER epic/* branches also have open PRs?" — if so, it
   * prints a one-line hint pointing the operator at
   * `loom doctor --cross-epic-gate` so they can check the epics still land
   * together. Returns the head-branch names of other epic/* branches with an
   * open PR (excluding `epicBranch`). Defaults to a `gh pr list` probe; a
   * throw or any error is swallowed (the hint is advisory, never blocking).
   */
  openEpicPrs?: (epicBranch: string) => string[];
  /**
   * Optional auto-retrospective. When set, finalize calls run() after each
   * epic_finalize audit row and after the failed (all-conflicts) exit path.
   * Best-effort: any error from run() is caught here and recorded as
   * `auto_retro_skipped` so the finalize result is never affected (ADR-001).
   */
  autoRetro?: AutoRetrospective;
  /**
   * policy.loom_home — path to the loom-home repository. Falls back to the
   * sibling-of-projectRoot heuristic in resolveLoomHomePath when omitted.
   */
  loomHome?: string;
  /**
   * Injectable PR-existence probe (FR-10). Defaults to `gh pr view --head <ref>`.
   * Returns `{ exists: true, url }` when a live PR is found for the given
   * finalizer-owned ref, or `{ exists: false }` when none is found or gh fails.
   */
  prForRef?: (finalizeRef: string) => { exists: boolean; url?: string };
  /**
   * Injectable remote-ref-existence probe (FR-12). Defaults to `git ls-remote`.
   * Returns true when the given ref exists on the remote.
   */
  remoteRefExists?: (remote: string, finalizeRef: string) => boolean;
  /**
   * Injectable integration-head probe (FR-11). Defaults to `git rev-parse epic/<id>`.
   * Returns true when the local `epic/<epicId>` branch HEAD starts with the
   * sha7 suffix embedded in `ref` (`loom/finalize/<id>-<sha7>`).
   */
  integrationHeadMatchesRef?: (epicId: string, ref: string) => boolean;
  /**
   * Injectable LeaseStore for serialising concurrent resume() calls (NFR-1).
   * Defaults to a fresh LeaseStore backed by the same db.
   */
  leaseStore?: LeaseStore;
  /**
   * Injectable remote resolver for resume() (tests). Defaults to
   * `defaultRemote(projectRoot)`. Returning null means "no remote configured"
   * and causes resume() to return a noop-terminal result.
   */
  resolveRemote?: () => string | null;
}

/** Subset of policy fields the finalizer re-reads at finalize entry. */
export interface LateboundFinalizerPolicy {
  allowedRemotes?: string[];
  testCommand?: string;
  integrationGate?: GateMode;
  pushGate?: 'off' | 'confirm';
  prAttribution?: 'off' | 'on';
}

export interface FinalizeResult {
  /** PR url if one was opened. */
  url?: string;
  /**
   * Human-readable status — 'skipped' / 'merged' / 'partial' / 'failed' / 'gated' /
   * 'publish_pending'. 'publish_pending' is returned when the push or PR-open could not
   * complete (push rejected, remote disallowed, PR-open failed) — the finalizer records
   * the state and a recovery command (`loom publish`) can resolve it later.
   */
  status: 'skipped' | 'merged' | 'partial' | 'failed' | 'gated' | 'publish_pending';
  /** Story ids that fell back to their own PR because of a merge conflict. */
  conflicted: string[];
  /** Story ids successfully folded into the epic branch. */
  merged: string[];
  /**
   * Story ids whose worktree + branch were pruned after a successful merge.
   * Their work is preserved on the epic branch via the --no-ff merge commits.
   */
  cleaned: string[];
  /** Free-form message for the audit log / user output. */
  note: string;
}

/**
 * The resume-plan union returned by detectResumePhase. Each arm represents the
 * remaining work resume() must execute to land the epic as done. Arms are
 * derived from persisted state + live remote queries with no session context
 * (FR-4), so they are safe across process invocations.
 */
export type ResumePlan =
  | { action: 'already-done'; prUrl: string }          // DB + remote agree: epic is done
  | { action: 'record-pr'; prUrl: string }              // remote has PR, DB missing it (FR-10)
  | { action: 'open-pr'; finalizeRef: string }          // ref pushed, no PR yet
  | { action: 'push-and-open'; finalizeRef: string }    // local branch OK, ref not on remote
  | { action: 'full-finalize' }                         // sha mismatch or no ref (FR-11)
  | { action: 'noop-terminal'; note: string };          // no usable remote

/** Context passed to publishPhase for the terminal push/PR/done sequence. */
export interface PublishCtx {
  finalizeRef: string;
  remote: string | null;
}

/**
 * Builds an epic-level PR from the story branches a loom run produced.
 *
 * On finalize:
 *   1. Read the epic's base_sha (captured by the Supervisor on first dispatch).
 *   2. Topologically order the succeeded story branches by their declared
 *      dependencies (planner output).
 *   3. Create `epic/<epic-id>` at base_sha; merge each story branch in order.
 *   4. On a merge conflict, abort the merge and record the story id; the
 *      finalize result tells the caller to fall back to a per-story PR for
 *      that story (or simply leave the work on the story branch).
 *   5. Push `epic/<epic-id>` (subject to allowed_remotes) and `gh pr create`
 *      one PR with a body that lists each merged story.
 *
 * The finalizer never runs in 'per-story' mode; the caller decides.
 */
export class EpicFinalizer {
  private gate: IntegrationGate;
  private gateMode: GateMode;
  private readonly rolling: boolean;
  private readonly integration: IntegrationBranch;
  /** Effective late-bound values for the current finalize() call. */
  private effectiveAllowedRemotes: string[];
  private effectivePushGate: 'off' | 'confirm';
  private effectivePrAttribution: 'off' | 'on';
  /**
   * Running effective `test_command`. Tracked separately from `opts.testCommand`
   * (which is immutable) so multi-epic runs that share one finalizer instance
   * don't re-fire `epic_policy_rebound` every finalize after the first rebind:
   * the prior compare-and-update against `opts.testCommand` left this stale,
   * so a single mid-run YAML change emitted a spurious audit row + redundant
   * gate rebuild for every subsequent epic. Mirrors the Supervisor's
   * `effectiveIntegratorTestCommand`.
   */
  private effectiveTestCommand?: string;

  constructor(private opts: EpicFinalizerOptions) {
    this.gateMode = opts.integrationGate ?? 'off';
    this.rolling = opts.integrationBranch === 'rolling';
    this.integration = new IntegrationBranch(opts.projectRoot);
    this.gate =
      opts.gate ??
      new IntegrationGate({
        testCommand: opts.testCommand,
        timeoutMs: opts.integrationGateTimeoutMs ?? 15 * 60_000,
      });
    this.effectiveAllowedRemotes = opts.allowedRemotes;
    this.effectivePushGate = opts.pushGate ?? 'off';
    this.effectivePrAttribution = opts.prAttribution ?? 'off';
    this.effectiveTestCommand = opts.testCommand;
  }

  /**
   * Re-reads late-bound policy fields from disk (when a refresher was wired)
   * and updates the effective values used by THIS finalize() call. Emits an
   * `epic_policy_rebound` audit row when anything differs from the snapshot
   * the supervisor approved with — so operators can see, in the audit log,
   * exactly which of their mid-run edits the run picked up. A null refresher
   * is a no-op (preserves test-friendly explicit-opt construction).
   */
  private rebindLatebound(epicId: string, audit: AuditLog): void {
    if (!this.opts.refreshPolicy) return;
    let live: LateboundFinalizerPolicy;
    try {
      live = this.opts.refreshPolicy();
    } catch {
      return; // Refresher failure is observability — never block finalize.
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (live.allowedRemotes && !sameStringArr(this.effectiveAllowedRemotes, live.allowedRemotes)) {
      changes.allowed_remotes = { from: this.effectiveAllowedRemotes, to: live.allowedRemotes };
      this.effectiveAllowedRemotes = live.allowedRemotes;
    }
    if (live.integrationGate && live.integrationGate !== this.gateMode) {
      changes.integration_gate = { from: this.gateMode, to: live.integrationGate };
      this.gateMode = live.integrationGate;
    }
    if (live.testCommand !== undefined && live.testCommand !== this.effectiveTestCommand) {
      changes.test_command = { from: this.effectiveTestCommand ?? null, to: live.testCommand };
      // The gate is built from testCommand in the constructor; rebuild it
      // so the new command actually runs (was the user's primary pain point).
      this.gate = new IntegrationGate({
        testCommand: live.testCommand,
        timeoutMs: this.opts.integrationGateTimeoutMs ?? 15 * 60_000,
      });
      // Track the rebind so a second finalize() in the same multi-epic run
      // doesn't fire another spurious audit row (the bug the reviewer found:
      // before this line, every subsequent epic's finalize() saw the policy
      // value as "different from the immutable opts.testCommand" again).
      this.effectiveTestCommand = live.testCommand;
    }
    if (live.pushGate && live.pushGate !== this.effectivePushGate) {
      changes.push_gate = { from: this.effectivePushGate, to: live.pushGate };
      this.effectivePushGate = live.pushGate;
    }
    if (live.prAttribution && live.prAttribution !== this.effectivePrAttribution) {
      changes.pr_attribution = { from: this.effectivePrAttribution, to: live.prAttribution };
      this.effectivePrAttribution = live.prAttribution;
    }
    if (Object.keys(changes).length > 0) {
      audit.record({
        agent_id: undefined,
        action: 'epic_policy_rebound',
        command: epicId,
        allowed: true,
        detail: { changes },
      });
    }
  }

  /**
   * FR-11 hint: after recording this epic's PR, check whether OTHER `epic/*`
   * branches also have open PRs and, if so, print a one-line note naming
   * `loom doctor --cross-epic-gate`. The probe is injectable (tests pass a
   * stub); the default shells out to `gh pr list`. Any probe error is
   * swallowed — the hint is purely advisory and must never affect finalize.
   */
  private maybeHintCrossEpicGate(epicBranch: string): void {
    try {
      const probe = this.opts.openEpicPrs ?? defaultOpenEpicPrsProbe(this.opts.projectRoot);
      const others = probe(epicBranch).filter((b) => b && b !== epicBranch);
      if (others.length === 0) return;
      console.log(
        `Note: ${others.length} other epic branch${others.length === 1 ? ' has' : 'es have'} ` +
          `an open PR (${others.join(', ')}). Run \`loom doctor --cross-epic-gate\` to check ` +
          'they still merge and pass together before landing.'
      );
    } catch {
      // Advisory only — never let a probe failure disturb finalize.
    }
  }

  /**
   * story-060-001 — STAGE phase: opens the epic PR and runs the integration gate
   * but does NOT merge the GitHub PR. The MERGE phase in CrossRepoCoordinator
   * handles the actual GitHub PR merge via the injected `mergeRepo` seam (story-060-002).
   *
   * Safety analysis — why delegating to finalize() is safe for STAGE:
   *   finalize() does LOCAL git merges (story branches → epic/<id>) and calls
   *   `gh pr create` to OPEN a PR. It never calls `gh pr merge`. The returned
   *   status 'merged'/'partial' refers to the local epic-branch assembly state,
   *   not the GitHub PR merge state. Current prStrategy variants:
   *     - 'per-story': returns 'skipped' immediately — no PR opened, no merge
   *     - 'epic' (default): opens a GitHub PR; never auto-merges it
   *   If a future prStrategy variant adds auto-merge behaviour (i.e. calls
   *   `gh pr merge` or equivalent), this delegation MUST be updated to guard
   *   against it — the STAGE phase must never merge the GitHub PR (ADR-002).
   *
   * This is additive: the existing `finalize()` single-repo path is unchanged (FR-9).
   */
  async stageForLanding(epicId: string): Promise<FinalizeResult> {
    return this.finalize(epicId);
  }

  async finalize(epicId: string): Promise<FinalizeResult> {
    if (this.opts.prStrategy === 'per-story') {
      return {
        status: 'skipped',
        conflicted: [],
        merged: [],
        cleaned: [],
        note: 'pr_strategy=per-story — finalize is a no-op',
      };
    }

    const epicStore = new EpicStore(this.opts.db);
    const agentStore = new AgentStore(this.opts.db);
    const audit = new AuditLog(this.opts.db);
    // Re-read late-bound policy fields before anything else, so the gate
    // we run and the remotes we push to reflect any mid-run policy edits.
    this.rebindLatebound(epicId, audit);
    const epic = epicStore.get(epicId);
    if (!epic) {
      return {
        status: 'failed',
        conflicted: [],
        merged: [],
        cleaned: [],
        note: `Epic ${epicId} not found`,
      };
    }
    if (!epic.base_sha) {
      return {
        status: 'failed',
        conflicted: [],
        merged: [],
        cleaned: [],
        note: `Epic ${epicId} has no base_sha — was it dispatched by this Supervisor?`,
      };
    }

    // Load the story dependency graph from the epic's planned YAML.
    let stories: Story[];
    try {
      stories = this.loadStories(epic.yaml_path);
    } catch (err) {
      return {
        status: 'failed',
        conflicted: [],
        merged: [],
        cleaned: [],
        note: `Could not load epic YAML: ${(err as Error).message}`,
      };
    }
    const ordered = topoSort(stories);

    // Only merge successfully-completed stories.
    const succeeded = new Set<string>();
    for (const agent of agentStore.listByEpic(epicId)) {
      if (agent.status === 'done' || agent.status === 'pr_open') {
        succeeded.add(agent.story_id);
      }
    }
    const toMerge = ordered.filter((s) => succeeded.has(s.id));
    if (toMerge.length === 0) {
      return {
        status: 'skipped',
        conflicted: [],
        merged: [],
        cleaned: [],
        note: 'no succeeded stories to finalize',
      };
    }

    const epicBranch = `epic/${epicId}`;

    // ── Finalize overlay (ADR-1/ADR-2): status='finalizing' with a live phase
    // marker around each step, a thin observability layer over the unchanged
    // merge/gate/push/PR logic below. We never move an existing early-return —
    // each phase marker is set just before its step so a reader sees exactly
    // how far finalize got (and where a PR-less success stopped).
    epicStore.beginFinalizing(epicId, 'merging');

    const merged: string[] = [];
    const conflicted: string[] = [];
    // The directory whose checkout is on epic/<id> — where the gate runs and
    // the artifact commit lands. Legacy: the main checkout. Rolling: the
    // dedicated integration worktree (the main checkout is never disturbed).
    let gitRoot: string;

    if (this.rolling) {
      // Rolling integration: the Supervisor merged each story into epic/<id> as
      // it completed. Reuse that integration worktree and reconcile any
      // succeeded-but-unmerged story (crash between "done" and merge-back) —
      // idempotent (already-merged stories report "Already up to date"). NEVER
      // reset the branch; that would discard the work already integrated.
      let info;
      try {
        info = this.integration.ensure(epicId, epic.base_sha);
      } catch (err) {
        return {
          status: 'failed',
          conflicted: [],
          merged: [],
          cleaned: [],
          note: `Could not open integration worktree for ${epicBranch}: ${(err as Error).message}`,
        };
      }
      gitRoot = info.path;
      for (const story of toMerge) {
        const o = this.integration.mergeStory(epicId, story.id, story.title);
        if (o.ok) {
          merged.push(story.id);
          continue;
        }
        conflicted.push(story.id);
        audit.record({
          agent_id: undefined,
          action: 'epic_finalize_conflict',
          command: story.id,
          allowed: false,
          detail: { epicId, rolling: true, output: o.output },
        });
      }
    } else {
      gitRoot = this.opts.projectRoot;
      // Legacy: recreate epic/<id> from base_sha each finalize. Idempotent for
      // retry — `-f` resets the branch.
      const setup = gitSafe(this.opts.projectRoot, ['branch', '-f', epicBranch, epic.base_sha]);
      if (!setup.ok) {
        return {
          status: 'failed',
          conflicted: [],
          merged: [],
          cleaned: [],
          note: `Could not (re)create ${epicBranch}: ${setup.output}`,
        };
      }
      const checkout = gitSafe(this.opts.projectRoot, ['checkout', epicBranch]);
      if (!checkout.ok) {
        return {
          status: 'failed',
          conflicted: [],
          merged: [],
          cleaned: [],
          note: `Could not check out ${epicBranch}: ${checkout.output}`,
        };
      }
      for (const story of toMerge) {
        const branch = `story/${story.id}`;
        const result = gitSafe(this.opts.projectRoot, [
          'merge',
          '--no-ff',
          '-m',
          `Merge ${story.id}: ${story.title}`,
          branch,
        ]);
        if (result.ok) {
          merged.push(story.id);
          continue;
        }
        // Abort the conflicting merge so subsequent merges can proceed.
        gitSafe(this.opts.projectRoot, ['merge', '--abort']);
        conflicted.push(story.id);
        audit.record({
          agent_id: undefined,
          action: 'epic_finalize_conflict',
          command: story.id,
          allowed: false,
          detail: { epicId, output: result.output.slice(-512) },
        });
      }
    }

    if (merged.length === 0) {
      // Nothing integrated — in rolling mode tear down the empty branch+worktree.
      if (this.rolling) this.integration.removeBranch(epicId);
      // Best-effort retro on the failed path (ADR-001).
      try { await this.opts.autoRetro?.run(epicId, 'failed'); }
      catch (err) { audit.record({ action: 'auto_retro_skipped', command: epicId, allowed: true, detail: { reason: String(err) } }); }
      return {
        status: 'failed',
        conflicted,
        merged,
        cleaned: [],
        note: 'every story produced a merge conflict — falling back to per-story review',
      };
    }

    // ── Integration gate ──────────────────────────────────────────────────
    // Run the build/test suite on the WHOLE epic (cross-story regressions only
    // surface here) and treat any dropped/conflicted story as a failure. In
    // 'block' mode a red gate withholds the PR; in 'warn' it only annotates.
    epicStore.updateFinalizePhase(epicId, 'gate');
    let gateOutcome: GateOutcome | undefined;
    if (this.gateMode !== 'off') {
      gateOutcome = await this.gate.run({ projectRoot: gitRoot, conflicted });
      audit.record({
        agent_id: undefined,
        action: 'epic_integration_gate',
        command: epicId,
        allowed: gateOutcome.ok,
        detail: {
          mode: this.gateMode,
          ok: gateOutcome.ok,
          ran: gateOutcome.ran,
          command: gateOutcome.command,
          exitCode: gateOutcome.exitCode,
          timedOut: gateOutcome.timedOut,
          durationMs: gateOutcome.durationMs,
          amputated: gateOutcome.amputated,
          summary: gateOutcome.summary,
          outputTail: gateOutcome.output.slice(-1000),
        },
      });
      if (this.gateMode === 'block' && !gateOutcome.ok) {
        // Leave epic/<id> + the story worktrees in place for inspection and do
        // NOT push. Flip the epic back to in_progress so a later run can fix it.
        // (Rolling: the integration worktree is kept too, so a re-run resumes.)
        // Artifacts were already promoted above — no second promotion here.
        epicStore.updateStatus(
          epicId,
          'in_progress',
          `integration gate blocked: ${gateOutcome.summary}`.slice(0, 500)
        );
        return {
          status: 'gated',
          conflicted,
          merged,
          cleaned: [],
          note:
            `Integration gate BLOCKED ${epicBranch}: ${gateOutcome.summary} ` +
            'Branch left local for inspection; no PR opened. Fix and re-run, or set ' +
            'policy.agents.integration_gate=warn to land regardless.',
        };
      }
    }

    // Gate passed (or wasn't blocking). The epic is now review-ready: commit
    // planning artifacts to loom-home (ADR-5: merge + gate complete, target work
    // is durable), then prune story worktrees and — unless push-gated — push +
    // open the PR. push-gate=confirm intentionally stops here, so 'review' is
    // the terminal phase for that PR-less success.
    epicStore.updateFinalizePhase(epicId, 'review');

    // ADR-5: target merge/gate complete; commit artifacts to loom-home now.
    // A loom-home failure sets loom_home_status='pending' but never blocks the
    // push or PR — the finalize critical path is unaffected.
    this.promoteArtifacts(epicId, epic, epicStore);

    // After successful merges, the per-story worktrees + branches are dead
    // weight — every commit is preserved on the epic branch via the --no-ff
    // merge commits, so retaining the story branches just clutters
    // `git branch --list` and leaks worktree admin records. Conflicted
    // stories are deliberately skipped: their work only exists on the story
    // branch, so removing it would lose the commits. Best-effort —
    // WorktreeManager.remove uses gitSafe internally and swallows its own
    // errors; we don't block the PR if a single cleanup fails.
    const wt = new WorktreeManager(this.opts.projectRoot);
    const cleaned: string[] = [];
    for (const storyId of merged) {
      wt.remove(storyId, { deleteBranch: true });
      cleaned.push(storyId);
    }
    if (cleaned.length > 0) {
      audit.record({
        agent_id: undefined,
        action: 'epic_finalize_cleanup',
        command: epicId,
        allowed: true,
        detail: { cleaned },
      });
    }

    // Push gate — when the operator opted in with policy.agents.push_gate =
    // 'confirm', stop here. The merge is local; the operator inspects the
    // diff and runs push + gh pr create themselves. Cleanup already ran
    // above, so this is a clean leave-state.
    if (this.effectivePushGate === 'confirm') {
      const note =
        `${epicBranch} ready locally — push gated by policy.agents.push_gate=confirm. ` +
        `Inspect with: git diff ${epic.base_sha}..${epicBranch} ; then push + gh pr create yourself.`;
      audit.record({
        agent_id: undefined,
        action: 'epic_finalize',
        command: epicId,
        allowed: true,
        detail: {
          status: conflicted.length ? 'partial' : 'merged',
          merged,
          conflicted,
          push_gate: 'confirm',
        },
      });
      // Best-effort retro after epic_finalize is durable (ADR-001).
      try { await this.opts.autoRetro?.run(epicId, 'done'); }
      catch (err) { audit.record({ action: 'auto_retro_skipped', command: epicId, allowed: true, detail: { reason: String(err) } }); }
      // PR-less success (ADR-2): a successful run that intentionally never
      // opened a PR. Persist the reason so the row explains itself; the
      // Supervisor's done-gate leaves the status as-is (epic_pr_url is null),
      // so this is the defined terminal-but-not-done state — not stranded.
      epicStore.updateStatus(epicId, 'finalizing', note);
      return {
        status: conflicted.length ? 'partial' : 'merged',
        conflicted,
        merged,
        cleaned,
        note,
      };
    }

    // Push + PR — subject to the same allowed_remotes gate the workers use.
    epicStore.updateFinalizePhase(epicId, 'pushing');
    const remote = defaultRemote(this.opts.projectRoot);
    if (!remote) {
      const note = `${epicBranch} ready locally — no remote configured.`;
      audit.record({
        agent_id: undefined,
        action: 'epic_finalize',
        command: epicId,
        allowed: true,
        detail: { status: conflicted.length ? 'partial' : 'merged', merged, conflicted },
      });
      // PR-less success (ADR-2): no remote to push to. Defined terminal-but-not
      // done state (phase 'pushing'); the Supervisor leaves it (epic_pr_url null).
      epicStore.updateStatus(epicId, 'finalizing', note);
      return {
        status: conflicted.length ? 'partial' : 'merged',
        conflicted,
        merged,
        cleaned,
        note,
      };
    }

    const url = remoteUrl(this.opts.projectRoot, remote);
    if (url && !this.remoteAllowed(url)) {
      const note =
        `${epicBranch} merged locally; not pushed — remote "${url}" is not in ` +
        'policy.git.allowed_remotes.';
      // PR-less success (ADR-2): the remote is disallowed by policy. Same
      // defined terminal-but-not-done state at phase 'pushing'; not stranded.
      epicStore.updateStatus(epicId, 'finalizing', note);
      return {
        status: conflicted.length ? 'partial' : 'merged',
        conflicted,
        merged,
        cleaned,
        note,
      };
    }

    // Resolve the integrated HEAD SHA so the finalizer-owned ref name is
    // deterministic: same integrated tree ⇒ same ref ⇒ retry is a no-op.
    // A different tree (e.g., re-run after a fix) gets a distinct ref.
    const headResult = gitSafe(this.opts.projectRoot, ['rev-parse', epicBranch]);
    if (!headResult.ok) {
      return {
        status: 'failed',
        conflicted,
        merged,
        cleaned,
        note: `failed to resolve HEAD of ${epicBranch}: ${headResult.output}`,
      };
    }
    const integratedHead = headResult.output.trim();
    const finalRef = this.finalizeRef(epicId, integratedHead);

    // FR-1: persist the finalizer-owned ref BEFORE attempting to push, so the
    // ref is durable even if the process dies between the push and the PR open.
    epicStore.recordFinalizeRef(epicId, finalRef);

    // Push the local epicBranch to the finalizer-owned remote ref using a
    // src:dst refspec. The remote finalRef is a fresh name derived from the
    // integrated tree SHA, so this is always a fast-forward (or a new ref) on
    // the remote — no force flag needed or used under any condition.
    const push = this.opts.pushBranch
      ? this.opts.pushBranch(remote, finalRef)
      : gitSafe(this.opts.projectRoot, ['push', remote, `${epicBranch}:${finalRef}`]);
    if (!push.ok) {
      // FR-2: push failure → persist recoverable state via publishPending so the
      // finalize_ref is durably associated and `loom finalize --resume` can retry.
      const note = `${epicBranch} merged but push failed: ${push.output}`;
      epicStore.publishPending(epicId, finalRef, note);
      audit.record({
        agent_id: undefined,
        action: 'epic_publish_pending',
        command: epicId,
        allowed: true,
        detail: { finalizeRef: finalRef, reason: 'push_failed', output: push.output.slice(-512) },
      });
      return {
        status: 'publish_pending',
        conflicted,
        merged,
        cleaned,
        note,
      };
    }

    let body = await this.composeBody(
      epic.title,
      epicBranch,
      epic.base_sha,
      merged,
      conflicted,
      stories
    );
    // Prepend the loom-attribution block when the policy turns it on.
    // Lives outside composeBody so the LLM-driven path and the hand-rolled
    // fallback both get the same provenance header.
    if (this.effectivePrAttribution === 'on') {
      body = loomAttributionBlock(epicId, epic) + '\n\n---\n\n' + body;
    }
    // Surface the integration-gate result in the PR (warn mode lands the PR
    // even on failure, so reviewers need to see it).
    if (gateOutcome) {
      body += '\n\n' + renderGateSection(gateOutcome);
    }
    // Append per-story build signal analysis — read-only readback, never writes
    // (story-010-003, ADR-6). Only appended when at least one signal record exists.
    const signalLedger = new SignalLedger({ db: this.opts.db, projectRoot: this.opts.projectRoot });
    const signalRecords = signalLedger.readEpic(merged);
    if (signalRecords.size > 0) {
      const gateGreen = gateOutcome?.ok ?? null;
      body += '\n\n' + renderBuildSignalAnalysis({
        records: signalRecords,
        outcomes: new Map(merged.map((id) => [id, { reviewFindings: null, gateGreen }])),
        storyOrder: merged,
      });
    }

    epicStore.updateFinalizePhase(epicId, 'opening_pr');
    // epic.id IS story-NNN for standalone rows (story-059-002); no derivation needed.
    const title = `${epicId}: ${epic.title}`;
    let prUrl: string | undefined;
    try {
      prUrl = this.opts.openPr
        ? this.opts.openPr({ branch: finalRef, title, body })
        : (() => {
            const out = execFileSync(
              'gh',
              ['pr', 'create', '--head', finalRef, '--title', title, '--body', body],
              { cwd: this.opts.projectRoot, encoding: 'utf8' }
            );
            return out
              .trim()
              .split('\n')
              .find((l) => l.startsWith('http'));
          })();
    } catch (err) {
      audit.record({
        agent_id: undefined,
        action: 'epic_finalize_pr_failed',
        command: epicId,
        allowed: false,
        detail: { error: (err as Error).message },
      });
      // FR-2: PR-open failure → persist recoverable state via publishPending.
      // The branch is already on the remote; `loom finalize --resume` re-opens
      // the PR without re-merging or re-pushing.
      const note = `${epicBranch} pushed to ${finalRef}; PR open failed — run \`loom publish ${epicId}\` to retry.`;
      epicStore.publishPending(epicId, finalRef, note);
      audit.record({
        agent_id: undefined,
        action: 'epic_publish_pending',
        command: epicId,
        allowed: true,
        detail: { finalizeRef: finalRef, reason: 'pr_open_failed' },
      });
      return {
        status: 'publish_pending',
        conflicted,
        merged,
        cleaned,
        note,
      };
    }

    // Persist the PR URL of record BEFORE any status='done' write (ADR-3
    // write-ordering): the Supervisor's done-gate reads epic_pr_url, so this
    // MUST be durable first. The finalizer itself never writes 'done'. When
    // `gh` opened a PR but printed no parseable URL, treat it as the same
    // PR-less terminal state rather than recording an empty URL.
    if (prUrl) {
      epicStore.recordPrUrl(epicId, prUrl);
      // FR-11: this epic's PR is now of record. If OTHER epic/* branches also
      // have open PRs, several epics are in flight at once — a future merge of
      // any one can silently break the others. Point the operator at the
      // cross-epic union gate so they can check the open epics still land
      // together. Advisory only; a probe failure never affects the result.
      this.maybeHintCrossEpicGate(epicBranch);
    }

    audit.record({
      agent_id: undefined,
      action: 'epic_finalize',
      command: epicId,
      allowed: true,
      detail: { status: conflicted.length ? 'partial' : 'merged', merged, conflicted, prUrl },
    });
    // Best-effort retro after epic_finalize is durable (ADR-001).
    try { await this.opts.autoRetro?.run(epicId, 'done'); }
    catch (err) { audit.record({ action: 'auto_retro_skipped', command: epicId, allowed: true, detail: { reason: String(err) } }); }

    if (!prUrl) {
      // PR opened but no URL captured — leave a terminal-but-not-done state.
      const note = `${epicBranch} pushed; epic PR opened but its URL could not be captured.`;
      epicStore.updateStatus(epicId, 'finalizing', note);
      return {
        status: conflicted.length ? 'partial' : 'merged',
        conflicted,
        merged,
        cleaned,
        note,
      };
    }

    return {
      url: prUrl,
      status: conflicted.length ? 'partial' : 'merged',
      conflicted,
      merged,
      cleaned,
      note: `Opened epic PR: ${prUrl}`,
    };
  }

  /**
   * Reusable resume entry point. Derives the current finalize phase from
   * persisted state + live remote queries, then completes ONLY the remaining
   * phases — never re-merging or repeating completed work (FR-3/FR-4).
   *
   * Acquires the per-epic lease around the terminal phases so concurrent
   * recovery commands on the same epic never double-push or double-open a PR
   * (NFR-1). Writes `done` for the standalone recovery path (resume() owns the
   * done write; finalize() does not).
   */
  async resume(epicId: string): Promise<FinalizeResult> {
    const epicStore = new EpicStore(this.opts.db);
    const audit = new AuditLog(this.opts.db);

    const epic = epicStore.get(epicId);
    if (!epic) {
      return {
        status: 'failed',
        conflicted: [],
        merged: [],
        cleaned: [],
        note: `Epic ${epicId} not found`,
      };
    }

    const remoteResolver = this.opts.resolveRemote ?? (() => defaultRemote(this.opts.projectRoot));
    const remote = remoteResolver() ?? null;

    // NFR-1: acquire per-epic lease to serialise concurrent resume() calls.
    const lease = this.opts.leaseStore ?? new LeaseStore(this.opts.db);
    const acquired = lease.acquire(epicId);
    if (!acquired) {
      return {
        status: 'skipped',
        conflicted: [],
        merged: [],
        cleaned: [],
        note: `resume: epic ${epicId} lease held by another process — skipping to avoid double-push or double-PR`,
      };
    }

    try {
      const plan = this.detectResumePhase(epic, remote);

      // NFR-3: audit BEFORE publishPhase so the entry is written even if publishPhase throws.
      audit.record({
        agent_id: undefined,
        action: 'epic_finalize_resume',
        command: epicId,
        allowed: true,
        detail: { plan: plan.action },
      });

      // Build ctx after plan is known so finalizeRef is taken from the plan arm
      // that carries it rather than the nullable epic column (avoids silent '' for full-finalize).
      const finalizeRef = 'finalizeRef' in plan ? plan.finalizeRef : (epic.finalize_ref ?? '');
      return await this.publishPhase(
        epicId,
        epic,
        { finalizeRef, remote },
        plan,
        audit,
        epicStore
      );
    } finally {
      lease.release(epicId);
    }
  }

  /**
   * Determines which terminal phases still need to run. Reads only the
   * persisted `epics` row and injectable git/gh probes — never session state
   * (FR-4), so results are identical across separate process invocations.
   */
  private detectResumePhase(epic: EpicRecord, remote: string | null): ResumePlan {
    // noop-terminal: no remote or remote not in policy.git.allowed_remotes
    if (!remote) {
      return { action: 'noop-terminal', note: 'no remote configured' };
    }
    const url = remoteUrl(this.opts.projectRoot, remote);
    if (url && !this.remoteAllowed(url)) {
      return { action: 'noop-terminal', note: `remote "${url}" is not in policy.git.allowed_remotes` };
    }

    if (epic.finalize_ref) {
      // FR-10: probe remote for a live PR — remote is the source of truth
      const prResult = this.prForRefProbe(epic.finalize_ref);
      if (prResult.exists && prResult.url) {
        // Remote confirms a live PR for this ref
        if (epic.epic_pr_url) {
          // DB and remote agree: the epic is already published
          return { action: 'already-done', prUrl: prResult.url };
        }
        // Remote has PR but DB didn't record it (e.g. transaction interrupted)
        return { action: 'record-pr', prUrl: prResult.url };
      }

      // No live PR. Check whether the finalizer-owned ref is on the remote.
      const pushed = this.remoteRefExistsProbe(remote, epic.finalize_ref);
      if (pushed) {
        // Ref is on remote but no PR: open the PR
        return { action: 'open-pr', finalizeRef: epic.finalize_ref };
      }

      // Ref not on remote. FR-11: check if local epic branch is at the stored sha.
      // Only if head matches can we trust the prior gate result and re-push.
      const headMatches = this.integrationHeadMatchesRefProbe(epic.id, epic.finalize_ref);
      if (headMatches) {
        // Local branch is at the right sha — safe to re-push and open
        return { action: 'push-and-open', finalizeRef: epic.finalize_ref };
      }

      // sha mismatch: treat gate as not-yet-satisfied (FR-11 — full re-finalize)
      return { action: 'full-finalize' };
    }

    // No finalize_ref in DB: full finalize needed
    return { action: 'full-finalize' };
  }

  /**
   * Executes the remaining terminal phases dictated by the ResumePlan. For
   * plans that open or record a PR, writes `done` atomically via the canonical
   * order: recordPrUrl → clearFinalizePhase → audit(epic_published) →
   * updateStatus('done'). resume() owns this done write; finalize() does not.
   */
  private async publishPhase(
    epicId: string,
    epic: EpicRecord,
    ctx: PublishCtx,
    plan: ResumePlan,
    audit: AuditLog,
    epicStore: EpicStore
  ): Promise<FinalizeResult> {
    switch (plan.action) {
      case 'already-done':
        return {
          status: 'merged',
          url: plan.prUrl,
          conflicted: [],
          merged: [],
          cleaned: [],
          note: `Epic ${epicId} is already done (PR: ${plan.prUrl})`,
        };

      case 'noop-terminal':
        return {
          status: 'skipped',
          conflicted: [],
          merged: [],
          cleaned: [],
          note: plan.note,
        };

      case 'full-finalize':
        // Re-run the full finalize flow (merge + gate + push + PR)
        return this.finalize(epicId);

      case 'record-pr': {
        // PR already exists on remote (FR-10 — remote wins); record and flip done
        const prUrl = plan.prUrl;
        this.opts.db.transaction(() => {
          epicStore.recordPrUrl(epicId, prUrl);
          epicStore.clearFinalizePhase(epicId);
          audit.record({
            action: 'epic_published',
            command: epicId,
            allowed: true,
            detail: { finalize_ref: ctx.finalizeRef, pr_url: prUrl, via: 'record-pr' },
          });
          epicStore.updateStatus(epicId, 'done');
        })();
        return {
          status: 'merged',
          url: prUrl,
          conflicted: [],
          merged: [],
          cleaned: [],
          note: `Epic ${epicId} published — recorded existing PR: ${prUrl}`,
        };
      }

      case 'open-pr': {
        // Ref is on remote but no PR: open it
        const prUrl = await this.openPrForResume(epic, plan.finalizeRef);
        if (!prUrl) {
          return {
            status: 'publish_pending',
            conflicted: [],
            merged: [],
            cleaned: [],
            note: `Epic ${epicId}: PR open failed for ${plan.finalizeRef}`,
          };
        }
        this.opts.db.transaction(() => {
          epicStore.recordPrUrl(epicId, prUrl);
          epicStore.clearFinalizePhase(epicId);
          audit.record({
            action: 'epic_published',
            command: epicId,
            allowed: true,
            detail: { finalize_ref: plan.finalizeRef, pr_url: prUrl, via: 'open-pr' },
          });
          epicStore.updateStatus(epicId, 'done');
        })();
        return {
          status: 'merged',
          url: prUrl,
          conflicted: [],
          merged: [],
          cleaned: [],
          note: `Epic ${epicId} published — opened PR: ${prUrl}`,
        };
      }

      case 'push-and-open': {
        // Local branch at correct sha; push to remote then open the PR.
        // ctx.remote is always non-null here: detectResumePhase returns noop-terminal
        // when remote is null, making this arm unreachable without a valid remote.
        const remote = ctx.remote as string;
        const epicBranch = `epic/${epicId}`;
        const push = this.opts.pushBranch
          ? this.opts.pushBranch(remote, plan.finalizeRef)
          : gitSafe(this.opts.projectRoot, ['push', remote, `${epicBranch}:${plan.finalizeRef}`]);
        if (!push.ok) {
          return {
            status: 'publish_pending',
            conflicted: [],
            merged: [],
            cleaned: [],
            note: `Epic ${epicId}: push failed for ${plan.finalizeRef}: ${push.output}`,
          };
        }
        const prUrl = await this.openPrForResume(epic, plan.finalizeRef);
        if (!prUrl) {
          return {
            status: 'publish_pending',
            conflicted: [],
            merged: [],
            cleaned: [],
            note: `Epic ${epicId}: PR open failed for ${plan.finalizeRef} after push`,
          };
        }
        this.opts.db.transaction(() => {
          epicStore.recordPrUrl(epicId, prUrl);
          epicStore.clearFinalizePhase(epicId);
          audit.record({
            action: 'epic_published',
            command: epicId,
            allowed: true,
            detail: { finalize_ref: plan.finalizeRef, pr_url: prUrl, via: 'push-and-open' },
          });
          epicStore.updateStatus(epicId, 'done');
        })();
        return {
          status: 'merged',
          url: prUrl,
          conflicted: [],
          merged: [],
          cleaned: [],
          note: `Epic ${epicId} published — pushed and opened PR: ${prUrl}`,
        };
      }
    }
  }

  /**
   * Opens a PR for the resume path using the injected seam or `gh pr create --fill`.
   * Returns the PR URL or undefined on failure.
   */
  private async openPrForResume(
    epic: EpicRecord,
    finalizeRef: string
  ): Promise<string | undefined> {
    const title = `${epic.id}: ${epic.title ?? epic.id}`;
    try {
      if (this.opts.openPr) {
        return this.opts.openPr({ branch: finalizeRef, title, body: '' }) ?? undefined;
      }
      const execOpts = { cwd: this.opts.projectRoot, encoding: 'utf8' as const, timeout: 30_000 };
      // Probe for an existing PR first (idempotent retry)
      try {
        const probeOut = execFileSync(
          'gh',
          ['pr', 'view', '--head', finalizeRef, '--json', 'url', '-q', '.url'],
          execOpts
        ).trim();
        if (probeOut.startsWith('http')) return probeOut;
      } catch {
        // No existing PR — create below
      }
      const out = execFileSync(
        'gh',
        ['pr', 'create', '--head', finalizeRef, '--fill'],
        execOpts
      );
      return out.trim().split('\n').find((l) => l.startsWith('http'));
    } catch {
      return undefined;
    }
  }

  /** Remote probe: does a live PR exist for this finalizer-owned ref? (FR-10) */
  private prForRefProbe(finalizeRef: string): { exists: boolean; url?: string } {
    if (this.opts.prForRef) return this.opts.prForRef(finalizeRef);
    try {
      const out = execFileSync(
        'gh',
        ['pr', 'view', '--head', finalizeRef, '--json', 'url', '-q', '.url'],
        { cwd: this.opts.projectRoot, encoding: 'utf8', timeout: 30_000 }
      ).trim();
      if (out.startsWith('http')) return { exists: true, url: out };
      return { exists: false };
    } catch {
      return { exists: false };
    }
  }

  /** Remote probe: does the finalizer-owned ref exist on the remote? (FR-12) */
  private remoteRefExistsProbe(remote: string, finalizeRef: string): boolean {
    if (this.opts.remoteRefExists) return this.opts.remoteRefExists(remote, finalizeRef);
    const result = gitSafe(this.opts.projectRoot, ['ls-remote', remote, `refs/${finalizeRef}`]);
    return result.ok && result.output.trim().length > 0;
  }

  /**
   * Remote probe: does the local `epic/<epicId>` HEAD match the sha7 suffix
   * embedded in `ref`? (FR-11 — only trust a prior gate if the sha still matches)
   */
  private integrationHeadMatchesRefProbe(epicId: string, ref: string): boolean {
    if (this.opts.integrationHeadMatchesRef) return this.opts.integrationHeadMatchesRef(epicId, ref);
    const sha7 = ref.slice(-7);
    const epicBranch = `epic/${epicId}`;
    const result = gitSafe(this.opts.projectRoot, ['rev-parse', '--verify', epicBranch]);
    if (!result.ok) return false;
    return result.output.trim().startsWith(sha7);
  }

  /**
   * Commits the epic's planning artifacts to loom-home (ADR-5). Composes the
   * home/ chain: resolveLoomHomePath → ensureLoomHome → routeArtifacts →
   * commitArtifacts. A failure marks loom_home_status='pending' but never
   * throws into the finalize critical path — the merge + PR are unaffected.
   *
   * The old .loom_outputs/<epic-id> write and target-branch git add/commit are
   * intentionally absent: no loom operational artifacts land on the epic branch.
   */
  private promoteArtifacts(
    epicId: string,
    epic: { brief_path: string | null; prd_path: string | null; yaml_path: string | null },
    epicStore: EpicStore
  ): void {
    try {
      const projectRoot = this.opts.projectRoot;
      const home = resolveLoomHomePath(projectRoot, { loom_home: this.opts.loomHome });
      ensureLoomHome(home);

      // runId == the planning-directory name embedded in brief_path, which
      // equals the first epicId the planner produced for this run.
      const runId = epic.brief_path
        ? path.basename(path.dirname(epic.brief_path))
        : epicId;

      // Derive architecture.md from the same directory as brief_path —
      // planningRelPaths stores a consistent layout (brief and architecture
      // are siblings), so this works for both in-repo and loom-home roots.
      const briefAbsPath = epic.brief_path ? path.join(projectRoot, epic.brief_path) : null;
      const archBase = briefAbsPath ? path.dirname(briefAbsPath) : null;
      // Derive all four artifact paths from archBase (the run directory of brief_path)
      // rather than joining projectRoot with the stored relative paths. After
      // migratePlanningScratch moves files to loom-home, archBase reflects wherever
      // brief_path now lives, keeping prd/epicYaml co-located with brief/architecture.
      const artifactSources = {
        brief: briefAbsPath ?? undefined,
        prd: archBase ? path.join(archBase, 'prd.md') : undefined,
        architecture: archBase ? path.join(archBase, 'architecture.md') : undefined,
        epicYaml: archBase && epic.yaml_path
          ? path.join(archBase, 'epics', path.basename(epic.yaml_path))
          : undefined,
      };

      const { relDir, provenance } = routeArtifacts({
        loomHomePath: home,
        projectRoot,
        epicId,
        runId,
        artifactSources,
      });

      const result = commitArtifacts({
        loomHomePath: home,
        relDir,
        epicId,
        provenance,
        store: epicStore,
      });

      if (result.status === 'pending') {
        console.warn(
          `loom-home artifact commit deferred for ${epicId} ` +
            `(loom_home_status=pending): ${result.reason}`
        );
      }
    } catch {
      // Best-effort — the merge + PR are the critical path and they already
      // completed (or will complete). A failure here only affects loom-home.
    }
  }

  /**
   * Returns the finalizer-owned remote ref for this integrated state.
   * The ref is deterministic (same epicId + same integratedHead SHA → same name)
   * so a retry is a fast-forward no-op. Each distinct integrated tree gets a
   * unique name — collision-resistant across epics and across content changes
   * (2^28 ≈ 268 M distinct values per epicId, matching git's own short-SHA display).
   * Format: `loom/finalize/<epicId>-<first7charsOfHead>`
   */
  private finalizeRef(epicId: string, integratedHead: string): string {
    return `loom/finalize/${epicId}-${integratedHead.slice(0, 7)}`;
  }

  private remoteAllowed(url: string): boolean {
    if (this.effectiveAllowedRemotes.length === 0) return false;
    return this.effectiveAllowedRemotes.some((pattern) => minimatch(url, pattern));
  }

  private loadStories(yamlPath: string | null): Story[] {
    if (!yamlPath) {
      throw new Error('epic has no yaml_path');
    }
    const file = path.join(this.opts.projectRoot, yamlPath);
    if (!fs.existsSync(file)) {
      throw new Error(`YAML not found at ${file}`);
    }
    return EpicYamlSchema.parse(yaml.load(fs.readFileSync(file, 'utf8'))).stories;
  }

  /**
   * Builds the PR body: uses the PrDescriptionAgent when an LLM client is
   * available, otherwise falls back to a hand-rolled body. Any agent failure
   * also falls back — never blocks the PR from opening.
   */
  private async composeBody(
    epicTitle: string,
    epicBranch: string,
    baseSha: string,
    merged: string[],
    conflicted: string[],
    stories: Story[]
  ): Promise<string> {
    const fallback = this.epicPrBody(epicTitle, merged, conflicted, stories);
    if (!this.opts.llmClient || !this.opts.llmModel) return fallback;

    const byId = new Map(stories.map((s) => [s.id, s]));
    const storyContexts = merged
      .map((id) => byId.get(id))
      .filter((s): s is Story => !!s)
      .map((s) => ({
        storyId: s.id,
        title: s.title,
        description: s.description,
        acceptanceCriteria: s.acceptance_criteria,
      }));

    if (storyContexts.length === 0) return fallback;

    const diffStat = gitSafe(this.opts.projectRoot, [
      '--no-pager',
      'diff',
      '--stat',
      `${baseSha}..${epicBranch}`,
    ]);
    const commitLog = gitSafe(this.opts.projectRoot, [
      '--no-pager',
      'log',
      '--oneline',
      `${baseSha}..${epicBranch}`,
    ]);

    try {
      const result = await new PrDescriptionAgent({
        projectRoot: this.opts.projectRoot,
        llm: this.opts.llmClient,
        model: this.opts.llmModel,
      }).generate({
        title: epicTitle,
        stories: storyContexts,
        diffStat: diffStat.ok ? diffStat.output : '',
        commitLog: commitLog.ok ? commitLog.output : '',
      });
      // Append the conflict note if any — the LLM does not know which
      // stories were dropped.
      if (conflicted.length > 0) {
        return (
          result.description +
          '\n\n---\n\n## Stories dropped from this PR due to merge conflicts\n\n' +
          conflicted.map((id) => `- **${id}** — story branch retains the work`).join('\n')
        );
      }
      return result.description;
    } catch {
      return fallback;
    }
  }

  private epicPrBody(
    epicTitle: string,
    merged: string[],
    conflicted: string[],
    stories: Story[]
  ): string {
    const byId = new Map(stories.map((s) => [s.id, s]));
    const lines = [
      `# ${epicTitle}`,
      '',
      'Built by loom — one PR per epic.',
      '',
      `## Stories merged into this PR (${merged.length})`,
      '',
    ];
    for (const id of merged) {
      const s = byId.get(id);
      lines.push(`- **${id}** — ${s?.title ?? '(unknown)'}`);
    }
    if (conflicted.length > 0) {
      lines.push('');
      lines.push(`## Stories that conflicted and need a separate review (${conflicted.length})`);
      lines.push('');
      for (const id of conflicted) {
        const s = byId.get(id);
        lines.push(`- **${id}** — ${s?.title ?? '(unknown)'} (story branch still has the work)`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('Story commits are preserved on the epic branch. Review by epic.');
    return lines.join('\n');
  }
}

/** Renders the integration-gate result as a PR-body section. */
function renderGateSection(o: GateOutcome): string {
  const lines: string[] = [`## Integration gate: ${o.ok ? 'PASSED' : 'FAILED'}`, '', o.summary];
  if (!o.ok && o.output.trim()) {
    lines.push(
      '',
      '<details><summary>Gate output (tail)</summary>',
      '',
      '```',
      o.output.trim().slice(-3000),
      '```',
      '</details>'
    );
  }
  return lines.join('\n');
}

/** Topological sort over the planner's declared dependencies. Cycles → input order. */
function topoSort(stories: Story[]): Story[] {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: Story[] = [];

  const visit = (story: Story): void => {
    if (visited.has(story.id)) return;
    if (visiting.has(story.id)) return; // cycle — bail
    visiting.add(story.id);
    for (const dep of story.dependencies) {
      const depStory = byId.get(dep);
      if (depStory) visit(depStory);
    }
    visiting.delete(story.id);
    visited.add(story.id);
    ordered.push(story);
  };

  for (const s of stories) visit(s);
  return ordered;
}

/**
 * Provenance header for an epic PR — prepended when policy.agents.pr_attribution
 * is 'on'. Tells the reviewer loom generated the PR.
 * Planning artifacts (brief, PRD, architecture, epic YAML) are committed to the
 * loom-home repository, not to this branch.
 */
function loomAttributionBlock(
  epicId: string,
  _epic: { brief_path: string | null; prd_path: string | null; yaml_path: string | null },
): string {
  const lines: string[] = [];
  lines.push(`## :robot: Built by [loom](https://github.com/jeromeportega/loom)`);
  lines.push('');
  lines.push(
    `This PR was generated end-to-end by loom (epic \`${epicId}\`). ` +
      'The brief, PRD, architecture, and epic YAML are stored in the ' +
      'loom-home repository for this project.',
  );
  lines.push('');
  lines.push(
    'Review the story descriptions in the epic YAML for the *intent*, then review the ' +
      'code below for the *implementation*. Things to look for: scope ' +
      'creep beyond the brief, missing test coverage on the acceptance ' +
      'criteria, deviations from the architecture.',
  );
  return lines.join('\n');
}

/**
 * Default open-PR probe for the FR-11 cross-epic-gate hint. Lists open PRs via
 * `gh` and returns the head branches that look like epic branches (`epic/*`).
 * The caller filters out the current epic's branch. Returns [] on any error
 * (no `gh`, no remote, malformed JSON) — the hint is advisory.
 */
function defaultOpenEpicPrsProbe(projectRoot: string): (epicBranch: string) => string[] {
  return () => {
    try {
      const out = execFileSync(
        'gh',
        ['pr', 'list', '--state', 'open', '--json', 'headRefName', '--limit', '100'],
        { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const prs = JSON.parse(out) as Array<{ headRefName?: string }>;
      return prs
        .map((p) => p.headRefName)
        .filter((b): b is string => typeof b === 'string' && b.startsWith('epic/'));
    } catch {
      return [];
    }
  };
}

/** Order-insensitive equality for string arrays (allowed_remotes globs). */
function sameStringArr(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}
