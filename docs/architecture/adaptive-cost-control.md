# Adaptive cost control (design — for review, not yet implemented)

## Why

Loom's strength is **guaranteed quality output** for unattended autonomy. Its
worst trait is **speed**: it runs the same expensive gauntlet on a one-line typo
and a 600-line refactor. Every expensive step is a *global static* policy flag,
not a per-story decision:

| Step | Cost | Gated by today |
|---|---|---|
| `phases:on` verify spawn | a 2nd full agent spawn/story | global flag |
| Review Forge | 3 reviewer LLM calls × N passes | global flag + `review_max_passes` |
| skill generation | 1 LLM call / successful story | `on`/`off`/`sampled` |

**Principle:** spend expensive steps only where a *signal* says they're needed,
and **record the signals** so the calls can be audited and the policy improved.

**Ceiling rule (load-bearing):** adaptive logic may only *reduce* work within
what policy already allows — never exceed it. A user who sets `review_strategy:
block-and-revise` + `phases: on` has set the **maximum**; adaptive can downgrade
a low-risk story below that, but a strict operator's guarantees always hold.

## The three signals

1. **Triage (B0) — cheap, pre-dispatch.** One small LLM call (new
   `policy.agents.triage_model`, default `claude-haiku-4-5-*`) rates the story
   *before* the worker runs: `{ risk: low|medium|high, predicted_complexity:
   low|medium|high, rationale }`. Reuses the planner LLM plumbing (`modelFor`,
   `createLLMClient`). The planner's `estimated_complexity` is a prior; triage is
   a second, cheap opinion that can also read the story's acceptance criteria.

2. **Self-assessment (B1) — worker, post-work.** The worker ends its run with a
   single structured marker:
   `LOOM_SELF_ASSESSMENT {"confidence":"low|medium|high","complexity":"low|medium|high","note":"…"}`
   Parsed from the final assistant message in `ClaudeCodeWorker.parseStreamLine`
   (the assistant-text branch) and surfaced on the worker result. **Absent →
   `confidence:low`** (fail safe: review more, not less). This is the most
   informed signal — the worker just did the work.

