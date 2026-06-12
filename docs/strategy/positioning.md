# Strategic positioning

**Authored by Jerome (2026-05-26).** This is the load-bearing
strategic context for loom's architectural decisions. Read this
before designing anything that changes loom's substrate; it
specifies what's durable and what's not.

## The central thesis

> Will the frontier labs absorb orchestration itself as a native
> platform capability?
> Partially yes — but probably not completely.
> And the distinction matters enormously.

Orchestration is on track to commoditize. Cursor, Anthropic, and
the rest are visibly moving that direction. **Loom's long-term
moat is not the orchestration runtime.** It's the layer above:
**organization-specific operational intelligence**.

That layer is much harder for generalized frontier products to
solve universally — and it's exactly where loom is positioned.

## What will likely commoditize

Things loom should NOT bet its differentiation on, because
frontier labs will ship them natively over the next 12-24 months:

- basic orchestration
- simple agent delegation
- task decomposition
- tool routing
- lightweight evals
- autonomous loops
- memory
- repo ingestion
- PR generation
- planning modes
- IDE integrations
- background agents
- execution queues

When loom competes with these, it loses. Frontier labs have more
capital, more model access, and faster iteration. We ride their
roadmap; we don't fight it.

## What stays durable

The layer above the runtime. Things that DO NOT commoditize from
labs because they're irreducibly organization-specific:

- **organization-specific operational intelligence** —
  internal service semantics, low-code patterns, internal deployment
  workflows, planning heuristics that fit *the org's* shape
- **governance** — `allowed_remotes`, `forbidden_flags`,
  `protected_paths`, audit trail; the structural enforcement
  enterprise security wants
- **eval infrastructure** — bench harness, methodology gates,
  intervention ladder; provider-agnostic measurement in the org's
  operational context
- **workflow specialization** — release processes, approval
  topology, ownership coordination, internal MCP integrations
- **orchestration policies** — when to use which model, when to
  auto-propose vs require operator approval, when to require
  cross-model review
- **organizational memory** — a loom-skills repo as the
  version-controlled catalog of the org's coding judgment
- **execution topology** — concurrency caps, worktree isolation,
  budget controls, retry semantics
- **cost governance** — per-epic / per-story token + USD
  tracking, ceilings, intervention impact accounting
- **internal tooling integration** — the org's MCP registry,
  issue tracker, and internal service conventions
- **reusable skill ecosystems** — the SkillGenerator + Judge +
  Lifecycle + Proposer loop is the manufacturing line for
  organizational learning
- **enterprise workflow adaptation** — how loom actually fits
  into the org's existing engineering process, not how a demo runs
- **human oversight models** — push_gate, operator guidance,
  review-revise loops, HITL checkpoints
- **organizational trust systems** — provenance (`pr_attribution`),
  rollback semantics (`loom revert`), reproducibility (decision
  traces), forensics (`--preserve-all`)

These are loom's durable layer.

## The layered future

The stack we believe forms over the next 24 months:

```
┌────────────────────────────────────────────────────────────┐
│ Enterprise platforms like loom                            │
│  - organizational specialization                           │
│  - workflow governance                                     │
│  - internal integrations                                   │
│  - eval infrastructure                                     │
│  - operational intelligence                                │
│  - orchestration policies                                  │
│  - trust systems                                           │
│  - rollout mechanisms                                      │
│  - observability                                           │
│  - cost governance                                         │
│  - execution coordination                                  │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ Frontier labs                                              │
│  - foundation models                                       │
│  - native agents                                           │
│  - reasoning engines                                       │
│  - general orchestration primitives                        │
│  - tool use                                                │
│  - memory systems                                          │
└────────────────────────────────────────────────────────────┘
```

Loom is the second-layer thing. The thesis depends on us building
it that way deliberately.

## Enterprises don't want pure vendor dependence

A first-principles point. Large companies do not want:

- their entire SDLC
- governance model
- orchestration layer
- organizational intelligence
- internal workflows

…fully controlled by a single external AI vendor. They want
abstraction layers, provider flexibility, internal governance,
internal policies, organizational control, custom integrations.

**Loom naturally fits that role.** This isn't aspirational; it's
why `loom` exists at all and isn't just a `cursor.json`.

## Mapping loom's current state to the durable layer

### Already aligned (deepen these)

