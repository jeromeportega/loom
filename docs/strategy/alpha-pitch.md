# Loom — alpha-readiness pitch

**Audience:** Engineering leadership (VP / Director). Internal use.

**Ask:** sponsorship to take loom from validated single-developer alpha to
team-supported beta. Three concrete asks below.

---

## What loom is

Loom is an open-source, self-learning, autonomous agentic engineering
system. The developer writes a one-paragraph brief, approves the plan, and
parallel agents deliver the epic — planning, implementation, tests, and
PRs — while structural guardrails and a human review gate keep the system
trustworthy. It orchestrates Claude Code and Cursor (via their CLIs and
MCP); no API metering, no external orchestration service.

Two human touchpoints: the brief and the approval. Everything else runs
unattended.

## What's validated

Loom has been engineered against an evaluation methodology, not vibes.
The current evidence:

- **50% resolution rate on SWE-bench Lite** (Run 8, holds through
  holdout). For context: the SWE-bench Lite leaderboard's solo-agent
  baseline submissions cluster well below this for non-frontier-lab
  entrants. The methodology used to produce the number — tuning vs.
  holdout discipline, no overfit, three promotion gates — is documented
  in `docs/testing/bench-methodology.md`.
- **Reproducible bench tooling.** `loom-bench swe-bench-lite`,
  `loom-bench classify`, `loom-bench compare`, `loom-bench variance`
  give us mechanically reproducible signal across runs — not narrated
  prose. Failure-mode classification is automatic, not subjective.
- **Real engineering throughput.** Loom has delivered 19 of its own
  epics end-to-end (planning → workers → PR). The repository's history
  of loom-built features is itself the validation surface.
- **Structural safety.** A policy engine blocks destructive commands at
  the OS level (not via LLM instruction). Git worktree isolation means
  agents physically cannot touch the main branch. Every action is
  audit-logged to SQLite.
- **Test discipline.** ~500 unit tests across the four packages, green
  on `main`. The test surface specifically covers orchestration,
  guardrails, state — the parts that have to be right.

## Why this matters now

The cost calculus for AI-assisted engineering is shifting from
*per-keystroke faster* to *per-epic delegated*. The teams that figure
out how to delegate units of work to AI agents — safely, auditably,
without ceding judgment — outpace the teams using AI only for
autocomplete.

Loom is the substrate for the delegation pattern, built around
real enterprise constraints:

- **Session-based authentication.** Uses the Claude / Cursor logins
  developers already have. Zero metered-token billing on the default
  path.
- **Approved-tools only.** No pi.dev, no Anthropic API direct, no
  third-party orchestration SaaS. MCP server is the primary interface;
  Claude Code and Cursor are the agent clients.
- **Local-first.** SQLite, git worktrees, the developer's existing
  laptop. No new cloud surface required to operate.

The strategic posture is "trust the frontier model labs to improve the
model, own the orchestration substrate where enterprise constraints
matter" — see `docs/strategy/positioning.md` for the long form.

## What we don't yet have

- **Eval at scale.** The 50% number is on the 50-task tuning slice;
  we hold a 50-task holdout, and a 200-task reserve for a final
  external-comparison measurement. Running the full set on every
  intervention is impractical on a single laptop (~8 hours per
  pass at ~10 tasks/hour). Slow eval feedback is the biggest
  blocker to intervention velocity.
- **Team visibility.** Loom runs today live in per-machine SQLite —
  two engineers running loom on different laptops are invisible to
  each other. Engineering leadership has no dashboard for "how is
  loom actually being used across the team."
- **Roadmap capacity.** This has been single-developer work. The
  open-issue backlog (10 substantive items, plus the alpha-readiness
  work surfaced in this session) is multiple-engineer-quarters at the
  current cadence.

---

## The three asks

### 1. Bedrock for bench-at-scale

**What:** AWS Bedrock access sufficient to run the full SWE-bench Lite
suite (300 tasks) per intervention candidate, on a cadence.

**Why:** The methodology gates require a tuning-set measurement, a
holdout measurement, and (for big interventions) a full-set measurement.
At single-laptop speed, that's days of wall-clock per probe. The
intervention ladder in `docs/testing/runbook.md#interventions-toward-70`
has roughly a dozen probes queued; without scale, each one is a
week-long block.

**Estimate:** ballpark $X / month at current model pricing for the
end-to-end suite cadence (concrete figure once we have a single
calibration pass against Bedrock pricing). One-time onboarding work
to wire loom's backend abstraction to Bedrock as a worker target.

**What this unlocks:** intervention velocity 5–10× current. Lets us
hit the 70%-trajectory target the methodology is designed to detect.

### 2. Cloud Postgres for run visibility (issue #19)

**What:** managed Postgres instance + the LoomArchive service (already
spec'd in issue #19) that mirrors local SQLite state into the shared DB,
plus a DX webhook adapter so loom metrics flow into the engineering
productivity dashboards the team already reads.

**Why:** Loom is a team product, not a personal tool. Today, every run
is invisible to anyone but the operator who launched it. For engineering
leadership to trust loom as a productivity multiplier, the metrics have
to land where they already read metrics. The data layer is design-ready
(see #19's architecture sketch).

**Estimate:** managed Postgres (Cloud SQL or RDS) + ~3 engineer-weeks
for the LoomArchive service + DX adapter + scrubbing pass.

**What this unlocks:** shared run visibility, the foundation for
"loom across the team" stories, and the DX-platform integration that
makes loom's velocity impact legible to org-level reporting.

### 3. Engineering headcount

**What:** 2 engineers allocated to loom for two quarters minimum.
Ideally one with planner/eval focus (drives the intervention ladder,
owns the bench methodology) and one with substrate focus (owns the
release pipeline, the team-product features in #15 / #16, the
operator-experience work).

**Why:** The remaining work is real engineering, not solo-pace
evenings. The cross-repo planning + eval work alone (issues #16 + #17)
is a half-quarter for a focused engineer. The cloud-skill loop has
landed but #18's follow-ups (auth refinement, signed tags, federation
once warranted) are real. Multi-repo web UI federation (#15) is
substrate work.

**What this unlocks:** the roadmap actually ships against a calendar
instead of being gated on one person's bandwidth.

---

## First commitments — what we promise back

If the asks land:

1. **Within 30 days:** the full SWE-bench Lite suite (300 tasks) runs
   end-to-end against the Bedrock-backed configuration. Result published
   to the DX dashboard.
2. **Within 60 days:** the LoomArchive service ships and the team's
   loom runs appear in a shared dashboard. The first multi-engineer
   evaluation of loom against real product work begins.
3. **Within 90 days:** the intervention ladder produces a measurable
   delta — either we move the SWE-bench Lite number, or we publish a
   *why we couldn't* writeup grounded in the bench-variance and
   classification tooling. Either outcome is signal.

The asks are scoped so a No or a Yes-but-smaller is actionable. The
single most-leveraged dollar is Bedrock — it unblocks the rest of the
work even without the other two asks.
