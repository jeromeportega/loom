# Intake classification & `loom weave`

**Status:** design of record (phased; P0 is the first epic). Owner decision
2026-06-18.

This document describes a richer **intake layer** for loom and the unified
`loom weave` command that will eventually replace `loom epic`. It is the
north star for a multi-phase rollout (P0–P4); each phase is delivered as its
own epic and need not land all at once.

---

## Problem

Loom has exactly **one front door** and **one path**:

```
loom epic "<brief>"  →  brief-quality gate  →  Analyst → PM → Architect  →  epic with N stories
```

Everything becomes an epic. That has two costs:

1. **Over-planning small work.** A one-line fix or a single bug still pays a
   full three-persona Opus planning pass and is forced into the epic/story
   shape. (Observed repeatedly while dogfooding: trivial changes consumed full
   planning runs.)
2. **An invisible, expensive, implicit classifier already exists.** The planner
   *already* decides scope — it silently split single briefs into 2–4 epics on
   several runs — but that decision is emergent, unpredictable, and only
   discovered *after* paying for a full Opus pass. There is no cheap, explicit,
   overridable sizing step.

## Vision: `loom weave`

A single intake command that takes any input — a typed brief, a bug report, or
an **imported** artifact (Jira/GitHub issue) — classifies it cheaply, sizes the
planning to match, and produces the right unit of work.

```
intake source: typed brief | bug report | imported issue/epic
  → classify (type + size + confidence)      ← cheap (Haiku, reuse triage_model)
  → normalize to a plan-seed                 ← imports only; preserve acceptance verbatim
  → type-aware quality gate                  ← rubric per type
  → right-sized planning                     ← bug: skip personas | story: light | epic: full | import: architect-enrich
  → execution                                ← unchanged
```

Most of the machinery already exists: the cheap `triage_model`, the
`resolveCostTier` signal infrastructure, the persona separation (so a *subset*
can run), and the `doc-distiller` "preserve every acceptance criterion verbatim"
discipline. This is largely **exposing and reconfiguring the intake stage**, not
building new subsystems.

## Classification model — two orthogonal axes

Do **not** conflate these:

- **Size** → 1 unit vs N units → decides **planning depth**.
- **Type** → feature / bug / chore → decides **worker prompt template** + **gate rubric**.

| Classification | Planning path |
|---|---|
| bug / single chore | skip Analyst+PM (maybe Architect too) → one worker, repro-first prompt |
| story | light: Architect tech-notes only, single story, no epic breakdown |
| epic | today's full Analyst → PM → Architect pipeline |

A "bug" is not a third size — structurally it is a one-story unit with a
repro-first prompt and "defect no longer reproduces + regression test" as
acceptance.

## Classifier proposes, user overrides

The classifier **proposes**; the human **overrides**, and the override is free
(`loom weave --as bug|story|epic`). Rationale:

- The human often knows scope better than one paragraph reveals.
- **Misclassification is asymmetric.** Under-sizing (an epic planned as one
  story) yields a thin unit that fails; over-sizing only wastes planning. So
  **bias conservative** and **default to the richer path on low confidence**
  (mirrors the existing "heuristics win on conflict, default to heavy" rule in
  the adaptive-cost tier resolver).