| Layer | Loom today | Why it stays valuable |
|---|---|---|
| Organizational memory | a `loom-skills` repo + self-learning loop (#18) | Each canonical skill is captured org judgment. Labs can't author the org's catalog. |
| Eval infrastructure | `loom-bench swe-bench-lite`, Gate 1-5 methodology, intervention ladder, decision-trace persistence | Provider-agnostic measurement in the org's operational context |
| Governance | `policy.yaml` + audit_log + PreToolUse hooks | Labs ship safety; enterprises ship governance |
| Provider abstraction | `LLMClient` and `WorkerRunner` interfaces | The firewall against vendor lock-in |
| HITL primitives | `push_gate`, operator guidance, `loom revert`, `loom_stop_epic`, brief quality gate, `pr_attribution` | Approval topology in primitive form |
| MCP integration surface | org MCP registry, issue tracker, internal service slots | Where org-specific tooling lands |

### Aligned but underbuilt (the strategy points here)

| Underbuilt layer | What's needed | Why it matters |
|---|---|---|
| Domain-aware skill catalog | Per-repo / per-domain skill explanations and selection | Skills are flat today; the manufacturing line works but the catalog isn't yet organization-shaped |
| Procedural workflow governance | `policy.yaml` extensions: who approves what, what rolls back when, ownership boundaries | Today's policy is structural; the gap is procedural |
| DX observability (#19) | Cloud Postgres + DX webhook | Not "metrics export" — how the org proves AI-native engineering is producing value |
| Cross-repo approval topology (#16) | Atomic PR-set semantics, ownership rules | "Who owns what across repos" is governance, not orchestration |
| Operationalization layer | Runbooks, methodology docs, rollout cadence | Already exists in `docs/testing/` and `docs/operations/`; keep first-class |

### Where loom should NOT compete

- Single-agent execution. Claude Code does this well; ride it.
- Tool surface (Bash/Read/Edit/Grep/etc.). Already offloaded; keep
  it that way.
- Foundation model capability. Loom is provider-agnostic by
  design — and stays that way only if we never let the orchestrator
  know which provider it's talking to.
- General-purpose autonomous coding runtime. Cursor will likely
  win that. We sit *above* it, not in it.

## Architectural commitments

These are non-negotiable. Anything that violates them is a
strategic regression, not a feature:

1. **`LLMClient` and `WorkerRunner` interfaces stay clean.** Any
   direct `anthropic-api` call from orchestration code, any
   hardcoded model id outside policy, any Claude-stream-json
   assumption leaking past `ClaudeCodeWorker.parseStreamLine` —
   reject in review. The cross-model review intervention shipped
   (Run 10d) USES this abstraction correctly; that's the pattern.
2. **No Claude-Code-specific assumptions in `loom-core/orchestrator/`.**
   A future `ClaudeAgentSDKWorker` or `GeminiCliWorker` should drop
   in without touching anything else. The `WorkerRunner` interface
   is the seam.
3. **Methodology infrastructure is first-class.** Bench harness,
   gate writeups, intervention ladder. These are loom's external
   proof that AI-native engineering works in the org's context. Labs
   won't ship this for *the org*.
4. **Skill supply chain is the highest-leverage investment.** Every
   skill authored in the `loom-skills` repo is a piece of the org's
   operational intelligence captured. Auto-propose multiplies it.
   Future features should ask: *does this make the skill loop richer?*
5. **Policy engine grows procedurally, not just structurally.**
   Today's `policy.yaml` says what's forbidden. Tomorrow's needs
   to encode who approves what, what rolls back when, and how
   ownership works across repos.
6. **HITL primitives stay first-class.** `push_gate`, operator
   guidance, `loom revert`, brief quality gate, review-revise
   loops. Enterprise approval topology depends on these existing
   and composing.
7. **Provider abstraction extends to the bench harness.** The
   bench shouldn't care which underlying model produced a patch —
   it measures loom's behavior, not Claude's capability. That's
   why the bench harness is durable.

## The biggest strategic risk to avoid

> Do not let loom become *"a giant custom wrapper around today's
> frontier model UX."* That would be vulnerable.

Concrete vulnerability signs to watch for:

- Tight coupling to `claude` CLI specifics (stream-json schema,
  flag names, output format) that ripples past
  `ClaudeCodeWorker`.
- New features that only work with Claude Code, not Cursor CLI.
- Skill format drifting from `agentskills.io` toward a
  loom-proprietary shape that doesn't transfer.
- Hardcoded model ids appearing outside `policy.yaml` defaults.
- New abstractions that DON'T go through `LLMClient` /
  `WorkerRunner`.

When in doubt, the test is: "If Anthropic shipped a competing
orchestrator tomorrow, how much of loom survives?" The answer
should be: **everything in the durable layer above** (skill supply
chain, governance, eval infrastructure, organizational memory,
HITL primitives). If the answer is less, the design is leaking.

## What this means for prioritization

Going forward, every prioritization decision should weigh against
the durable-vs-commoditizable axis:

- **Highest priority:** investments that strengthen the durable
  layer (skill supply chain depth, governance, eval infrastructure,
  organizational integration).
- **Defensive priority:** investments that protect the abstraction
  boundaries (`LLMClient` cleanliness, provider-agnostic design,
  bench harness portability).
- **Low priority:** investments in orchestration capability that
  duplicates what frontier labs are likely to ship within 12-24
  months.
- **Anti-priority:** anything that increases coupling to a single
  provider's specific UX or API shape.

## Why the strategic question itself is the right one

Asking "is this differentiated?" is the kind of question that
prevents an enterprise platform from being absorbed in 18 months.
The fact that we're asking it now — while building, not retrospectively
after the labs ship a comparable surface — is what gives loom a
real chance to compound into the durable layer.

---

## Operational corollary — what survives if labs ship a SUPERIOR multi-agent harness?

Concrete retire / keep / reconsider mapping against loom's
current modules (2026-05-26). "Superior" here means we don't get
to keep code that does the same thing, only worse.

### RETIRE — the orchestration substrate

If labs ship a superior multi-agent harness, we'd retire roughly
half of `loom-core/orchestrator/`:

| Module | Why it retires |
|---|---|
| `orchestrator/Supervisor` | Multi-agent dispatch, queue, concurrency, dependency ordering. Their harness does this better → ours goes. |
| `orchestrator/BaseCliWorker` + `ClaudeCodeWorker` + `CursorAgentWorker` | Wrappers around CLIs. If their harness IS the CLI integration, our wrappers are dead weight. |
| `orchestrator/WorktreeManager` | Git worktree per story. They'd ship a better-integrated isolation primitive. |
| `orchestrator/workerFactory` | Dispatch factory — goes with the workers. |
| `orchestrator/workerPrompt` | Prompt template + render. If they handle prompt assembly natively, dead. |
| `planner/Planner` + the orchestration around personas | The dispatch pipeline (Analyst → PM → Architect chained calls) retires. The persona prompts themselves stay (see KEEP). |
| `bench/SweBenchRunner` per-task loom-init + per-task subprocess invocation logic | If their harness ships a bench mode, the wrapping retires. The bench tasks + scoring methodology stays. |
| `loom-cli` orchestration commands: `loom run`, `loom approve`, parts of `loom epic` | These wrap our orchestration. Retire with it. |
| `loom_stop_agent`, `loom_stop_epic`, `loom_approve_plan` MCP tools | Orchestration controls — go with the orchestrator. |
| Most of `loom-web` real-time worker UI | If their harness has comparable dashboard, our worker-stream UI retires. Federation + audit-review stays. |

Roughly **30-40% of the TypeScript codebase** by line count.

### KEEP — and the line count understates how much this is

| Module | Why it stays |
|---|---|
| `skills/` (entire directory) | **The whole self-learning loop.** Labs don't ship the org's catalog or the org's propose-PR workflow. |
| The `loom-skills` repo itself | Organizational memory. Org IP, not code. |
| `guardrails/PolicyEngine` | `allowed_remotes` / `forbidden_flags` / `protected_paths`. Labs ship safety; enterprises ship governance. |
| `state/AuditLog` | Compliance shape — who did what when, with policy-rule attribution. Labs may ship logs but not the *audit shape* org compliance asks for. |
| `state/DecisionTraceStore` | Worker reasoning forensics persisted to the org's DB. Even if labs persist reasoning, they won't put it in the org's SQLite with the org's queries. |
| `state/SkillUsageStore` | Per-skill track record. Part of the lifecycle loop. |
| `state/EvalRunStore` | Eval / bench history. Methodology persistence. |
| `state/ProjectRegistry` | Cross-repo project tracking (where #16 lives). |
| `personas/` (Analyst, PM, Architect, worker, researcher, skill-extractor, skill-judge) | **org-tuned prompts.** Labs ship general agents; the org's domain prompts stay regardless. |
| `brief/BriefRefiner` + `loom-brief-builder` skill | Brief quality gate. Could re-platform on a lab tool, but the org-tuned brief-builder skill IS the moat. |
| `review/CodeReviewAgent` | Block-and-revise structural loop. Labs may ship "self-review"; the severity-threshold-driven revise machinery + cross-model routing is loom's governance flavor. |
| `bench/` SWE-bench loader + scoring + methodology integration | Provider-agnostic measurement. |
| `eval/` planning-eval framework | Provider-agnostic. |
| `llm/LLMClient` interface | **The provider abstraction itself.** Becomes the seam against the *next* vendor lock-in. |
| `orchestrator/EpicReverter`, `orchestrator/OperatorGuidance` | HITL primitives. Approval-topology shape. |
| MCP introspection tools (`loom_get_decision_traces`, `loom_get_diff`, `loom_get_planning_artifacts`, `loom_get_review`, `loom_list_projects`, `loom_get_project`) | Query loom's persistent state. Labs query *their* state, not the org's. |
| `loom revert` CLI + MCP | Rollback semantics — enterprise trust system. |
| All `docs/operations/`, `docs/testing/`, `docs/strategy/` | Institutional knowledge. Not code at all. |
| Agentskills.io skill format | Already an open standard. Survives by design. |
| `pr_attribution`, `push_gate`, `require_brief_quality`, `review_revise_trigger`, `operator_guidance`, `skill_auto_propose*` knobs + wiring | Approval-topology + organizational-policy primitives. |
| DX observability (#19, designed) | Operational layer for engineering management. |

Roughly **60-70% of the TypeScript codebase** by line count, but
**easily 90%+ of the strategic value** because the durable layer
is denser than the orchestration layer.

### RECONSIDER — depends on what exactly they ship

| Module | Hinges on |
|---|---|
| `orchestrator/EpicFinalizer` | If they ship "release this set of agent runs" as a primitive, the merge composition retires. The org-specific artifact promotion (`.loom_outputs/<epic-id>/`) + PR body format + skill-aware diff composition stays. Likely: keep promotion, retire merge. |
| `loom-web` dashboard | If they ship multi-agent visualization, the worker-stream UI retires. Cross-project federation + audit-log review + cost-rollup view stays. |
| Most CLI subcommands | Wrap both retire-and-keep modules. Retire orchestration verbs (`run`, `approve`, parts of `epic`); keep `skills`, `revert`, `guide`, `cost`, `web`, `bench`. |

### The migration is the strategy doc's commitments paying off

The whole reason this question has a clean answer is that **the
`LLMClient` and `WorkerRunner` interfaces have stayed clean**
(commitments #1 and #2 above). If those abstractions had
Claude-stream-json leaking through them, the retire/keep split
would be much messier.

The migration would look like:

```
1. Implement `LabHarnessWorker implements WorkerRunner` adapter   (1 new file)
2. Implement `LabHarnessClient implements LLMClient` adapter      (1 new file)
3. workerFactory routes to LabHarnessWorker when
   policy.agents.worker_backend='lab-harness'                     (1 line)
4. Run bench against new backend — measure parity / regression
5. Promote to default when parity established
6. Mark ClaudeCodeWorker / CursorAgentWorker / Supervisor dispatch
   as deprecated
7. Remove a release cycle later
```

**The whole migration touches 2 new files + 1 policy schema
change + 1 factory line.** Everything downstream is intact because
the durable layer never imports from `orchestrator/Supervisor`
directly — it talks to `WorkerRunner` and `LLMClient`.

### What this means for what we build now

The retire/keep split tells us where to invest *more* aggressively:

1. **Skills + the loom-skills repo (the supply chain).** Every org
   skill authored is a piece of value the migration preserves
   perfectly. Auto-propose is the conveyor belt; ship more skills.
2. **Policy engine procedural extensions.** Approval topology,
   ownership rules, rollback automation. Migration-proof governance.
3. **DX observability (#19).** The operational visibility layer
   that survives any orchestrator change.
4. **Methodology infrastructure.** Bench harness, intervention
   ladder, gate writeups. Migration-proof and provider-agnostic.
5. **`LLMClient` and `WorkerRunner` cleanliness vigilance.**
   Anything that violates these in PR review is a strategic
   regression — kill it. The clean abstraction is what makes
   the retire/keep split clean.

And where to invest *less*:

1. **Adding more orchestration primitives.** If they're going to
   retire, deepening them is sunk cost.
2. **Capturing more state about Claude Code's specific output
   format.** Already partly leaked through
   `ClaudeCodeWorker.parseStreamLine`; don't extend it.
3. **Building visualization that duplicates Cursor / Claude Code.**
   Federation across projects + audit review = unique. Per-worker
   stdout streaming with markdown render = duplicates their UI.
