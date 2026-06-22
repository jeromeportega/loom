# Dogfooding log — removing the loom MCP server

**Started:** 2026-06-17
**Driver:** Claude Code (acting as operator), at the maintainer's request
**Goal:** Remove the *loom-as-an-MCP-server* surface (`packages/loom-mcp`,
`loom serve`, `loom init --mcp`, `.mcp.json` generation, the `mcp__loom__*`
tools) so the CLI is loom's sole interface. **Keep** worker-facing MCP
provisioning (`loom mcp add` / `policy.mcp.registry` / `WorktreeMcp` /
`CursorMcpEnforcer`) — that grants *workers* third-party tools and is
unrelated to loom exposing itself.

This effort is run **through loom itself** (`loom epic` → `loom approve` →
`loom run`) to dogfood the orchestrator. This file records friction and
improvement ideas surfaced while doing so — per the maintainer's standing
instruction to capture suggestions as we go.

### Mission (expanded 2026-06-17)
Two epics, both driven via loom, operator approving plans as needed:

1. **Port-then-remove the loom MCP server.** *First* port any access layer
   the MCP server exposes that the CLI lacks (so no capability is lost), then
   delete the loom-as-server surface cleanly — code, tests, **and every doc
   mention** (capabilities.md, CLAUDE.md, README, getting-started, schemas).
2. **LLM-parseable CLI command descriptions.** Define a standard for
   machine-readable descriptions of every CLI command, then write those
   descriptions, so an interface like Claude Code can drive loom entirely
   through the CLI to accomplish any loom task.

Safety net: loom opens PRs but never merges them (`require_human_pr_merge`),
so approving *plans* is safe — the maintainer still gates the final merge.

---

## Improvement suggestions for loom (captured while dogfooding)

### S1 — `docs/capabilities.md` has no enforcement, and it drifted
`CLAUDE.md` mandates "update `docs/capabilities.md` in the same PR" for any
user-visible change, but the page silently drifted. As of 2026-06-17 (last
updated 06-13) it is missing / wrong on:
- **Missing knobs** shipped in PRs #19/#22: `policy.agents.adaptive_cost`,
  `triage_model`, `risky_paths`.
- **Documents commands that don't exist:** `loom skills history <name>`
  (cap line ~114), `loom skills propose <name>` (line ~179).
- **Documents non-existent tuning knobs:** `skill_generation_sample_n`
  (line ~174), `skill_auto_propose_min_judge_score` + `_max_per_epic`
  (line ~177).
- **Stale "NOT-do" item:** the anthropic-api mid-spawn-guidance entry
  (line ~256) — that backend was removed in v0.4.

**Suggestion:** add an integration-gate / CI check that fails when a PR
touches `packages/**/src` (a user-visible surface) without touching
`docs/capabilities.md`, or a `loom doctor --docs-drift` that diffs declared
CLI subcommands / MCP tools / policy knobs against the page. The honor-system
rule is not holding. *(These drift fixes are tracked here as follow-ups, not
folded into the MCP-removal epic, to keep that epic tightly scoped.)*

### S2 — the guard hook correctly governs the operator too (working as intended)
`loom guard hook` blocks `&&` chaining for *my* shell commands via the
Claude Code `PreToolUse` hook, forcing one command per call. This is correct
and desirable (the policy is structural, not advisory). Noting it only as
confirmation that the guardrail surface behaves as documented — no change
needed.

---