- Always **announce the decision** ("Classified as **story** — planning one
  unit. Override: `--as epic`.").

### Required coupling: a type-aware quality gate

A bug report is legitimately terse ("X crashes on Y"). Today's feature-PRD
rubric would reject it. The classifier's `type` output must select the gate's
scoring rubric, or valid bug reports get blocked. This is a required change, not
optional.

## Import path — normalize + enrich (not as-is, not full re-plan)

When a user imports an existing Jira/GitHub issue, the tension is **fidelity**
(honor what they wrote) vs **executability** (loom's workers need acceptance
criteria + a file-ownership contract + a dependency DAG + a test plan to run
well). A raw ticket has the *what*; it rarely has the *how*.

- **As-is** → underspecified units → more failures/conflicts. Loses what makes
  loom good.
- **Full re-plan** → loom reinvents the human's decomposition and discards
  intent.

**Resolution — the human did the PM's job; loom runs the Architect's job on top
of it:**

- Map the artifact into loom's schema: title → epic title; description → brief;
  **acceptance criteria preserved verbatim**; subtasks → candidate stories.
- Run a **reduced planner pass — Architect only** — to add the file-ownership
  contract, tech notes, dependency ordering, and test plan. Skip Analyst/PM:
  the human already supplied that layer.
- Record **provenance** (`source: jira/PROJ-123`) on the epic so the PR/audit
  trail links back.

Import and classify are the **same pipeline, different front doors** — an
imported bug routes to the bug path; an 8-subtask epic → an 8-story epic.

## Phased rollout

Iterate **observe-first**, exactly how the adaptive-cost signal ledger was
derisked (ship observe-only, measure, *then* gate). This touches loom's most
load-bearing seam (intake → planning), so each phase must be reversible and
measurable.

- **P0 — Observe-only classifier.** Add the cheap intake-triage call; it
  classifies and **only records** its verdict. Nothing changes; everything
  still full-plans. *(This phase is the most important — it proves the
  classifier is trustworthy before it decides anything.)*
- **P0.5 — Evaluation harness (go/no-go gate for Phase 1).** Run the
  evaluation harness (`scripts/eval-intake.mjs`) against the labeled fixture
  set to measure classifier accuracy and judge agreement. The resulting report
  (`.loom/eval/intake-report.md`) is the evidence basis for the Phase 1
  decision. Phase 1 does not land until the report shows the classifier clears
  the accuracy bar on both the `type` and `size` axes. See "Phase 0.5 scope"
  below.
- **P1 — Explicit fast paths, human-chosen.** `loom weave --as bug|story|epic`
  routes to skip/reduced planning. No auto-routing yet. Delivers the cheap-path
  value with zero classifier risk and builds+tests the reduced-planning paths.
- **P2 — Auto-route with override.** Wire P0's classifier to choose the P1 path;
  human override always wins; decision announced; default-to-richer on low
  confidence.
- **P3 — Import adapter (one source first).** `loom weave --import jira PROJ-123`
  → normalize → architect-enrich → a normal planned epic the human approves.
  GitHub issues second (Signal Scout already ingests them — prior art).
- **P4 — Provenance round-trip (optional).** Comment status back to the source
  system on completion.

### Command strategy

`loom weave` and `loom epic` stay **siblings during iteration**, so the
classifier can be built and measured in a vacuum while `loom epic` keeps core
usability. At the **very end** (after P2 is proven), `loom epic` is replaced by
`loom weave`.

## Phase 0 scope (the first epic)

- A cheap intake-triage call (Haiku via `triage_model`) over the brief that
  returns `{ type, size, confidence, rationale }`.
- Introduce `loom weave` as a sibling of `loom epic` that, in P0, behaves
  **identically** to `loom epic` (full planning) but **records the classifier
  verdict** alongside the run.
- Persist the verdict durably (audit row + an epic field), and surface it
  read-only so it can be compared against the planner's actual output.

### Load-bearing invariant (P0)

**Observe-only.** No execution or planning path may read the classifier verdict
or change because one exists. The verdict is written and surfaced for
measurement only — mirroring the signal-ledger NFR-1 ("the ledger does NOT
influence execution"). This is the constraint we will most regret violating;
pin it with a regression test.

## Phase 0.5 scope (go/no-go gate for Phase 1)

Phase 0.5 is the **named evaluation gate** that sits between P0 observation and
P1 auto-routing. It formalizes the measurement that P0 collects into a
structured pass/fail decision backed by machine-generated evidence.

### Deliverables

- **Evaluation harness** — `scripts/eval-intake.mjs` runs `classifyIntake`
  against a labeled fixture set (`packages/loom-core/eval-cases/intake-classification.yaml`)
  and an LLM judge (`IntakeJudge`, model: `planning_model`) for every case.
- **Report artifact** — `.loom/eval/intake-report.md` (human-readable go/no-go
  document) and `.loom/eval/intake-report.json` (machine-readable). Both are
  produced by a single `renderIntakeReport` call so they cannot drift (ADR-007).
- **Accuracy axes** — the report scores independently on `type`
  (feature/bug/chore) and `size` (story/epic). The Phase 1 decision requires
  both axes to clear their bars.

### Gate rule (ADR-008 / FR-12)

**Phase 1 is gated on a passing report.** The gate clears when
`.loom/eval/intake-report.md` shows `overall.proceed = true`. A failing or
absent report blocks Phase 1. The evaluation is run by an operator (`npm run
eval:intake`); the report is committed alongside the Phase 1 PR as the
evidence record.

### What "measurement" means here

This is the measurement that was previously folded into P0's rollout bullet.
It is now a first-class phase with an explicit artifact trail so the
Phase 1 decision is traceable and reproducible, not a judgment call.

---

## Open questions (revisit as phases land)

- Is "chore" a distinct type, or just a low-ceremony story? (Lean: start with
  feature/bug; add chore only if the data shows it earns its own path.)
- Should an over-large story be **promotable** to an epic mid-flight? (Attractive
  recovery for the asymmetric-misclassification risk; likely a P2+ capability.)
- Confidence threshold for default-to-richer — calibrate from P0 data, don't
  guess.
