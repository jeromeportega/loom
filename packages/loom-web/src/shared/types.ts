/**
 * API contract shared between the loom-web Express server and the React
 * frontend. Keeping this single-file means a server change that breaks the
 * contract surfaces as a TypeScript error in the frontend at build time.
 *
 * V1 endpoint set is documented in docs/architecture/web-ui.md.
 */

import type { PlanningPhase, IntakeVerdict } from '@loom-ai/core';

export interface EpicStatus {
  id: string;
  title: string;
  status:
    | 'planning'
    | 'planned'
    | 'approved'
    | 'in_progress'
    | 'finalizing'
    | 'publish_pending'
    | 'failed'
    | 'done'
    | 'rejected';
  /**
   * When status='planning', which persona is currently running. Cleared
   * (null) once the planner completes.
   */
  planning_phase: 'analyst' | 'pm' | 'architect' | null;
  /** Counts derived from the agents table; useful for the at-a-glance tree. */
  stories: {
    total: number;
    done: number;
    failed: number;
    blocked: number;
    pending: number;
    running: number;
  };
  /** Wall-clock when planning finished (epics.updated_at proxy). */
  updated_at: string;
  /**
   * The loom-init'ed repo this epic lives in. Present on every row from
   * the federated /api/status response so operators see at a glance which
   * project an epic belongs to, and the detail view can route the
   * follow-up fetch to the right DB via the `project` query param.
   */
  project_name: string;
  project_root: string;
  /** True when this epic is in the project the web server was launched in. */
  is_current_project: boolean;
  /**
   * True when the run is archived — hidden from the default list. The server
   * only emits archived rows when the client asks for them (the "show
   * archived" toggle, `?include_archived=true`); the frontend dims them.
   */
  archived: boolean;
  /** Set only when status='in_progress' and finalize_phase='gate' — the
   *  integration gate blocked this epic. Absent for all other states. */
  blocked?: true;
  blocked_reason?: 'integration_gate';
  /** Observe-only intake verdict from `loom weave` classification. Null for
   *  epics planned via `loom epic` or when classification failed. Never used
   *  to branch planning or execution — surfaced for information only. */
  intake_verdict?: IntakeVerdict | null;
}

export interface AgentSummary {
  id: string;
  story_id: string;
  story_title: string | null;
  status:
    | 'pending'
    | 'running'
    | 'pr_open'
    | 'done'
    | 'failed'
    | 'blocked'
    | 'integrating';
  pr_url: string | null;
  started_at: string | null;
  updated_at: string;
  review_status:
    | 'pending'
    | 'passed'
    | 'commented'
    | 'blocked'
    | 'skipped'
    | 'errored'
    | null;
  review_summary: string | null;
  tokens_total: number | null;
  cost_usd: number | null;
  /** Per-attempt LLM-request total — the spend signal for per-request-billed
      backends (cursor-cli reports no USD cost, so this is the number that
      matters there). Null when the backend never reported usage. */
  request_count: number | null;
  /** Story's git worktree path, when dispatched. Surfaced so an operator can
      cd into a failed story's tree to inspect it. */
  worktree_path: string | null;
  branch_name: string | null;
  /** Set on a running story whose worker is approaching/hitting a deadline.
      Reason is 'stall' | 'cap' | 'budget' | 'analysis-only'. Null otherwise. */
  stall_reason: string | null;
  /** The model id the worker executed under. Null for pre-migration rows. */
  model: string | null;
}

export interface EpicDetail extends EpicStatus {
  brief_path: string | null;
  prd_path: string | null;
  yaml_path: string | null;
  base_sha: string | null;
  planner_tokens_total: number | null;
  planner_ms: number | null;
  /** The user's original brief verbatim — what kicked off the job. */
  user_brief: string | null;
  agents: AgentSummary[];
}

/**
 * Planning artifacts surfaced to the approval UI. Same shape as the MCP
 * loom_get_planning_artifacts tool: bodies read from disk on demand, null
 * when the underlying file is missing. The operator reviews these before
 * clicking Approve so the planning output is auditable without leaving the
 * dashboard.
 */
export interface PlanningArtifacts {
  epic_id: string;
  paths: {
    brief: string | null;
    prd: string | null;
    epic_yaml: string | null;
    architecture: string | null;
  };
  brief: string | null;
  prd: string | null;
  architecture: string | null;
  epic_yaml: string | null;
}

export interface AgentDetail extends AgentSummary {
  epic_id: string;
  worktree_path: string | null;
  branch_name: string | null;
  log_tail: string | null;
  worker_pid: number | null;
}

export interface AuditEntry {
  id: number;
  agent_id: string | null;
  action: string;
  command: string | null;
  allowed: 0 | 1 | null;
  policy_rule: string | null;
  detail: string | null;
  timestamp: string;
}

export interface SkillManifestSummary {
  name: string;
  description: string;
  source: 'bundled' | 'project' | 'global' | 'generated' | 'shared';
  lifecycle: 'active' | 'candidate' | 'disabled';
  /** For source === 'shared', the sources.yaml entry name this skill came from. */
  shareSourceName?: string;
  /** Track record across the local DB. */
  injected: number;
  succeeded: number;
  failed: number;
}

export interface SkillHistoryEntry {
  ts: string;
  kind: 'generated' | 'injected' | 'lifecycle';
  text: string;
}

export interface EpicCost {
  epic_id: string;
  title: string;
  planner_tokens: number;
  planner_requests: number;
  worker_tokens: number;
  worker_cost_usd: number;
  worker_requests: number;
  agents: number;
  prs: number;
  retries: number;
  budget_exhausted: number;
}

export interface CostReport {
  epics: EpicCost[];
  totals: {
    planner_tokens: number;
    planner_requests: number;
    worker_tokens: number;
    worker_cost_usd: number;
    worker_requests: number;
    prs: number;
  };
}

/**
 * SSE event envelope. `kind` matches the SSE event name; `data` is the
 * payload. The /api/events endpoint emits diffs against the previous poll,
 * not the full state — clients merge into their cached store.
 *
 * Event kinds:
 *   - epic   — an epic's status/title/planning_phase changed
 *   - agent  — an agent's status / pr_url changed
 *   - output — new bytes appended to an agent's log_tail (live worker stdout)
 *   - hello  — emitted once on connect with the server's current epoch
 */
export type LiveEvent =
  | { kind: 'hello'; data: { epoch: string } }
  | { kind: 'epic'; data: EpicStatus }
  | { kind: 'agent'; data: AgentSummary & { epic_id: string } }
  | { kind: 'output'; data: { agent_id: string; story_id: string; chunk: string } }
  | { kind: 'planning-output'; data: { epic_id: string; phase: PlanningPhase | null; chunk: string } };

export type { PlanningPhase };

export type WorkerEventPayload =
  | { type: 'dispatched'; storyId: string; agentId: string; branchName: string }
  | { type: 'output'; storyId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | {
      type: 'completed';
      storyId: string;
      status: AgentSummary['status'];
      summary: string;
      commitCount: number;
      prUrl?: string;
    };

export type SkillEventPayload =
  | {
      type: 'injected';
      skillName: string;
      storyId: string;
      agentId: string;
      source: SkillManifestSummary['source'];
      lifecycle: SkillManifestSummary['lifecycle'];
    }
  | { type: 'generated'; skillName: string; storyId: string }
  | {
      type: 'promoted' | 'demoted';
      skillName: string;
      from: SkillManifestSummary['lifecycle'];
      to: SkillManifestSummary['lifecycle'];
      reason: string;
    };
