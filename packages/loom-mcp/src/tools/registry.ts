/** MCP tool definitions — name, description, and JSON-schema for inputs. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'loom_policy_check',
    description:
      'Validate a shell command against loom\'s guardrail policy BEFORE running it. ' +
      'Returns { allowed: boolean, rule?: string, reason?: string }. Call this whenever ' +
      'you are about to invoke Bash on the user\'s behalf — especially git operations, ' +
      'deletes, or anything touching protected paths. Cheap, synchronous, side-effect-free.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact shell command you intend to run, as a single string',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'loom_get_status',
    description:
      'Inspect the live state of loom — every epic, every story agent, and the latest ' +
      'log_tail of any running worker. **Scopes to the CURRENT project by default**, so this ' +
      'answers "what is loom doing right now?" for the repo you are in. Pass all_projects:true to ' +
      'federate across every loom-init\'ed repo on the machine (the pre-v0.6 default). ' +
      'Each epic carries project_name + project_root attribution. Use this before approving/rejecting ' +
      'a plan, before stopping an agent, when the user asks "what\'s the status," or when polling ' +
      'progress after a dispatch. Returns ' +
      '{ epics: [{ id, title, status, project_name, project_root, is_current_project, stories: ' +
      '[{ id, title, status, pr_url?, started_at?, log_tail? }] }] }. Side-effect-free.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: {
          type: 'string',
          description:
            'Optional: scope the result to a single epic. Searches the current ' +
            'project only unless all_projects:true is also set.',
        },
        project: {
          type: 'string',
          description:
            'Optional: absolute project_root to scope the response to one project. ' +
            'Must match an entry in ~/.loom/projects.json. Overrides all_projects.',
        },
        all_projects: {
          type: 'boolean',
          description:
            'Federate across every registered loom project, not just the current ' +
            'one. Default false — the current project only. Set true to restore the ' +
            'pre-v0.6 machine-wide federation behavior. Ignored when `project` is set.',
        },
        include_archived: {
          type: 'boolean',
          description:
            'Include archived runs in the listing. Default false — archived ' +
            'epics are hidden so the view stays scoped to what the operator ' +
            'cares about. Archived epics carry archived:true in the response.',
        },
      },
    },
  },
  {
    name: 'loom_get_audit_log',
    description:
      'Read recent entries from the audit log — every command, status change, dispatch, ' +
      'completion, stop, and policy decision. Use this when the user asks "what did agent X do" ' +
      'or to investigate a failure. Scope to one agent with agent_id, to a story (across every ' +
      'retry attempt + rolling-integrator events) with story_id, or read the most recent global ' +
      'entries. Default limit is 50 for a scoped query, 20 globally.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Optional: limit to one agent\'s history',
        },
        story_id: {
          type: 'string',
          description:
            'Optional: limit to one story across every retry attempt (matches all ' +
            'agent_id values of the form agent-<story_id>-<hash>) AND rolling-integrator ' +
            'rows keyed on command=story_id. Takes precedence over agent_id when both are set.',
        },
        limit: {
          type: 'number',
          description: 'Max entries to return (default 50 for a scoped query, 20 globally)',
        },
      },
    },
  },
  {
    name: 'loom_start_epic',
    description:
      'Kick off the planning pipeline (Analyst → PM → Architect) for a new epic from a ' +
      'paragraph brief. Returns the reserved epic id WITHIN SECONDS while planning continues ' +
      'in-process in the background (the Analyst → PM → Architect chain takes minutes). ' +
      'Returns { status: \'planning\', run_id, epic_ids: [run_id], message }. The run is ' +
      'immediately re-attachable: POLL loom_get_status (or run `loom status`) on run_id to ' +
      'watch it advance through the planning phases; it lands in status \'planned\' awaiting ' +
      'human approval — then call loom_approve_plan to dispatch workers, or loom_reject_plan ' +
      'to discard. NOTE: the continuation is in-process and detached — if this process exits ' +
      'before planning finishes, the epic stays \'planning\' (the honest state, not silently ' +
      '\'planned\'); a crash inside the planner lands the epic as \'failed\' with a retrievable ' +
      'error message (distinct from a human \'rejected\'). Do NOT call this for a tiny ' +
      'one-line tweak — the planning overhead is real; use it for work that\'s genuinely ' +
      'epic-sized. ALWAYS runs the brief-quality gate first: an internal BriefRefiner scores ' +
      'the brief and refuses it when below policy.agents.min_brief_quality_score (default ' +
      '6/10), returning {status:"rejected", ready, critique, questions, refined_brief, ...}. ' +
      'When rejected, walk the user through the questions and re-call with a tightened brief. ' +
      'Pass force: true to bypass the gate for this invocation only — the refiner still runs, ' +
      'its critique is recorded, and a brief_gate_forced audit row is written before planning ' +
      'begins (the forced response carries forced: true). The threshold is tunable per repo.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description:
            'One paragraph describing what to build — be specific about the goal and the ' +
            'constraints, not the implementation',
        },
        force: {
          type: 'boolean',
          description:
            'Skip the brief-quality gate for this invocation only (default false). The ' +
            'refiner still runs and its critique is audit-logged before planning starts. ' +
            'Per-invocation; it sets no standing bypass.',
        },
      },
      required: ['brief'],
    },
  },
  {
    name: 'loom_approve_plan',
    description:
      'Approve a planned epic and dispatch story workers in the background. Returns immediately ' +
      'with status \'dispatching\'. The supervisor runs in-process and writes progress to the DB; ' +
      'POLL loom_get_status to track each story\'s state and read log_tail for live worker output. ' +
      'Only callable on epics with status \'planned\' — call loom_get_status first if unsure.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: {
          type: 'string',
          description: 'Epic id to approve (e.g. epic-001)',
        },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'loom_reject_plan',
    description:
      'Reject a planned epic so it will not be dispatched. The epic moves to status \'rejected\' ' +
      'and is preserved (with reason) for audit. Only callable on \'planned\' epics.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'string', description: 'Epic id to reject (e.g. epic-001)' },
        reason: {
          type: 'string',
          description: 'Optional reason — recorded for audit and shown to the user',
        },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'loom_stop_agent',
    description:
      'Cancel ONE running worker agent by story id. Sends SIGTERM directly to ' +
      'that worker subprocess; other agents in the run are unaffected. Use this ' +
      'when a specific agent is going off the rails — call loom_get_status ' +
      'first to find the story_id and look at its log_tail to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        story_id: {
          type: 'string',
          description: 'The story id whose worker should be stopped (e.g. story-001-002)',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the audit log',
        },
      },
      required: ['story_id'],
    },
  },
  {
    name: 'loom_stop_epic',
    description:
      'Cancel every running worker belonging to one epic in a single call. ' +
      'Iterates the epic\'s agents and SIGTERMs each running one by recorded ' +
      'worker_pid; non-running agents are reported as noop. The supervisor\'s ' +
      'other epics are unaffected. Returns { status, stopped: [...], noop: ' +
      '[...], errors: [...], message }. Use when the brief was wrong / the ' +
      'planner went off the rails and you need every story to stop, not just ' +
      'one. For a single misbehaving agent, prefer loom_stop_agent.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'string', description: 'Epic id (e.g. epic-001)' },
        reason: { type: 'string', description: 'Optional reason recorded on every stop_agent + the aggregate stop_epic audit row' },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'loom_guide_agent',
    description:
      'Append a guidance message a worker will read at story-start AND on every ' +
      "review revision. Operator side-channel for soft-lock recovery and " +
      'mid-run steering: when the worker is heading the wrong direction, add a ' +
      'guidance entry instead of SIGTERM\'ing. Entries are layered in a markdown ' +
      'file at .loom/guidance/<story-id>.md (timestamped, never truncated) — ' +
      'pass clear: true to reset the file when starting a fresh conversation. ' +
      'REQUIRES policy.agents.operator_guidance=on in the project; otherwise the ' +
      'worker prompt doesn\'t read the file.',
    inputSchema: {
      type: 'object',
      properties: {
        story_id: { type: 'string', description: 'Story id (e.g. story-001-003)' },
        message: { type: 'string', description: 'Free-form guidance text. Omit when clear=true.' },
        author: { type: 'string', description: 'Optional author tag (default: "operator")' },
        clear: { type: 'boolean', description: 'Remove the guidance file for this story' },
      },
      required: ['story_id'],
    },
  },
  {
    name: 'loom_pull_guidance',
    description:
      'Worker-side pull of operator guidance since the last call. The cursor-cli ' +
      'backend uses this between major tool calls to pick up steering — the ' +
      'claude-cli backend gets mid-spawn delivery directly via stdin and does ' +
      'not need to call this tool. Returns { content: <delta-string|null>, ' +
      'has_more: false }. Independent of loom_guide_agent; that one is the ' +
      'operator-side WRITE, this is the worker-side READ. Safe to call ' +
      'repeatedly; the per-worker offset marker at ' +
      '.loom/guidance/.pulled/<story-id>.offset advances only when content was ' +
      'returned. See docs/research/live-agent-guidance.md.',
    inputSchema: {
      type: 'object',
      properties: {
        story_id: {
          type: 'string',
          description: 'Story id this worker is implementing (e.g. story-001-003)',
        },
      },
      required: ['story_id'],
    },
  },
  {
    name: 'loom_revert_epic',
    description:
      'Tear down an epic: delete the epic + story branches locally, flip ' +
      "DB status to 'rejected'. Pass remote=true to also delete the upstream " +
      'epic branch (gated by policy.git.allowed_remotes) and close any loom-' +
      'opened PRs for the epic. Use when a plan turned out wrong / the bench ' +
      "showed regressions / the brief was misinterpreted and you want loom's " +
      'fingerprint off the system. Audit-logged with the operator-supplied reason.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'string', description: 'Epic id (e.g. epic-001)' },
        remote: {
          type: 'boolean',
          description: 'Also tear down the remote branch + PR. Defaults false (local-only).',
        },
        reason: {
          type: 'string',
          description: 'Optional explanation recorded with the revert in audit_log',
        },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'loom_archive_epic',
    description:
      'Archive a run so it stops cluttering loom_get_status, the web ' +
      'dashboard, and `loom status` — without deleting it. The epic row, its ' +
      'story agents, and its audit trail are all preserved; archived epics are ' +
      'also skipped by supervisor selection (`loom run` with no args). Use ' +
      'after a run is finished/abandoned and you want a clean working set. ' +
      'Pass archived:false to restore. Non-destructive, audit-logged, and ' +
      'callable on an epic in any status. To inspect an archived epic later, ' +
      'pass include_archived:true to loom_get_status.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'string', description: 'Epic id (e.g. epic-001)' },
        archived: {
          type: 'boolean',
          description: 'true (default) archives; false restores (unarchives).',
        },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'loom_retry_story',
    description:
      'Retry ONE failed or blocked story and re-dispatch its epic in the ' +
      'background. Two modes: a resume retry (default) keeps the prior ' +
      'attempt\'s branch + checkpoint commit and feeds the worker a handoff ' +
      'doc so it continues where it left off; a clean retry (clean=true) tears ' +
      'down the story\'s worktree + branch AND every story stacked on it, so ' +
      'the subtree re-runs from scratch. Refuses a story that is still running ' +
      '(stop it first with loom_stop_agent) and an epic that a live run is ' +
      'already dispatching (wait or stop it). Returns immediately with status ' +
      '\'dispatching\' — POLL loom_get_status to track the re-run. Use after a ' +
      'worker timed out or crashed; prefer resume unless the prior attempt went ' +
      'down a bad path.',
    inputSchema: {
      type: 'object',
      properties: {
        story_id: {
          type: 'string',
          description: 'The failed/blocked story to retry (e.g. story-001-002)',
        },
        clean: {
          type: 'boolean',
          description:
            'Discard the prior worktree + branch (and stacked dependents) and ' +
            're-run from scratch. Default false — resume from the checkpoint.',
        },
        reason: {
          type: 'string',
          description: 'Optional explanation recorded with the retry in audit_log',
        },
      },
      required: ['story_id'],
    },
  },
  {
    name: 'loom_get_decision_traces',
    description:
      'Read the worker\'s captured reasoning ("thinking" blocks and tool-use ' +
      'intents) from the decision_traces table. Use when investigating a failed ' +
      'or surprising run: shows WHY the worker reached for each tool, not just ' +
      'what it did. Exactly one of agent_id / story_id / epic_id is required to ' +
      'bound the lookup. Returns { traces: [{ kind, subject?, rationale, ts, ... }] }.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Scope to one agent' },
        story_id: { type: 'string', description: 'Scope to one story' },
        epic_id: { type: 'string', description: 'Scope to one epic (all its stories)' },
        limit: { type: 'number', description: 'Max traces to return' },
      },
    },
  },
  {
    name: 'loom_get_diff',
    description:
      'Return `git diff <epic.base_sha>..<branch>` for a story or an epic. ' +
      'Read-only: no mutation, no stash, no checkout. Use when reviewing what ' +
      'loom actually produced, before approving a PR or after a failed run. ' +
      'Bounded by max_bytes (default 200 KB) to keep the MCP response in budget; ' +
      'the truncated flag tells the caller whether the body was cut.',
    inputSchema: {
      type: 'object',
      properties: {
        story_id: { type: 'string', description: 'Diff this story\'s branch vs its epic\'s base' },
        epic_id: { type: 'string', description: 'Diff this epic\'s branch vs its base' },
        max_bytes: { type: 'number', description: 'Truncate the diff body to this many bytes (default 200000)' },
        include_stat: {
          type: 'boolean',
          description: 'Include the diff --stat summary alongside the full diff (default true)',
        },
      },
    },
  },
  {
    name: 'loom_get_planning_artifacts',
    description:
      'Read the brief, PRD, architecture, and epic YAML for one epic — the ' +
      'four planning outputs from Analyst → PM → Architect. Use this when the ' +
      'user (or an agent reviewing loom\'s work) needs to see WHAT was planned ' +
      'and not just what status the epic is in. Missing files return null in ' +
      'their slot rather than failing the whole call.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'string', description: 'Epic id (e.g. epic-001)' },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'loom_get_review',
    description:
      'Read the code-review verdict for one story produced by the ' +
      'block-and-revise reviewer. Returns { review_status, review_summary } — ' +
      'review_summary is the reviewer\'s markdown findings (BLOCKER / nit / ' +
      'praise sections). Returns status:noop when no review was recorded ' +
      '(review_strategy=off, or the worker hasn\'t finished).',
    inputSchema: {
      type: 'object',
      properties: {
        story_id: { type: 'string', description: 'Story id (e.g. story-001-002)' },
      },
      required: ['story_id'],
    },
  },
  {
    name: 'loom_list_projects',
    description:
      'Every loom-initialized repo on this machine, as recorded in ' +
      '~/.loom/projects.json. The registry self-heals — vanished directories ' +
      'are pruned on read. Returns { projects: [{ root, registeredAt }] }. ' +
      'Prerequisite for any multi-repo-aware MCP client.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'loom_get_project',
    description:
      'Detail for one registered project: its registry entry plus the latest ' +
      'epic from its .loom/loom.db when one exists. Useful for "give me a ' +
      'one-line status of project X" without spinning up loom in that ' +
      'directory.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Absolute path to the project root (must match the registered path)',
        },
      },
      required: ['root'],
    },
  },
  {
    name: 'loom_scan_signals',
    description:
      'Run signal scanners and produce a ranked opportunity board (operator-invoked). ' +
      'Scans audit logs, code debt, and GitHub issues; clusters them into opportunities ' +
      'with one LLM call; persists and returns the ranked board. Dismissed and scoped ' +
      'opportunities are never resurfaced. Returns { signalsObserved, signalsStaled, ' +
      'opportunities: [{ id, title, rationale, score, rank, signal_count, status, evidence, ' +
      'scoped_epic_id }] }.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'Optional: absolute project_root to scope the scan to one project. ' +
            'Must match an entry in ~/.loom/projects.json.',
        },
      },
    },
  },
  {
    name: 'loom_propose',
    description:
      'Propose the next epic by combining top-ranked lessons with top open opportunities. ' +
      'Runs ONLY on explicit operator action — no auto-trigger, no scheduler (NFR-3). ' +
      'Makes exactly one BriefRefiner LLM call. On gate pass, returns { ok: true, epicId } ' +
      'for a planned + manual epic stamped proposed_by=\'loom\' that stays planned until ' +
      'explicit human approval (call loom_approve_plan to dispatch). On gate fail, returns ' +
      '{ ok: false, critique } with the quality critique. The proposed epic also surfaces in ' +
      'GET /api/inbox as a plan_approval entry.',
    inputSchema: {
      type: 'object',
      properties: {
        top_lessons: {
          type: 'number',
          description: 'Max lessons to include in the brief (default: 5)',
        },
        top_opps: {
          type: 'number',
          description: 'Max open opportunities to include (default: 3)',
        },
      },
    },
  },
  {
    name: 'loom_set_autonomy',
    description:
      'Set the autonomy level for an epic. Accepts full-auto (supervisor dispatches ' +
      'and approves without human input), checkpoint (pauses after each story for ' +
      'operator review), or manual (default — operator must approve before dispatch). ' +
      'Writes an autonomy_set audit row on success. Returns { id, autonomy_level }.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: {
          type: 'string',
          description: 'Epic id to update (e.g. epic-001)',
        },
        level: {
          type: 'string',
          enum: ['full-auto', 'checkpoint', 'manual'],
          description: 'Autonomy level to set',
        },
      },
      required: ['epic_id', 'level'],
    },
  },
];
