# Epic F — Adaptive Review Depth (complexity × confidence)

> Future / backlog loom epic. NOT build-day work and not required pre-week —
> the static `review_strategy` + the Sonnet worker fix already buy most of the
> speed. This is the dynamic version, and a strong Signal-Scout / Flywheel
> demo candidate.

## Problem

`review_strategy` is a single global knob: `block-and-revise` runs the full
3-reviewer Review Forge loop (CodeReviewAgent + adversarial-review +
edge-case-hunter) + a revise cycle on EVERY story, while `comment` runs no
blocking loop on any. So loom either over-spends review on a trivial 5-line
change or under-protects a gnarly 400-line auth change. Review is the biggest
per-story time sink (see the speed analysis), and it's spent uniformly
regardless of risk.

## Idea

After a worker delivers, loom scores the actual diff and **dials review depth
per story** instead of applying one global strategy:

- **Complexity signals:** diff size, files touched, blast radius / fan-out,
  cyclomatic complexity, and whether the change touches sensitive areas
  (auth, payments, migrations, policy/guardrails, money math).
- **Confidence signals:** did tests pass first try? how many self-corrections
  did the worker make? did it flag uncertainty? severity of first-pass review
  findings? coverage of the changed lines?

Map (complexity × confidence) → review intensity:

| | High confidence | Low confidence |
|---|---|---|
| **Low complexity** | comment-only / skip | single reviewer |
| **High complexity** | single reviewer + targeted | full block-and-revise loop, higher revision cap |

## Reuse what loom already has

- `qa_planning: advisory` already applies a **risk lens at plan time** (Tessa) —
  same idea, earlier in the lifecycle; reuse its risk scoring.
- Review Forge is already a **variable-intensity reviewer pool** — this epic
  just chooses how much of it to engage.
- `audit_log` + `decision_traces` hold the history needed to calibrate.

## The Flywheel angle

The thresholds shouldn't be hand-tuned forever. The **Flywheel (v4)** can
*learn* them from loom's own history — "changes in area X with signal Y
historically needed N cycles, M findings" — and **Signal Scout (v3)** is
exactly what would surface "review cycles are over-spent on trivial diffs" as
an opportunity in the first place. So this epic is both a speed win and a
demonstration of why the learning loop matters.

## Done means

- Per-story review depth visibly varies with measured complexity/confidence
  (a trivial diff skips the heavy loop; a complex/low-confidence diff engages
  it), proven on real epics.
- The static `review_strategy` knobs remain as an operator floor/ceiling
  override — adaptive picks WITHIN the allowed band.
- Decision trace records WHY a given review depth was chosen (the scores).
- Tests for the scorer and the depth-selection mapping; suite green.
- `docs/capabilities.md` updated.

## Non-goals

- Build-day scope (this is loom harness work).
- Removing manual review control — adaptive is bounded by operator policy.
- A full ML model — heuristics + (later) Flywheel-learned thresholds suffice.
