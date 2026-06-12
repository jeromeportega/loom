# Loom Improvement Log — Pre-Week Dogfooding

Running list of possible improvements observed while dogfooding loom to build
loom (Epics A→D). Captured per phase. Each entry: what was observed, why it
matters, suggested fix, severity (S1 blocker / S2 friction / S3 polish).

---

## Epic A — Review Forge

### Phase: Baseline / environment

- **[S1] `npm run test` is unrunnable on stock macOS bash (3.2) — `globstar`
  dependency.** Workspace test scripts use `bash -O globstar -c 'node --test
  dist/**/__tests__/**/*.test.js'` (`packages/loom-core/package.json:28`, and the
  same pattern in mcp/web/cli). macOS ships bash 3.2, which errors
  `globstar: invalid shell option name`, so the suite exits 2 before running a
  single test. `fast-glob` is ALREADY a dependency of loom-core.
  *Why it matters:* the global rubric gate requires `npm run test` green on main,
  and loom's integration gate auto-detects `npm test`. If the gate shells out to
  this script it will fail on EVERY story regardless of code quality — a silent
  pipeline-wide blocker. (The "tests were green at plan-write time" handoff note
  likely reflects a machine with a newer bash on PATH.)
  *Suggested fix:* replace the `bash -O globstar` invocation with a node-based
  test runner that uses `fast-glob` (already present) or `node --test` with a
  glob it resolves itself — removing the bash-version coupling. Verify whether
  loom's integration gate runs this exact script before/while stories execute.

### Phase: Planning (brief gate)

- **[S2] Brief-quality gate verdict is misleading when score passes but `ready:false`.**
  `loom_start_epic` returned `status:"rejected"`, `reason:"brief_quality_below_threshold"`,
  `quality_score:7`, `min_quality_score:6`, with the message "Brief scored 7/10
  (need >= 6)." The score (7) is at/above threshold (6), yet it was rejected — the
  actual gating signal is the separate `ready:false` flag (open questions
  outstanding), not the score. The `reason` string and message directly
  contradict the numbers.
  *Why it matters:* an operator (or an autonomous caller) reading "below
  threshold, need >= 6, scored 7" cannot tell why it failed or how to fix it,
  and may wrongly `force` past a gate that was actually about unresolved
  questions.
  *Suggested fix:* when `ready:false` but `score >= min`, set
  `reason:"brief_not_ready_open_questions"` (or similar) and a message that
  points at the questions, not the score. Reserve `brief_quality_below_threshold`
  for genuine `score < min`.

- **[S3] Guard hook blocks `&&`/`;`/`||` with no documented escape for read-only
  compound checks.** Every environment-probe command (e.g. `test -n "$X" && echo`)
  is blocked by `shell.metacharacters`, forcing one-command-per-call. This is the
  intended structural-policy behavior, but a documented read-only allowance (or a
  `loom guard explain` hint suggesting the split) would reduce operator friction.

### Phase: Execution (worker containment + observability)

- **[S1 — privacy/containment] Worker reads are not confined to the project; a
  worker enumerating `$HOME`/`/` trips macOS TCC and could read personal data.**
  During the epic-001 run the operator got a burst of macOS permission prompts
  (Photos library, iCloud Drive, Desktop, "main computer folder") attributed to
  iTerm — i.e. a loom worker subprocess touched protected home-dir locations,
  almost certainly via an over-broad `find`/`grep`/glob while hunting for the
  BMAD source skills or the `_bmad/` overlay. The loom guard enforces
  `filesystem.allowed_write_root` + `protected_paths` for WRITES/deletes and
  blocks shell metacharacters, but places NO restriction on READS outside the
  project root. The only thing that stopped it was macOS TCC prompting the human.
  *Why it matters:* on build day real personal financial data is on disk; a
  worker must not be able to read `~/Documents`, Photos, iCloud, bank exports,
  etc. "Never commit real data" (RUNBOOK) is necessary but not sufficient if
  workers can READ it. Today the only backstop is an OS dialog the operator must
  manually deny under time pressure.
  *Suggested fix:* add read-confinement to the guard — block `find`/`grep`/`ls`/
  `cat`/glob whose resolved target escapes the project root (or the worktree),
  the same way writes are confined to `allowed_write_root`. At minimum, deny
  traversal of `$HOME` and `/` outright. Pair with a documented "data dir lives
  OUTSIDE the repo and outside allowed read scope" pattern for build day.