### S4 — release docs/workflow describe the MCP as "the primary surface"
`docs/operations/releasing.md` lists `@loom-ai/mcp` as "MCP server (the
primary loom surface)" and asserts "Workers reach loom via the MCP server" —
both false since the CLI-first pivot (PR #17) and doubly so after this
removal. The npm publish workflow (`.github/workflows/publish-npm.yml`)
publishes `@loom-ai/mcp` too. Both must be corrected when the package is
deleted. **Suggestion:** the releasing runbook should be regenerated from the
actual `workspaces` list rather than hand-maintained, so a package add/remove
can't leave it stale.

### S3 — port-first: candidate MCP-only access layers (RESOLVED by gap analysis)
Confirmed real CLI gaps to port before deletion (full table in the run log):
- **`loom pull-guidance`** (CRITICAL) — cursor workers pull live operator
  guidance *only* via the `loom_pull_guidance` MCP tool, materialized into the
  worktree `.cursor/mcp.json`. No CLI path today; deleting the server breaks
  cursor-backend live steering. (claude-code backend unaffected.) Port to a
  `loom pull-guidance` CLI command + update the cursor worker prompt.
- **`loom project ROOT`** — no CLI way to fetch one project's detail.
- **`loom stop --epic`** — no per-epic worker kill (no-arg `loom stop` halts
  the whole supervisor; different semantics).
- `--project` scope on `loom status`/`loom scan`; `--top-lessons`/`--top-opps`
  /`--json` on `loom propose`; `--reason` on `loom stop`/`loom retry`.
`packages/loom-mcp` is a **production leaf** — safe to delete once the above
land and the loom-web test-only dep + MCP-referencing tests are cleaned up.

### S3-original — port-first: candidate MCP-only access layers
Removing the server must not drop a capability. Tools to scrutinize for a
CLI gap before deletion (verified by the gap analysis below):
- `loom_stop_agent` (kill one worker/story) — capabilities.md lists only the
  MCP form; CLI may have `loom stop` (epic-level) but no story-level kill.
- `loom_pull_guidance` (worker-side guidance pull, cursor backend) — served
  by the loom MCP server; if removed, how does a worker pull guidance?
- `loom_get_project` (single project) vs CLI `loom projects` (list).
- `--json` output parity for every read command (Claude Code parses JSON).

### Positioning (maintainer directive, 2026-06-17)
The two-surface story is now explicit and must be reflected everywhere the
docs/positioning talk about interfaces:
- **CLI = the usability surface** (how you drive loom).
- **Web (`loom web`) = the observability surface** (how you watch loom).
- The MCP server is **not** a surface loom offers anymore. Scrub every
  "MCP as a first-class citizen / primary surface", "first-class Claude
  Code/Cursor support (via MCP)", and "two interfaces over the same engine"
  framing in favor of the CLI+Web split.

### S5 — invalid policy value crashes EVERY command with a raw ZodError
Setting `qa_planning: "on"` and `integration_branch: "on"` (natural, since
most knobs are on/off, but these enums are `off|advisory` and `off|rolling`)
made **every** loom command exit 1 with an unhandled `ZodError` stack trace
from `PolicyEngine.load()` — no mention of the file, the field, or the valid
values. A user who fat-fingers one enum loses the whole CLI with a Node crash
dump. **Suggestions:** (1) catch the Zod error in `PolicyEngine.load()` and
print a friendly message — file path, offending `agents.<key>`, received vs
allowed values, and a fix hint; (2) make `loom doctor` validate
`.loom/policy.yaml` and report invalid knobs as a failed check; (3) consider
accepting `on` as an alias for the single non-`off` value on binary-feeling
enums (`on`→`rolling` for integration_branch, `on`→`advisory` for qa_planning),
or at least call out in `policy.example.yaml` that these two don't use on/off.

### S6 — a PASSING brief (8/10) still hard-stops with exit 1, no clear path forward
`loom epic` ran the BriefRefiner, printed "Brief scored 8/10 (need >= 7)"
(a pass), then printed a clarification critique and "Tighten the brief above
and re-run", exiting 1. From the output an operator cannot tell whether this
is a hard fail or a soft clarification stop, nor that `--force` is the way
through (the critique is also produced under `--force` and audit-logged).
**Suggestions:** (1) when score >= threshold, either proceed to planning or
print an unambiguous "brief PASSED; N optional clarifications below — re-run
with --force to plan as-is, or tighten" message and use a distinct exit code;
(2) don't reuse the same refused-looking output for pass-with-questions vs
below-threshold fail. Also: the score gate (`min_brief_quality_score`) reads
as a floor, but a passing brief is still blocked on open questions — document
that the clarification pass is a second, separate gate.

### S7 — planning is a ~5-minute black box; give it story-level visibility (candidate epic)
Today a running plan only exposes a coarse `planning_phase` label (analyst /
pm / architect). Stories, by contrast, stream live worker stdout to `loom web`
over SSE (`log_tail`) and to `loom run --verbose`. Planning deserves the same:
the operator is waiting minutes with no feedback on what the personas are
actually doing, whether it stalled, or how far along it is.
**Desired:** stream the planner persona subprocess output (the claude-cli
calls for Analyst → PM → Architect) to:
- `loom web` — a live planning log panel on the `planning` epic card, reusing
  the existing SSE `log_tail` plumbing already built for worker stdout;
- `loom epic --verbose` / `loom status --watch` — tail the same stream in the
  terminal;
- optionally a per-persona progress signal (tokens streamed, elapsed, current
  artifact being written: brief → PRD → architecture → epic.yaml).
**Why it matters:** planning is the first thing a new operator runs; a silent
5-minute hang reads as "is it broken?". This is the single biggest feedback
gap in the happy path. **Likely a standalone epic** ("Planning observability")
— it touches the planner (emit a stream), loom-core state (a planner log
sink / SSE event), and loom-web (render it). Pairs naturally with the
observability-surface positioning ([[loom-positioning-no-mcp]]: web = how you
watch loom). **There is no workaround today:** confirmed live that even the
raw `loom epic` stdout emits only "Planning your epic … Runs headless, takes a
few minutes" and then nothing until completion — the persona subprocess output
is captured nowhere the operator can see. The black box is total.

### Observation — the planner auto-split one brief into two well-sequenced epics (positive)
One `loom epic` brief produced **epic-002 (CLI Parity Port)** + **epic-003
(Remove MCP server + scrub positioning)**, 12 stories, with epic-003's removal
stories correctly depending on epic-002's parity-oracle test (`story-002-006`).
The plan even pinned the retain-side boundary (never touch
`packages/loom-core/src/mcp/*`) in every removal story and defined "scrub
done-ness" as a re-runnable forbidden-string grep. This is exactly the
decomposition I would have hand-authored — good PM/Architect behavior.
**Caveat to watch (potential S8):** four epic-002 stories (002-001..004) all add
commands to `packages/loom-cli/src/index.ts` — a single-file conflict hotspot
under `max_concurrent: 10` + rolling integration. The bounded `integrator` is
on, so this is a real test of conflict auto-resolution. Watching for a
merge-back conflict storm on one entry file.

### Execution sequence (decided)
Run sequentially so epic-003 dogfoods on a main that already has the ported
commands + parity test:
1. epic-002 → run → land PR → release `4.3.0` (minor: new CLI commands) → rebuild/relink.
2. epic-003 → run → land PR → release `5.0.0` (major: MCP server removed, breaking) → rebuild/relink.
3. then plan the third epic (LLM-parseable CLI command descriptions) on the new surface.

### S8 — cross-epic overlap advisory extracts prose tokens as file paths
`loom approve` printed a "28 files claimed by more than one epic" advisory in
which many "files" are clearly not paths — `the`, `and`, `Delete`, `lines`,
`Root`, `writeMcpJson`, `addLoomServer`, `loomMcpServerEntry`, `.command`,
`≈410–419)`. The detector is lexically scraping the epic YAML / tech_notes
prose and treating bare identifiers and words as filenames. **Suggestion:** the
overlap scan should only consider strings that look like real paths (contain a
`/` or a known source extension, and exist on disk or under a workspace dir),
and should read each story's declared file-ownership/contract rather than
grepping free-text tech notes. As-is the advisory cries wolf (28 "files", most
fake), which trains operators to ignore it — the opposite of its purpose.

### S9 — loom never records which MODEL a worker ran on (no attribution)
The `agents` table has `cost_usd` + token columns but **no `model` column**;
decision traces carry `metadata: null`; the run logs don't print it either. So
from every operator surface you cannot tell whether a builder ran Sonnet or
Opus. This bit hard historically: a model-routing bug silently ran every
builder as Opus-4.8 instead of the configured Sonnet-4.6 (fixed in #3 / #16),
and loom's own data could not have surfaced it — we confirmed Sonnet only
*indirectly* via `cost_usd` (~$1–3/story = Sonnet; Opus would be ~5×).
**Suggestion:** add a `model` column to `agents` (and the planner/reviewer
records), populate it at spawn from the resolved policy, and surface it in
`loom status`/`loom_get`-style output + traces. Model attribution is basic
cost/perf hygiene and the exact guard that would have caught the routing bug.

### S10 — per-worker token telemetry looks under-populated (verify)
In this run, `agents.tokens_input` reads 41 / 30 / 31 for stories 001–003 and
the `tokens_output` / `request_count` columns are blank, while `cost_usd` is
present. Those token counts are implausibly low for ~250-line diffs, so the
claude-code stream-json usage harvest may be capturing only a partial/final
delta (or the wrong field) rather than cumulative usage. **Not certain** —
could be a display artifact — but worth confirming, since the capabilities
page advertises per-story token rollups as accurate. If real, planning-token
and per-story cost dashboards are under-counting.

### S11 — loom's protected-branch guard makes its own release runbook un-runnable
`docs/operations/releasing.md` says to "commit the bump on main … `git push
origin main` / `git push origin vX.Y.Z`". But loom's PreToolUse guard
(`git.protected_branches`) blocks `git push origin main` with "open a PR
instead" — for **everyone**, including the operator cutting a release. There is
no operator-vs-agent distinction in the guard, so the documented release flow
cannot be executed in a loom-init'd repo (which is every loom repo). Confirmed
live: `git push origin main` of the v4.3.0 bump was blocked even with
`require_human_pr_merge: false` and explicit operator authorization.
**Suggestions (pick one):** (a) fold the version bump into the EpicFinalizer's
epic PR so releases never need a separate push to main; (b) add a narrow,
explicit operator/release escape (e.g. allow pushing a tag, or an env-gated
`LOOM_RELEASE=1` bypass that the guard honors only for the operator shell);
or (c) rewrite `releasing.md` to a release-PR flow. Today the only working path
is a release PR, which is what we are doing. **Confirmed:** tag pushes are NOT
blocked (`git push origin v4.3.0` succeeded) — only branch pushes to a
protected branch are. So the lightest real workaround is: bump on a
`release/vX.Y.Z` branch → PR → merge → `git push origin vX.Y.Z` for the tag.

### S12 — rolling-integration epic branch can diverge → finalize push fails → epic stuck `failed` with no recovery command
epic-003 finished with **all 6 stories done and the integration gate GREEN**,
but the EpicFinalizer's push of `epic/epic-003` was rejected non-fast-forward:
rolling integration had pushed `epic/epic-003` to the remote off an earlier
base during the run, then the finalizer rebuilt the branch locally on the
newer `main` (post-4.3.0), so local and remote diverged (`59 ahead / 15
behind`). Force-push is correctly blocked, so the push failed and loom marked
the **whole epic `failed`** — despite a complete, gate-green tree. Worse,
**there is no operator command to recover it**: `loom reconcile` targets
`in_progress` gate-blocked epics, not `failed` ones; `loom retry` is per-story;
there is no "re-finalize" / "re-push epic" action. I recovered by hand —
pushed the local epic branch to a fresh ref and opened a PR.
**Suggestions:** (1) the finalizer should push the epic branch to a fresh/
unique ref (or `--force-with-lease` *its own* just-created branch under a
narrow allowance) rather than collide with the rolling-integration ref; (2)
distinguish "work complete, only the push/PR step failed" from a real failure —
that state should be recoverable, not terminal `failed`; (3) add a
`loom finalize <epic>` / `loom reconcile` path that opens the PR from an
already-merged, gate-green epic branch; (4) clean up the stale remote epic
branch the rolling integration left behind.

### S13 — "scrub everywhere" done-ness was scoped to an enumerated file list, so unlisted docs slipped
The brief/epic listed specific docs to scrub (capabilities, CLAUDE.md, README,
getting-started, index, releasing), and the done-ness test (`docsScrub.test.ts`)
checked the forbidden strings over *that same list*. So the gate went green
while `docs/architecture/index.md` (a dir tree still showing
`loom-mcp/ # MCP server (loom serve)`), `docs/architecture/worker-resilience.md`,
and `docs/testing/runbook.md` kept live `loom serve` / MCP-server references.
The maintainer's intent was "scrub the docs and all that … cleanly" — i.e.
everywhere. **Suggestion:** a "remove a surface" epic's forbidden-string check
must run over the WHOLE tree minus an explicit allowlist (here: the pattern-
defining tests + `cursor-mcp-strictness.md` + retained provisioning), never an
enumerated include-list. Enumerated lists silently exclude what nobody thought
to list. Also: a couple of stale loom-core comments ("cursor-cli gets the loom
server", ADR-3) survived and now mislead — verify the loom-server entry is
truly unwired for cursor, not just doc-commented.

### S14 — removal left vestigial dead code + a historical doc section (tracked follow-up)
Two residues from epic-003 that passed the build/gate but aren't fully clean:
1. **Vestigial `loomServerEntry` plumbing.** `WorktreeMcp.ts` (the param + the
   `if (opts.loomServerEntry)` block) and `Supervisor.ts` (the `loomServerEntry`
   opt + the `backend === 'cursor-cli' ? this.opts.loomServerEntry : undefined`
   branch) survive, but `run.ts` no longer constructs a `loom serve` entry, so
   the path is fed `undefined` and is a no-op. Dead code + misleading comments
   ("cursor-cli gets the loom server", ADR-3). Harmless, but should be removed
   in a focused, tested follow-up (it touches retained-provisioning signatures,
   so not a release-PR hand-edit).
2. **Historical runbook section.** `docs/testing/runbook.md` still carries
   "Definition of done for Epic 4" (the MCP-server epic) with `loom serve` + MCP
   tool checks — retained as a historical record (like `docs/reviews/`). A
   comprehensive runbook pass, or a "historical docs" allowlist for the
   done-ness grep, is the right treatment; left for the maintainer to decide.
The LIVE stale refs (architecture dir-tree, worker-resilience dispatch sentence,
runbook verification step) ARE fixed in v5.0.0.

### S15 — web UI can only ever show a ~2–4 KB tail of worker output (full log never persisted)
Not an MCP item, but surfaced while watching runs. The "truncated output" in
`loom web` is loom's own `log_tail`, capped twice: the live rolling buffer is
sliced to the last **4096 chars** (`Supervisor.LIVE_TAIL_CHARS`, append site
`Supervisor.ts:1801-1803`) and flushed to `agents.log_tail`; at completion that
is overwritten by **`tail(proc.output, 2000)`** (`LOG_TAIL_CHARS`,
`BaseCliWorker.ts:209`). The web SSE (`events.ts:162-174`) streams clean
suffixes smoothly but re-emits the WHOLE tail on the "truncation or
replacement" branch when the buffer wraps or the final 2 KB tail replaces the
4 KB live buffer — which is the visible shrink/jump. **claude-cli is not the
cause** (it streams full output; loom parses all of it, even keeping the full
assistant text transiently for the self-assessment marker, `BaseCliWorker.ts:288`).
The full worker log is **never persisted** — not in the DB, not on disk.
**Suggestions:** (1) persist the full per-agent log to a file
(`.loom/logs/<agent>.log`) and have the web serve/stream that on demand, so the
dashboard can show a complete story log; (2) failing that, raise the caps and/or
make the truncation explicit in the UI ("showing last 4 KB — full log not
retained"); (3) the dual 4096/2000 caps are also inconsistent (final view is
SMALLER than the live view), which is itself a small surprise.

### S16 — log panes reset to a "single window" after idle/reconnect; SSE diff is not resumable
Compounds S15. The detail view's client buffer (`logBuffersByAgent`,
`index.html:683`) is wiped on every view (re)entry/reload and is never restored
from anything durable. The server's SSE state is per-connection
(`events.ts:55`), so a reconnect replays only its current bounded tail (2–4 KB).
Net: background the tab a while → browser discards/reloads it → client buffer
empties → reconnect → you see only the last ~2 KB. Also a real client bug: the
merge `next = chunk.startsWith(prev) ? chunk : prev + chunk` (`index.html:692`)
either **truncates** (empty buffer → shows just the resent tail) or
**duplicates** (non-empty buffer, tail not a prefix → appends the tail again) on
reconnect — neither is correct. The server emits a `hello` epoch
(`events.ts:43`) that the detail view ignores.
**Fix (needs both halves):** (1) persist the full per-agent log server-side
(`.loom/logs/<agent>.log`), per S15; (2) make (re)connect authoritative — on
connect, `GET` the full log to rebuild the pane, then have the SSE carry only
true incremental appends with `Last-Event-ID` resumption from a durable byte
offset (and use the `hello` epoch to force a re-fetch on server restart).
That makes the stream append-only over a durable log instead of diffing a
bounded tail and hoping the client buffer lines up.

### S17 — the integration gate gives FALSE BUILD failures for cross-package API additions
epic-005's gate failed with `Property 'publishPending' does not exist on type
'EpicStore'` building `@loom-ai/web` — yet the method IS defined in
`@loom-ai/core` (`EpicStore.ts:395`) and the branch builds + tests green
(~1982 tests) in a properly-linked tree. Cause: the gate runs in a throwaway
`.loom/integration/<epic>` worktree where loom "never auto-installs deps", so
`@loom-ai/web` resolves a STALE `@loom-ai/core` (old built `.d.ts` without the
new method). A story that adds an API to a dependency package + a dependent
package that uses it ⇒ false red gate. Under `integration_gate: block` this
would have wrongly withheld a sound PR. **Fix:** before building dependents,
the gate must refresh workspace links / rebuild-and-relink changed dependency
packages (e.g. `npm ci` or `npm install` in the integration worktree, or build
core→web in dependency order against the worktree's own dist), so the merged
tree the gate tests matches a real `npm install`ed checkout.

### S18 — stale `dist/` + removed-package leftovers cause false TEST failures on long-lived trees
Verifying epic-005 locally, two more false failures appeared that a fresh
worktree never sees: (1) `packages/loom-mcp/` still existed on disk (only an
untracked `dist/` leftover from a pre-removal build; git tracks nothing there),
so epic-003's removal-guard tests that assert *disk* non-existence failed; (2)
a stale `dist/__tests__/blockedSurfaces.test.js` (the pre-rename name — `tsc`
never deletes stale outputs) was still picked up by the runner's
`find dist -name '*.test.js'` and failed against removed MCP behavior. Both
mean `npm test` fails on any dev machine that built before pulling a
removal/rename, until `dist/` is hand-cleaned. **Fix:** clean `dist/` before
build/test (a `prebuild`/`pretest` `rm -rf` or `tsc --build` with proper
incremental cleaning); make removal-guard tests assert *git-tracked* absence,
not disk; and have the test runner enumerate from source, not a `dist` glob.
Together S17+S18 mean the gate's fresh-worktree environment both false-fails
(S17) and hides real dev-machine breakage (S18) — the gate and a real checkout
disagree in both directions.

### S19 — new command's describe spec exists but isn't in the manifest; completeness test missed it
epic-005 added `loom publish`: registered in `index.ts` and exporting a valid
`spec` (`publish.ts:47`, `name: 'publish'`), yet `loom describe publish` returns
"Unknown command" — because `describe/registry.ts` `collectSpecs()` was never
updated to include it (no `publish` reference there; the collection is a
hand-maintained import list). epic-004's `describeCompleteness` test passed
regardless, so it does NOT enforce "every registered command appears in the
manifest" — it apparently enumerates `collectSpecs()` (which omits publish)
rather than the live Commander registry, making the check circular (same S13
"enumerate the authoritative source, not the derived list" lesson). **Fixes:**
(1) auto-discover specs from `commands/*.ts` (or wire publish in) so a new
command can't be silently omitted; (2) make `describeCompleteness` enumerate
the LIVE `program` registry and assert each registered command resolves in the
manifest. Functional impact is minor (the command works; it's just missing from
`loom describe`), so not a release blocker — fold the fix into a later epic.

### S20 — release/build hygiene papercuts (found dogfooding the new flow)
- `loom release <v>` bumps the workspace `package.json` versions and commits
  ONLY `package.json packages/*/package.json` (`release.ts:55`) — it does NOT
  run `npm install` or stage `package-lock.json`, so after a release the lock
  drifts (main ends up `package.json=5.3.0`, `lock=5.2.0`). Benign for the
  worktree flow (loom never npm-installs there) but a real inconsistency. Fix:
  run `npm install --package-lock-only` after the bump and stage the lockfile.
- A clean `rm -rf dist && npm run build` (bare `tsc`) does NOT set the exec bit
  on `packages/loom-cli/dist/index.js`, so the linked global `loom` becomes
  `permission denied` until a manual `chmod +x`. Fix: a `postbuild` `chmod +x`
  in loom-cli (or a build step that preserves the shebang + mode).

### S22 — a worker wrote a doc at the same path as the operator's untracked notes (collision)
A story-016-004/005 worker created `docs/dogfooding/mcp-removal-notes.md` (a
legitimate MCP-removal *migration doc*) at the exact path of the operator's
untracked running improvement log (this file). On `git pull` of the merge, git
refused: "untracked working tree files would be overwritten by merge". The two
files are unrelated content sharing a path. Recovered by renaming the operator
log to `improvement-log.md` so both coexist. **Suggestions:** (1) the dogfood
log should live at a name workers won't pick (done — `improvement-log.md`); (2)
more broadly, `loom run`/finalize merging into a working tree should detect when
a story's new tracked file would clobber an *untracked* operator file and warn/
stash rather than leaving the operator to hit a raw git merge abort. Low
severity (an operator-only convention collision), but it did interrupt the
release flow.

### S23 — recurring worker stream-stalls; likely tied to a mid-run session re-login
Three worker stalls this loop (story-005-004, 016-005, 017-001 — the last
TWICE), all the same signature: the worker streams real productive output, then
the claude-code stream goes silent and the 12-min no-output stall kills it; work
is checkpoint-committed and resume continues. Not a logic defect — 017-001 was
writing a sound `redactSecrets()` util when it hung. **Leading hypothesis:** the
operator session was re-authenticated mid-loop (`/login`), and claude-code
workers fall back to the operator's `claude login` session (worker_auth), so a
session-token refresh can hang the in-flight worker streams they depend on. The
stalls cluster around/after that event. **Suggestions:** (1) the stall path
should distinguish "stream died" (EOF/connection-closed) from "worker silent but
alive" — a closed stream should fail fast and auto-resume rather than wait the
full 12-min window; (2) detect a session-auth refresh and proactively checkpoint
+ re-dispatch live workers; (3) consider lowering max_concurrent (10→~4) if
stalls correlate with simultaneous stream count (here 017-001 ran ~solo, so
concurrency is NOT the trigger this time — points at the session lead).

### S24 — epic-017 broke the planner; the gate couldn't catch it (real-CLI-only constraint, mocked in tests)
After adopting v5.9.0 (epic-017 planning observability), EVERY `loom epic`
failed: `claude CLI exited 1: Error: When using --print, --output-format=
stream-json requires --verbose`. epic-017 switched the planner's
`ClaudeCliClient` streaming path to `--output-format stream-json` (to capture
persona output) but omitted `--verbose`, which the real `claude` binary
REQUIRES with that combo. The integration gate passed green because the tests
mock the CLI and don't enforce that constraint — a class of bug the gate
structurally cannot catch (it never spawns the real binary; "Not tested: a live
... CLI" is even called out in PR bodies). Hand-fixed (bootstrap problem: can't
dogfood a fix for the planner that does the dogfooding) by adding `--verbose`
at `ClaudeCliClient.ts:112`, mirroring the worker path (`ClaudeCodeWorker.ts:42`)
which already had it. **Suggestions:** (1) a regression test asserting the
streaming args include `--verbose` whenever `stream-json` is used (added with
the fix); (2) a thin smoke test that actually spawns `claude --help`/a trivial
real invocation in CI where a session exists, to catch real-CLI flag-contract
breaks the mocks miss; (3) treat "changed a real-CLI arg list" as a risky-path
that demands a live check. This is the most severe regression of the loop — a
green epic that bricked planning entirely.

### S25 — status board renders story duration as live elapsed-since-dispatch, never frozen at completion
The per-story duration in `loom status` shows `now - started_at` computed at
render time, so a DONE story's displayed duration keeps growing forever. Proof:
story-002-001's real `started_at→updated_at` is **11.1 min** (DB), but after ~25h
of session wall-clock the board shows it as "25h 9m"; the same finished story
read "24m 40s" → "51m" → "2h 54m" → "9h 27m" → "25h 9m" across the session. This
badly misleads any read of throughput/cost-per-story on a long-lived session (it
makes ~11-min epics look like 24h epics). **Fix:** freeze a terminal story's
duration at `completed_at - started_at` and only show live elapsed for
in-flight stories. Pairs with S9/S13/S19/S24 — another observability surface
that reports something other than the truth.

### S26 — loom weave P0 shipped half-wired: the command never calls the classifier (integration gap, green gate)
First live `loom weave` invocation (epic-021) recorded `verdict: no verdict`.
Root cause: `weave.ts` `runWeave` is a pure pass-through to `runEpic` that
NEVER invokes the classifier — it destructures the `_classifyIntake` seam and
discards it (`weave.ts:34`), with self-contradictory comments saying the wiring
is "reserved for story-020-001" (the very story meant to do it). Stories
020-002/003/004/006 built the `IntakeClassifier`, the `intake_verdict` column +
v23 migration, the status/web surfacing, and the describe spec — all green —
but no story connected them into a working classify→persist path. Every test
passed because each slice was unit-tested in isolation via injected seams; even
the observe-only invariant test (020-005) passes TRIVIALLY because the
classifier never runs. The integration gate (`npm test`) can't catch this —
there is no end-to-end test that runs real `loom weave` and asserts a verdict
is persisted. **This is the same failure family as S17/S24:** a green epic that
doesn't actually work end-to-end. **Fix:** wire `runWeave` to construct the
triage LLM client, call the classifier, and persist the verdict best-effort
(observe-only) against the created epic row — AND add an end-to-end test that
runs `loom weave` and asserts a non-null persisted verdict. **Process lesson:**
when an epic's value is an end-to-end behavior, one story must own the
end-to-end wiring + an e2e test; slicing purely by layer with seam-stubs lets
every piece pass while the whole stays disconnected.

### S27 — intake classifier's 20s timeout is far too short for the claude-cli (subprocess) backend
The classifier hardcodes `timeoutMs: 20_000`, but a single Haiku call via the
claude-cli backend spawns a `claude` subprocess whose cold-start + completion
measured **~98s** in dogfooding. So in the default session-based backend EVERY
classifier call times out. **Fix:** make the timeout backend-aware (subprocess
backends need a much higher bound than an API call) or default it generously
(60–120s) and document it; one cheap call should not be capped at 20s when the
real latency is ~100s.

### S28 — classifier returns prose, not JSON, via claude-cli/Haiku → invalid_output
With a longer timeout the call completes but returns `invalid_output`: Haiku
replied conversationally ("I need you...") rather than the JSON verdict, so
`JSON.parse(response.text)` fails. The classify prompt isn't robust to the
session backend — `--append-system-prompt` + a bare brief doesn't reliably
force JSON-only output from Haiku. **Fix:** harden the output path — extract
JSON from fenced/prose responses, use a more forceful instruction and/or an
assistant prefill (`{`), and consider tool/JSON-mode where the backend supports
it. The classifier was only ever unit-tested against a mock LLM, so it never
exercised the real backend's conversational behavior (same blind spot family as
S24: real-backend behavior the mocks don't reproduce).

### S29 — DANGEROUS: the go/no-go gate reports PROCEED when 100% of classifications failed (vacuous pass)
The eval printed `Overall: PROCEED — 0 dangerous confusions across 22 cases`
while every single classifier call failed (`type 0/0`, `size 0/0`, 22 judge
calls inconclusive). "0 dangerous confusions" is vacuously true when there are
ZERO classifications to confuse — so the gate that's supposed to decide whether
the classifier is trustworthy enough for P1 said "go" on a 100% failure rate.
This is the most dangerous bug of the weave work: a go/no-go that **fails open**.
**Fix:** the gate must **fail closed** — DO NOT PROCEED (or INCONCLUSIVE) when
the classifier-failure rate or judge-inconclusive rate exceeds a low threshold,
and require a minimum number of *scored* cases before PROCEED is even possible.
Also: the report silently excludes failures — it must surface failure reasons
(timeout/invalid_output/llm_error counts) so a 100%-failure run is glaring, not
hidden behind a green "PROCEED". (Same vacuous-green family as S13/S19.)

### EVAL RESULT (epic-022 re-run, the real numbers) — classifier works, gate honestly says DO_NOT_PROCEED
After the S27/S28 fixes the classifier runs cleanly: **22/22 scored, 0 timeout /
0 invalid_output / 0 llm_error**, 0 inconclusive judge calls. Accuracy:
**type 21/22 (95%)**, **size 18/22 (82%)**. Size confusion matrix shows a
**systematic under-sizing bias: 4 epic→story, 0 story→epic** — exactly the
asymmetric risk the design doc named. The (now fail-closed, S29-fixed) gate
correctly returns **DO_NOT_PROCEED** — "4 epic→story under-sizing confusions."
Crucially, judge-vs-human agreement (19/22) is no better than judge-vs-classifier
(19/22), and on epic-008/epic-018 the Opus judge SIDES WITH THE CLASSIFIER
against the human label — concrete proof of the "planner isn't ground truth"
thesis: some "under-sizing errors" are bad labels inherited from loom's own
over-decomposition. So the true error rate is better than 82% looks, and the
fix is two-pronged: (a) bias the classifier conservative / default-to-richer on
low confidence (already in the design), and (b) clean the size labels (anchor on
human judgment, not raw historical story counts). This is a genuinely useful
go/no-go: do NOT wire P1 yet; tighten the size axis first.

### S30 — eval report (.loom/eval/) was committed to the epic branch; should be gitignored
story-022-005 committed `.loom/eval/intake-report.{md,json}` into the epic
branch. The eval output is machine-local developer-harness runtime state (like
`.loom/signals/`, `.loom/logs/`) and must not be tracked. **Fix:** add
`.loom/eval/` to `.gitignore`; the harness writes there at runtime.

### S31 — S26 wiring slipped a THIRD time; the e2e test now correctly catches it (real red gate)
epic-022's e2e test (`weave-intake.test.ts`) — the guard S26 prescribed — is
RED: "DB sink: intake_verdict must be non-null" and "classifier must have been
called" both fail, so `loom weave` still does not produce a live verdict. The
wiring LOOKS correct on inspection (epic.ts initializes `llm` before the intake
block; opts.intake is set; the mock responder routes classifier calls) yet the
verdict comes back null at runtime — a subtle runtime bug needing
instrument-and-run, not inspection. Notable: this is the THIRD slip of the same
weave→classify→persist wiring (unwired in P0; partial+still-broken here). The
integration gate now correctly BLOCKS (a real failure, not a false positive —
the gate-trust fixes from epic-007/008 are holding). PR #59 NOT merged.
**Process lesson reinforced (S26):** end-to-end wiring needs one owning story
that builds AND greens the e2e test on its own branch; here the e2e test landed
red into the integrated tree. The eval-harness fixes (S27/S28/S29) in the same
PR are good and proven, but are bundled with the broken wiring.

**DIAGNOSIS (root cause of the red e2e test):** NOT a wiring-logic defect — a
**DB module-singleton artifact**. `openDatabase` (`Database.ts:207`) caches a
process-global `_db` (`if (_db) return _db`). The weave pipeline runs to
completion (so classify+persist execute), but the test writes through the
singleton handle and then reads via a FRESH `new Database(...readonly)` after a
`resetDatabaseForTest()`; the write landed on a singleton pointed at a different
path than the test's read, so both the DB-column and audit-log sinks read null.
In real single-process `loom weave` usage there is one consistent `_db`, so the
wiring works. This is the known module-DB-singleton limitation surfacing in an
e2e test. **The superseding epic must:** (1) write a singleton-robust e2e test
(assert through the same `openDatabase` handle the write used, or reset+reopen
at the exact loomDir before reading), and (2) note this is also a latent
real-world hazard for any second in-process reader. S31 reclassified: test-
harness/DB-singleton, not wiring logic.

### S32 — module DB-singleton makes end-to-end DB-assertion tests fragile (latent real hazard too)
Generalizes S31. `openDatabase`'s process-global `_db` cache means any test (or
any second in-process consumer) that opens the DB a different way sees a
different/empty view unless the singleton is carefully reset to the exact path.
This already cost an epic a red gate (epic-022). **Fix direction:** make
`openDatabase` path-keyed (cache per resolved db path) rather than a single
global, or inject the db handle explicitly into runEpic/runWeave instead of
resolving a global; either removes the whole class of cross-handle test
fragility and the multi-repo-in-one-process hazard noted in known-limitations.

### S33 — sharpening the classifier prompt REGRESSED JSON reliability (real, confirmed by 2 runs)
epic-023's conservative-bias + sharpened epic-vs-story criteria (story-023-002)
improved sizing (epic→story under-sizing 4→2) but REGRESSED the cheap model's
output-format adherence. epic-022 demonstrated 0 failures / 22 scored; epic-023
now fails ~50%: worker run 10/22 failures, my re-run 14/22 (12 invalid_output +
2 timeout). Two independent runs ⇒ real regression, not flakiness. The honest
fail-closed gate (S29) correctly returns inconclusive / DO_NOT_PROCEED. **The
deeper signal:** Haiku (the cheap triage model) struggles to BOTH reason
carefully about sizing AND emit clean JSON in one call — a more elaborate
prompt buys sizing accuracy at the cost of format reliability. **Fix options:**
(a) force the format independent of reasoning — assistant prefill `{`, JSON-mode
where the backend supports it, "output ONLY the JSON object" + robust recovery
— keeping the sharp criteria; (b) if (a) can't get both, the cheap-single-call
constraint may be the real limit → test a slightly stronger triage model (cost
tradeoff) or a two-step reason-then-format (2 calls). **Strategic note:** this
is the 4th classifier epic (P0→P0.5→022→023); each revealed a real next
constraint (good observe-first behavior), but it's a checkpoint worth a
cost-discipline decision before fix #5.

### S34 — model bump makes it WORSE: the regression is prompt/format design, not capability
Tested the "bump Haiku→Sonnet" hypothesis directly via the eval harness
(`LOOM_EVAL_MODEL=claude-sonnet-4-6`). Result: Sonnet failed **21/22**, all
`invalid_output`, 0 timeout — strictly worse than Haiku's ~14/22. A MORE capable
model produced LESS clean JSON, which decisively rules out a capability gap and
pins the root cause on epic-023's prompt: its "reason carefully about sizing"
instruction induces the model to emit reasoning-PROSE, and the more thorough the
model the more prose it wraps the JSON in, defeating the extraction. epic-022's
simpler prompt got 22/22 clean; epic-023's elaborate prompt broke it. **Implication:**
do NOT bump the model (worse + costlier). The fix is output discipline — assistant
prefill `{`, strict "respond with ONLY the JSON object", and encode the sharpened
sizing criteria as terse rules rather than verbose chain-of-thought, so format
survives. (My prior prediction that Sonnet would help was wrong; the cheap
empirical test caught it before any model-default change — observe-first paying
off again.)

### S35 — THE REAL root cause: claude-cli runs an AGENT, so briefs get executed, not classified
Stopped theorizing and printed the raw classifier output. For "Add a dark mode
toggle to the settings page" the model replied: *"I'm ready to add the dark mode
toggle to the loom web dashboard. The changes I'm making are: 1. CSS Variables…"*
— i.e. it's CODING the brief, not classifying it. Cause: the `claude-cli`
backend invokes Claude Code with **`--append-system-prompt`**, which APPENDS to
Claude Code's built-in agentic-coding system prompt rather than replacing it. So
the classifier's "emit a JSON verdict" instruction rides on top of a coding
agent running in the loom repo (it even names "the loom web dashboard" — picking
up project context). For any actionable brief the agent behavior dominates →
prose plan, not JSON. This explains EVERYTHING the saga chased fruitlessly:
- model bump made it WORSE (S34) — a better *coder* engages harder;
- prefill/format fixes (S28/S33) couldn't help — the model isn't trying to emit
  JSON at all, it's doing the task;
- it's intermittent — abstract/meta briefs sometimes get classified, actionable
  ones get coded.
**This is architectural:** a pure structured-classification call fights the
agentic backend loom is built on. The classifier was unit-tested only against a
mock LLM, so it never met the real agent's task-execution behavior — the deepest
instance of the S24 "mocks don't reproduce the real backend" family.
**Fix directions (a strategic call):** (a) give the classifier a NON-agentic
completion path — a claude-cli invocation that REPLACES the system prompt /
disables tools/agentic mode (if the CLI supports it), or runs from a neutral cwd
with no CLAUDE.md so it isn't primed as a loom coder; (b) fold sizing into the
PLANNER's first persona (the Analyst already reads the brief and produces
structured output via claude-cli successfully) instead of a standalone
pre-planning call — though that weakens the "cheap pre-planning sizing" goal;
(c) accept the classifier needs an API-style completion, in tension with the
session-only design. Do NOT keep tuning prompt/model/format — that layer is not
the problem.

### S36 — planner over-decomposed a cohesive single-file change into deterministically-conflicting stories
epic-024 (web dashboard focus) split into 7 stories that ALL edit the same
nav/tab-registration region of `packages/loom-web/public/index.html` (remove
autonomy tab, hide fleet/inbox, read-only buttons, traces/audit sections, skills
view). Result after two runs: 2 done, 5 blocked — 024-002 and 024-003 each
completed their work but BLOCKED integrating on the same merge conflict; the
bounded integrator (on) cannot resolve same-region edits, and the conflicts
cascade to block the dependents. This is deterministic, so re-running doesn't
help. The shared-contract file-ownership map is supposed to prevent exactly
this, but it can't when the work genuinely requires many edits to one file's
one region — i.e. the work is NOT parallelizable. **Findings:** (1) the planner
should detect "cohesive single-file change" and emit ONE story (or serialize
hard-dependent same-file stories) rather than N parallel ones; (2) the
file-ownership contract should hard-assign a hotspot file (index.html) to a
single story and make others depend on it, not edit it in parallel; (3) loom
needs a story-level "this conflicts, serialize it" signal. **Recovery:**
re-approach the web cleanup as a SINGLE cohesive story (+ a separate story only
for the genuinely-separable new skills view file), after the classifier fix
lands — not as 7 parallel index.html editors.

### S37 — non-agentic fix works for REAL briefs; residual eval failures are fragment-brief artifacts + Haiku variance
v5.14.0's non-agentic mode is verified: realistic task briefs classify cleanly
(7/7 across two clean direct tests; sensible story/epic sizing). But the clean
22-case eval still shows 11 `invalid_output` failures. Diagnosed by running
`classifyIntake` on the actual fixture briefs: the failures concentrate on
TERSE FRAGMENT briefs phrased as "Title: component, component, component"
(loom's own architecture descriptions — "Core Engine: loom init, policy engine,
SQLite…", "MCP Server: loom-mcp with 7 tools…") which read as lists, not tasks,
so Haiku sometimes answers in prose. Clean task sentences pass. So the ~50% eval
failure is substantially **eval-set quality** (artificial fragment briefs that
aren't representative of real intake) plus some Haiku JSON-adherence variance —
NOT the classifier failing on real briefs. **Cheap path to "reliable enough":**
(1) retry-once on `invalid_output` (if Haiku fails ~30-40% independently, one
retry drops it to ~10-15%, two to ~5%); (2) drop/rewrite the fragment briefs in
the eval set to representative task briefs. Both small, not a rabbit hole.
**Meta:** this is the 6th classifier epic; each found a real issue and the core
architectural bug (S35) is FIXED + shipped. Worth a conscious cost-discipline
decision before more polish.

### S38 — CLASSIFIER THREAD RESOLVED: reliable now, honest verdict = DO NOT PROCEED to P1 (under-sizing ceiling)
Final clean eval after non-agentic mode (S35/v5.14.0) + retry-once + eval-set
cleanup (epic-026/v5.15.0): **6/22 failures** (~27%, mostly Haiku variance —
down from ~50-95%), **type 14/16 (88%)**, **size 13/16 (81%)** with **3
epic→story under-sizing confusions** ⇒ gate honestly returns **DO_NOT_PROCEED**
for a REAL quality reason, not a plumbing artifact. This is the trustworthy
go/no-go the whole observe-first effort was built to produce.
**The architectural learning (the real payoff):** a cheap, single-call
classifier reading a ONE-PARAGRAPH brief is reliable and decent on TYPE (88%)
but has an **under-sizing ceiling on SIZE** — it can't reliably detect that
something is bigger than it looks (hidden scope), and confident under-sizing
survives the conservative tiebreak. This empirically confirms the maintainer's
earlier instinct that a single paragraph may not carry enough scope signal. So:
**keep the classifier OBSERVE-ONLY** (it's shipped, reliable, recording verdicts
as useful telemetry) and do NOT advance to P1 auto-routing on size — the eval
says it's not safe, and that "no" prevented a costly mistake (auto-routing an
under-sizer causes mid-sprint scope explosions). **STOP polishing here**
(6 classifier epics; honest answer obtained). Future P1 would need a stronger
scope signal than one paragraph (e.g. fold sizing into the Analyst persona who
reads more, or require more brief detail before sizing-routing).

### S39 — `loom revert` fails when an integration worktree still holds the epic branch
`loom revert epic-024` crashed with `cannot delete branch 'epic/epic-024' used
by worktree at .loom/integration/epic-024` — the EpicReverter runs `git branch
-D epic/<id>` without first removing the rolling-integration worktree that has
that branch checked out. So any epic with a lingering integration worktree
(common for a stopped/blocked epic that never finalized) cannot be reverted
without manual `git worktree remove` first. **Fix:** EpicReverter should
`git worktree remove .loom/integration/<id>` (and prune) before deleting
the epic branch, mirroring how it already cleans story worktrees.
**Side note:** the policy guard blocks `git worktree remove --force` because
`--force` is in `git.forbidden_flags` — that rule targets `push --force`/`reset
--hard` but over-broadly catches benign `worktree remove --force` too; the
forbidden-flag check could be scoped to the subcommands where force is dangerous.

### S40 — cross-package contract change blindness (worker can't see consumers in other packages)
epic-036 made `blocking_gaps` a REQUIRED field on the `BriefRefinement` type in
loom-core; the worker dutifully updated loom-core's constructors, but the
`propose.test.ts` stubs in loom-cli AND loom-web (other packages) broke the
build — the worker is scoped to one package and structurally cannot see
downstream consumers of a core type/contract. The per-epic integration gate
caught it (good), but recovery needed cross-package + semantic reasoning the
worker can't do. **Pattern:** any loom-core contract change (type field, enum,
signature) risks breaking loom-cli/loom-web, invisibly to the worker. **Fixes:**
prefer additive/optional fields for back-compat; give the worker (or a
pre-integration check) cross-package type-awareness; or treat core-type changes
as a flagged class needing a consumer sweep. Related: epic-036 also coupled a
readiness floor to the eval band, silently changing gate boundary semantics —
another effect a single-package worker couldn't foresee.

### S41 — central-registry (barrel) files are a parallel-merge conflict magnet
Three gate-eval epics (brief-quality, classifier-experiment, skill-judge) hit
the same integration merge conflict: two stories each add a new eval module and
each appends its export to the shared `packages/loom-core/src/eval/index.ts`
**barrel**, colliding on that one file. epic-028's conflict-aware serialization
misses it because the barrel edit is INCIDENTAL (not a declared owned path) —
declared-paths-only detection can't see it. **Root cause is architectural, not
an agent error:** the worker correctly follows the codebase's barrel convention
(new module → export from index.ts); a barrel is a central registry every new
module must touch, so parallel isolated workers collide on it by construction.
Generalizes to any central registry (route table, DI registration, big enum,
`mod.rs`/`__init__.py`). **Insight for loom's mission:** codebases are
"parallel-agent-friendly" to the degree they avoid central chokepoints
(per-module sub-barrels, auto-discovery, convention-over-registration); loom
could DETECT central-registry files and warn or auto-serialize stories that
touch one. **Fix for our repo:** give each eval consumer its own sub-barrel so
two consumers never edit the same index.ts (ends this recurring tax). Do the
sub-barrel refactor BEFORE the remaining gate evals (4-6) to avoid 3 more
collisions. **RESOLVED (epic-040, v5.29.0):** intake eval modules moved to
`eval/intake/` with their own sub-barrel, skill-judge got its own `index.ts`,
the top barrel thinned to re-export only per-consumer public surfaces, and a new
`evalSurface.test.ts` pins the public export set so a future refactor can't
silently drop a symbol. Consumers now wire internally via direct imports.

## Run log

- 2026-06-17 — scoped the removal (narrow: server surface only), created this
  file, checking CLI readiness before `loom epic`. Doctor green (cursor-agent
  absent but unused on the claude-code backend). Expanded to a two-epic
  mission with operator-delegated plan approval.
- 2026-06-17 — planner split the brief into **epic-002 (CLI parity port)** +
  **epic-003 (remove MCP server)**. Ran epic-002: 6/6 stories done, integration
  gate green (`npm test` 43s), integrator auto-resolved the index.ts conflict.
  Merged PR #23. Cut **v4.3.0** (records-only, release-PR #24 + tag) and
  rebuilt/relinked — global `loom` now 4.3.0 with `pull-guidance` / `project` /
  `stop --epic` / `--reason` / `--project` / propose flags all live. Next:
  epic-003.
- 2026-06-17 — ran epic-003: 6/6 stories done, gate green, BUT finalize push
  failed non-ff (S12) and loom marked the epic `failed` despite complete work.
  Recovered by hand: pushed the gate-green epic branch to a fresh ref → PR #25
  → merged. Found the docs scrub incomplete (S13) — fixed the live stale refs
  by hand; logged dead `loomServerEntry` plumbing + a historical runbook
  section as follow-ups (S14). Cut **v5.0.0** (BREAKING, release-PR #26 + tag),
  rebuilt/relinked: global `loom` now 5.0.0, `loom serve` gone
  (`unknown command`), doctor green. **MCP removal mission COMPLETE.** Open
  loose ends: loom DB still shows epic-003 `failed` (cosmetic; no operator
  command corrects a finalize-push-failed-but-merged epic — S12); stale remote
  `epic/epic-003` branch left in place (delete was denied as a destructive
  action outside my authorization). Next: epic for LLM-parseable CLI command
  descriptions.
- 2026-06-17 — ran epic-004 (CLI self-description): 6/6 stories done, gate green
  (`npm test` 38s), epic self-finalized to `done` cleanly (main held steady →
  no S12 divergence). Merged PR #27. Cut **v5.1.0** (release-PR #28 + tag),
  rebuilt/relinked. Dogfood-verified live: `loom describe status` emits a
  schema-valid description (whenToUse, typed options, --json shape, examples,
  exit codes, errors, command relationships) and `loom --version` → 5.1.0.
  **Both maintainer-requested epics COMPLETE.** Open design thread (S15/S16):
  durable worker logs — recommendation is files under `.loom/logs/<agent>.log`
  + DB pointer/tail, not SQLite BLOBs (no cheap append) nor system tmp (OS may
  clear it); not yet decided/built.
