import { execFileSync } from 'node:child_process';
import { minimatch } from 'minimatch';
import type Database from 'better-sqlite3';
import { EpicStore, AgentStore, AuditLog } from '../state/index.js';
import type { Story } from '../types.js';
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
  /** Human-readable status — 'skipped' / 'merged' / 'partial' / 'failed' / 'gated'. */
  status: 'skipped' | 'merged' | 'partial' | 'failed' | 'gated';
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

    // Promote the planning artifacts (brief / PRD / architecture / epic YAML)
    // into a namespaced .loom_outputs/<epic-id>/ directory and commit them on
    // the epic branch BEFORE the integration gate runs. The namespacing keeps
    // loom artifacts out of the team's docs tree; the commit makes them part of
    // the epic PR. Promoting first means the gate validates the exact tree the
    // PR will carry — the gated tree is byte-identical to the PR tree (ADR-6) —
    // and promotion happens at exactly one site (no double commit on the
    // block-mode path).
    this.promoteArtifacts(epicId, epic, gitRoot);

    // ── Integration gate ──────────────────────────────────────────────────
    // The main working tree is now checked out to the integrated epic/<id> with
    // the promoted artifacts already committed. Run the build/test suite on the
    // WHOLE epic (cross-story regressions only surface here) and treat any
    // dropped/conflicted story as a failure. In 'block' mode a red gate
    // withholds the PR; in 'warn' it only annotates.
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

    // Gate passed (or wasn't blocking). The epic is now review-ready: prune
    // story worktrees, and — unless push-gated — push + open the PR (artifacts
    // were already promoted before the gate, ADR-6). push-gate=confirm
    // intentionally stops here, so 'review' is the terminal phase for that
    // PR-less success.
    epicStore.updateFinalizePhase(epicId, 'review');


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

    const push = this.opts.pushBranch
      ? this.opts.pushBranch(remote, epicBranch)
      : gitSafe(this.opts.projectRoot, ['push', '-u', remote, epicBranch]);
    if (!push.ok) {
      return {
        status: 'failed',
        conflicted,
        merged,
        cleaned,
        note: `${epicBranch} merged but push failed: ${push.output}`,
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

    epicStore.updateFinalizePhase(epicId, 'opening_pr');
    const title = `${epicId}: ${epic.title}`;
    let prUrl: string | undefined;
    try {
      prUrl = this.opts.openPr
        ? this.opts.openPr({ branch: epicBranch, title, body })
        : (() => {
            const out = execFileSync(
              'gh',
              ['pr', 'create', '--head', epicBranch, '--title', title, '--body', body],
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
      // Pushed but the PR didn't open — a PR-less terminal state at
      // 'opening_pr'. Not 'done' (no epic_pr_url), and surfaced via the note.
      const note = `${epicBranch} pushed; open the PR manually.`;
      epicStore.updateStatus(epicId, 'finalizing', note);
      return {
        status: conflicted.length ? 'partial' : 'merged',
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
   * Copies the epic's planning artifacts (project-brief.md, prd.md,
   * architecture.md, the epic's own YAML) from the working directory
   * (.loom/planning/<run-id>/) into the tracked namespace
   * (.loom_outputs/<epic-id>/), then stages and commits them on the epic
   * branch. The namespacing keeps loom artifacts out of the team's docs
   * tree; the commit lands them in the epic PR. Failures are best-effort —
   * the finalize result is unaffected if the promotion can't run.
   */
  private promoteArtifacts(
    epicId: string,
    epic: { brief_path: string | null; prd_path: string | null; yaml_path: string | null },
    gitRoot: string = this.opts.projectRoot
  ): void {
    // Sources are read from the main checkout (.loom/planning lives there, and
    // it is gitignored so it never appears in the integration worktree). The
    // destination + git add/commit run in `gitRoot`, whose checkout is on
    // epic/<id> — so the artifacts land on the epic branch in both topologies.
    const destDir = path.join(gitRoot, '.loom_outputs', epicId);
    let copied = 0;
    try {
      fs.mkdirSync(destDir, { recursive: true });

      const planningDir = epic.brief_path
        ? path.dirname(path.join(this.opts.projectRoot, epic.brief_path))
        : null;

      const candidates: Array<[string | null, string]> = [
        [epic.brief_path, 'project-brief.md'],
        [epic.prd_path, 'prd.md'],
        // Architecture isn't tracked on the epic row but always lives next
        // to the brief in the planning run directory.
        [
          planningDir ? path.relative(this.opts.projectRoot, path.join(planningDir, 'architecture.md')) : null,
          'architecture.md',
        ],
        [epic.yaml_path, 'epic.yaml'],
      ];

      for (const [relPath, destName] of candidates) {
        if (!relPath) continue;
        const abs = path.join(this.opts.projectRoot, relPath);
        if (!fs.existsSync(abs)) continue;
        fs.copyFileSync(abs, path.join(destDir, destName));
        copied++;
      }

      if (copied === 0) return;

      const stage = gitSafe(gitRoot, ['add', path.join('.loom_outputs', epicId)]);
      if (!stage.ok) return;

      gitSafe(gitRoot, ['commit', '-m', `loom: planning artifacts for ${epicId}`]);
    } catch {
      // Best-effort — the artifacts are nice-to-have; the merge + PR are the
      // critical path and they already completed.
    }
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
 * is 'on'. Tells the reviewer loom generated the PR and points at the
 * committed planning artifacts so the brief + PRD + architecture are
 * inspectable from the PR itself. The artifacts already land on the epic
 * branch via promoteArtifacts(), so the links resolve once the PR is open.
 */
function loomAttributionBlock(
  epicId: string,
  epic: { brief_path: string | null; prd_path: string | null; yaml_path: string | null },
): string {
  const lines: string[] = [];
  lines.push(`## :robot: Built by [loom](https://github.com/jeromeportega/loom)`);
  lines.push('');
  lines.push(
    `This PR was generated end-to-end by loom (epic \`${epicId}\`). ` +
      'The brief, PRD, architecture, and epic YAML are committed on this ' +
      'branch and resolve to the following paths in the diff:',
  );
  lines.push('');
  const refs: string[] = [];
  refs.push(`- Brief: \`.loom_outputs/${epicId}/project-brief.md\``);
  refs.push(`- PRD: \`.loom_outputs/${epicId}/prd.md\``);
  refs.push(`- Architecture: \`.loom_outputs/${epicId}/architecture.md\``);
  refs.push(`- Epic YAML: \`.loom_outputs/${epicId}/epic.yaml\``);
  lines.push(refs.join('\n'));
  lines.push('');
  lines.push(
    'Review the planning artifacts above for the *intent*, then review the ' +
      'code below for the *implementation*. Things to look for: scope ' +
      'creep beyond the brief, missing test coverage on the acceptance ' +
      'criteria, deviations from the architecture.',
  );
  // Suppress the unused-param TS error in the fallback path when epic
  // doesn't carry any of the paths (the artifact promotion is best-effort
  // so we don't depend on the record being populated).
  void epic;
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