- **[S2 — observability] Worker bash commands are NOT in the central
  `audit_log`; only lifecycle events are.** Querying `audit_log` after the TCC
  incident showed dispatch/completion/code_review_pass/epic_rolling_merge rows
  per agent, plus the ORCHESTRATOR's own `bash_command` rows (agent_id null),
  but ZERO `bash_command` rows for the story workers — so the command that
  actually touched the home dir is unrecoverable from the audit trail. This sits
  in tension with CLAUDE.md invariant #5 ("All agent actions are logged to
  audit_log before returning to the caller"): the worker's guard-hook decisions
  live only in its (truncated, rotating) stdout log, not the durable table.
  *Why it matters:* you can't forensically answer "what did agent X run?" or
  "which command hit protected data?" from the audit log — exactly the question
  that came up here. Also weakens the rubric's "every action traceable" gate.
  *Suggested fix:* have the worker's guard hook append each policy-checked
  command (allow AND deny) to the central `audit_log` keyed by the worker's
  agent_id, not just the per-worktree stdout stream.

### Phase: Verify / ship (the big one — multi-agent integration-seam gap)

- **[S1 — correctness/process] Stories satisfied their ACs against static
  examples and left the real capability unimplemented; nothing caught it until
  manual review.** Epic A shipped a 7-story epic where every story passed its
  unit tests and the integration gate went green — yet the headline feature
  (adversarial-review + edge-case-hunter actually reviewing worker diffs) does
  NOT run. Concretely: the skill registry handlers in
  `packages/loom-core/src/skills/types.ts` are STUBS (`() => ({ findings: [] })`);
  the SKILL.md bodies (prompts) were filled but no story implemented the
  LLM-backed handler that loads a body and calls the model; and
  `reviewOrchestrator` is never wired into `workerFactory`/`run.ts`, so the
  three-reviewer pass can't fire. story-002 even tested against the
  "schema-valid worked example embedded in each prompt… not a live model call."
  capabilities.md was written (by story-007) to claim the skills run
  automatically — an overclaim, since they're dark.
  *Root cause (operator-confirmed):* the plan was generated under an
  untuned/invalid policy — `qa_planning` was the invalid value `"on"` at plan
  time, so the QA persona (Tessa) never ran and no story carried a "prove it
  executes live, with real skill_usage rows" verification bar. The architect's
  shared-contract carved clean per-story lanes; the cross-cutting "implement the
  executable handler + wire it in + thread the db" work belonged to no lane, and
  each worker honestly reported "seam in place, ready for wiring" and stayed put.
  *Why it matters:* a green epic that doesn't do the thing is the most dangerous
  failure mode — it passes every automated gate and only a human reading the
  runtime catches it. For build day this could ship a "working" demo that's
  hollow.
  *Suggested fixes:* (1) **tune policy BEFORE planning** — qa_planning/
  integration_branch/etc. shape the decomposition and the verification bar, and
  changing them post-plan only affects execution. (2) Give the architect/QA pass
  an explicit "integration owner" rule: any capability whose activation spans
  >1 story must have a final wiring+live-proof story that no other story's
  ownership boundary can disown. (3) The skill registry should warn/fail loudly
  when a non-stub skill is invoked but its handler is still the registered stub
  (e.g. a `stub: true` marker that integration tests assert is absent for
  shipped skills). (4) Acceptance phrasing like "emits findings on a sample
  input" must mean a live invocation, not parsing a static example — the QA bar
  should forbid the static-example shortcut.

- **[S3] Operator/status: `finalizing` is a real active phase but easy to
  mis-treat as terminal.** My own status watcher stopped early because
  `finalizing` (the EpicFinalizer running the gate + opening the PR) isn't in
  the obvious active set {in_progress, dispatching, planning}. loom does model it
  correctly (with a live `finalize_phase`), but a `finalize_phase`/`done`
  distinction in the one-line status string would make the active-vs-terminal
  boundary unambiguous for tooling.

### Phase: Execution (dispatch)

