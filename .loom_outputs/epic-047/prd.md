# Standalone Story Routing for Story-Sized Briefs

## Overview

When `intake_routing` is enabled and the classifier judges a brief to be story-sized, loom correctly plans a single cohesive story — then wraps it in a one-story epic and reports "1 epic, 1 story." This runs heavy epic ceremony (an epic-level PRD and a multi-story decomposition pass) for a unit of work the classifier already deemed a single story, and it misrepresents the artifact: the operator submitted story-sized work but receives an `epic-NNN`. This feature introduces a **standalone-story path** in the planner that triggers exactly when `intake_routing` is `advisory` or `confirm` and the effective (post-override) size is `story`. On that path, loom skips the epic ceremony, produces one story directly, dispatches it through the unchanged story execution machinery, finalizes it to a single pull request, and presents it as a standalone story id — never as an epic with one story. The epic path and the `intake_routing: off` path are untouched.

## Goals

1. **Eliminate epic ceremony for story-sized work.** On the standalone path, zero epic-level PRD generation and zero multi-story decomposition passes run — measured by the absence of those stages for a story-routed brief.
2. **Present story-sized work honestly.** 100% of standalone-routed work surfaces a story id (and story framing) in user-facing output and `loom status`; 0% appear as `epic-NNN with 1 story`.
3. **Zero regression on untouched paths.** `intake_routing: off` produces byte-identical planning output to today (proven by a golden/snapshot test), and the epic path — including `confirm`-mode story→epic overrides — runs exactly as today.
4. **Full parity of guardrails and provenance.** The standalone story passes the same integration gate and guardrails as any story, and carries equivalent decision-trace, audit, and log provenance.

## User Stories

- **As a loom operator** submitting a story-sized brief under `intake_routing: advisory` or `confirm`, **I want** a lightweight path straight from brief to a single PR **so that** I am not charged the time and noise of epic planning for one story. *(Must)*
- **As a loom operator**, **I want** my story-sized work labeled as a story in output and `loom status` **so that** the artifact I receive matches the work I submitted. *(Must)*
- **As an operator overriding a story up to epic** in `confirm` mode, **I want** the full epic pipeline to run **so that** my override is honored. *(Must)*
- **As a loom maintainer**, **I want** the epic path and the `off` path provably unchanged and the standalone branch cleanly isolated **so that** I can ship this without risking existing behavior. *(Must)*

## Functional Requirements

- **FR-1** — When `intake_routing ∈ {advisory, confirm}` **and** the effective verdict after any operator override is `size=story`, the planner routes to the standalone-story path instead of epic decomposition.
- **FR-2** — When the effective size is `epic` (including a `confirm`-mode story→epic override), the planner runs the full epic pipeline unchanged.
- **FR-3** — When `intake_routing: off`, the planner runs the full epic pipeline with output byte-identical to today, regardless of brief size.
- **FR-4** — On the standalone path, the planner produces exactly one story — title, description, acceptance criteria, and technical notes — from the refined brief, with no epic-level PRD and no multi-story decomposition pass.
- **FR-5** — The standalone story is dispatched through the existing story execution machinery (worker, branch, worktree, integration gate) without modification to that machinery.
- **FR-6** — The standalone story is finalized to a single pull request.
- **FR-7** — User-facing output and `loom status` present the standalone story by a story id with story framing, never as `epic-NNN` with one story, and without regressing epic display.
- **FR-8** — The standalone story records decision traces, audit entries, and logs equivalent to a story under the epic path today.
- **FR-9** — The classifier remains on the non-agentic path and continues to classify the *refined* brief; its placement is unchanged.
- **FR-10** — `docs/capabilities.md` documents standalone-story routing, and the capabilities drift check passes.

## Non-Functional Requirements

- **NFR-1** — *Equivalence is provable.* The `intake_routing: off` path's planning output is compared against a stable, deterministic reference (snapshot/golden) so byte-identity can be asserted in CI.
- **NFR-2** — *Branch isolation.* The standalone path is added without weakening or altering the integration gate or any guardrail applied to stories.

## Epics

This PRD is a single cohesive change to the planning pipeline and breaks into **one epic: Standalone Story Routing.**

## Out of Scope

- Any change to behavior when `intake_routing: off` (must remain byte-identical).
- Any change to the epic pipeline, including the `confirm`-mode story→epic override path.
- Moving or re-implementing the classifier, or changing what it classifies (still the refined brief, still non-agentic).
- New parallel story-execution, integration-gate, or finalize infrastructure — the feature reuses existing machinery.
- Multi-story or multi-PR standalone flows — the standalone path produces exactly one story and one PR.