3. **Cheap heuristics (free).** Computed from state, no LLM:
   - diff size (lines + files changed, via `git diff --stat` on the story branch)
   - first-try test result (did the worker's own verification pass first time?)
   - touched-risky-paths (changed files matching a configurable risky glob —
     auth, migrations, payment, etc.)

## Cost tier

Combine the signals into one per-story **tier**. Proposed default mapping
(tunable later; this is the decision I most want your eyes on):

| Tier | Trigger (all heuristics agree + …) | Reviewers | Verify phase | Skill-gen |
|---|---|---|---|---|
| **light** | self-conf=high AND triage-risk=low AND diff small AND tests green first try AND no risky paths | 1 (code-review only) | skip | skip |
| **standard** | anything not light or heavy | 2 (code-review + edge-case) | run | sampled |
| **heavy** | self-conf=low OR triage-risk=high OR risky paths touched OR large diff | 3 (full Forge) | run | run |

Every tier value is clamped by the ceiling rule: if policy says
`review_strategy: comment`, even **heavy** does not block-and-revise; if
`phases: off`, no tier adds a verify spawn.

**Master switch** `policy.agents.adaptive_cost` (`on`|`off`, propose default
`on`). `off` = today's behavior exactly (every enabled step runs every story).

## Review loop: until-complete + no-progress guard (B3 remainder)

With adaptive depth in place, "loop until complete" is now safe to add (it was
deferred from the `review_max_passes` PR because, without tier-based reduction,
looping-until-complete would run *more* passes):

- Continue while `triggers_revision` AND under `review_max_passes` (the cap
  already shipped; `null` will mean "until complete") AND **making progress**.
- "Complete" = a pass with no blocker/high finding.
- **No-progress guard:** if a pass's deduped finding-keys are identical to the
  previous pass, stop and mark `blocked` — the worker isn't converging. This
  replaces the fixed cap as the anti-infinite-loop safety net and is what makes
  an uncapped loop safe. Implemented in `runReviewLoop` (review/orchestrator.ts).
- `log()` whenever the cap or the guard halts review, so a truncated review is
  never silent.

## Signal ledger + epic-review readback (B6) — the self-correcting loop

If loom is going to *decide* which steps to skip, it must be auditable whether
those calls were right.

- **Persist per story:** triage rating, self-assessment, heuristics, the chosen
  tier, **which expensive steps ran vs were skipped**, and outcomes (review
  verdict, integration-gate result). Store as `audit_log` rows (CLAUDE.md #5)
  plus a human-readable `.loom/signals/<story-id>.md`.
- **EpicFinalizer readback:** the epic review gains a **"Build signal analysis"**
  section — per-story confidence/complexity/risk, steps taken, and **mismatches**
  (e.g. a story triaged `low-risk` that later failed the integration gate =
  miscalibration). Feeds the existing flywheel/lessons pipeline.
- Optional `loom signals <epic-id>` CLI to read the ledger directly.

## Quieter worker output (B4)

The repeated "BLOCKERS RESOLVED" is worker-emitted text, re-emitted per revise
pass and per assistant message. Three levers, landing with this system:
1. Fewer passes (tiering + the loop guard) → fewer repeats.
2. Revise-prompt hygiene (`renderFindingsForRevision` + `buildWorkerPrompt`
   revisionContext): ask for a concise structured completion, not a banner.
3. Suppress consecutive duplicate rendered lines in `makeEventPrinter`
   (run.ts) and identical back-to-back assistant `humanText` traces.

## New policy knobs (types.ts agents schema)

- `adaptive_cost: 'on' | 'off'` (default `on`)
- `triage_model: string` (default `claude-haiku-4-5-…`)
- `risky_paths: string[]` (globs; default a small built-in set, e.g.
  `**/auth/**`, `**/migrations/**`) — feeds the touched-risky-paths heuristic
- (already shipped) `review_max_passes` — `null` will gain "until complete" meaning

## Integration points (files)

- `types.ts` — knobs + a `StorySignals` type.
- New `orchestrator/triage.ts` — the triage LLM call + parse.
- `orchestrator/workerPrompt.ts` — emit the self-assessment marker.
- `orchestrator/ClaudeCodeWorker.ts` (+ Cursor) — parse the marker.
- `orchestrator/BaseCliWorker.ts` — compute heuristics, resolve the tier, gate
  the verify phase; thread tier into the review pass.
- `orchestrator/workerFactory.ts` — tier → reviewer set for the orchestrated pass.
- `review/orchestrator.ts` — until-complete + no-progress guard.
- `orchestrator/Supervisor.ts` — run triage at dispatch; gate skill-gen on tier.
- `orchestrator/EpicFinalizer.ts` — the "Build signal analysis" section.
- New signal-ledger store/util + `.loom/signals/` writer.
- both createWorker sites (`run.ts`, MCP `handlers.ts`) — pass the new policy.
- `docs/capabilities.md` — rows for the knobs + ledger + `loom signals`.

## Decisions (confirmed)

1. **`adaptive_cost` defaults to `on`** with conservative tiers. Behavior changes
   out of the box; the ledger makes the calls auditable.
2. **The lightest tier always keeps ≥1 reviewer** — no tier ever opens a PR with
   zero review. The saving is dropping to 1 reviewer + skipping the verify spawn,
   never skipping review entirely.
3. **A touched risky path forces the `heavy` tier**, overriding confidence/triage
   — a hard safety floor.
4. **Triage emits signals only.** The tier is computed *deterministically* from
   (triage, self-assessment, heuristics) — no LLM in the decision, fully
   auditable.
5. **Heuristics win on conflict.** If the worker self-reports `high` confidence
   but heuristics disagree (large diff, tests failed first try, risky paths), the
   tier is downgraded toward `heavy` — the worker doesn't get to talk loom out of
   reviewing risky-looking work.

## How it lands

One coherent PR (dead scaffolding helps no one): all signals + tiering + gating +
ledger + readback together, behind `adaptive_cost`. Review pass before merge.

## Test plan
- Unit: tier resolution from (triage, self-assessment, heuristics); ceiling rule
  (a strict policy flag caps the tier); no-progress guard halts an otherwise
  infinite loop; ledger persisted + summarized.
- Integration (after build): high-confidence/low-risk story takes the light path
  (1 reviewer, no verify spawn); low-confidence/risky story runs the full
  gauntlet; epic review shows the "Build signal analysis" section; a forced
  miscalibration is flagged.