- **[S1 — cost] `policy.agents.model` is a dead knob for the claude-code worker
  backend; workers run on the operator's ambient model (here opus-4-8, ~5x
  sonnet).** `ClaudeCodeWorker` `DEFAULT_ARGS`
  (`packages/loom-core/src/orchestrator/ClaudeCodeWorker.ts:28-36`) passes NO
  `--model` flag to the `claude` CLI, so the worker uses whatever the operator's
  Claude Code default model is. Only the cursor backend honors a configured model
  (`workerFactory.ts:55` → `--model`). Meanwhile `policy.agents.model:
  "claude-sonnet-4-6"` is documented as "Claude model for story execution agents."
  Observed: epic-001 worker `system/init` reported `(starting claude-opus-4-8)`.
  *Why it matters:* every story + every review-loop revision runs on the priciest
  model regardless of the configured (cheaper) one. Across Epics A–D and
  especially build day (capped credits), that is roughly a 5x cost multiplier and
  a real risk of exhausting the budget mid-day. It also makes runs
  non-reproducible — cost/behavior depend on an out-of-band CLI default.
  *Suggested fix:* thread `policy.agents.model` into `ClaudeCodeWorker` and append
  `--model <id>` to the claude args (mirroring the cursor backend). Stopgap until
  then: set the operator's Claude Code default model to sonnet so spawned workers
  inherit it.

### Phase: Planning (plan review + policy config)

- **[S2] `require_human_pr_merge` is a declared-but-unenforced knob.** It exists in
  the zod policy schema (`packages/loom-core/src/types.ts:222`, default `true`) and
  the `loom init` template (`packages/loom-cli/src/commands/init.ts:511`), but a
  grep of `packages/loom-core/src` + `packages/loom-cli/src` finds NO consumer —
  no code reads it to gate a merge, and loom never auto-merges a PR regardless of
  its value. So an operator who sets `require_human_pr_merge: false` expecting
  hands-off merging gets no behavior change; merges remain a manual `gh pr merge`.
  *Why it matters:* false affordance — the policy promises autonomy it doesn't
  deliver, and the operator can't tell without reading source.
  *Suggested fix:* either implement auto-merge in the EpicFinalizer gated on this
  flag (+ a green integration gate), or delete the knob and document that PR
  merge is always operator-driven.

- **[S3] Planning pipeline is a genuine strength — low friction, high fidelity.**
  The Analyst→PM→Architect chain (6 LLM calls) turned the tightened brief into a
  faithful PRD (FR-1..FR-14), a clean 7-story DAG with a single foundation-contract
  story gating the rest, ADR references in tech_notes, and explicit trade-off
  callouts per story. Every resolved design decision from the brief survived into
  acceptance criteria verbatim. Worth preserving as the bar; noting because the
  improvement log shouldn't be all negatives (per the brief: capture what works).

- **[S3] `loom_get_planning_artifacts` returns one ~60KB blob that overflows the
  tool-result inline limit.** Forced a fallback to reading the artifact files
  directly. A `sections` or `fields` param (e.g. just the epic YAML, or just
  story titles+deps) would let a reviewer pull the stories DAG without the full
  brief+PRD+architecture payload.

- **[S2] Policy enum values are validated only at epic-approval time, not at
  edit time or by `loom doctor`.** `.loom/policy.yaml` had `qa_planning: "on"`
  and `integration_branch: "on"` — intuitive but invalid (the enums are
  `off|advisory` and `off|rolling`). `loom doctor` reported "All checks passed,"
  and the invalid state stayed silent until `loom_approve_plan` rejected with a
  zod error. An operator who set these expecting the feature ON got it silently
  OFF/invalid with no signal until they tried to ship an epic.
  *Why it matters:* "on" is the obvious guess for a boolean-looking toggle; the
  failure is deferred to the worst moment (mid-dispatch) and the error is a raw
  zod dump, not "did you mean 'advisory'?".
  *Suggested fix:* add a `loom policy validate` (and fold it into `loom doctor`)
  that parses `.loom/policy.yaml` against the schema and reports invalid enums
  with the allowed values + a nearest-match suggestion. Bonus: accept `on` as an
  alias for the single non-off enum where unambiguous.
