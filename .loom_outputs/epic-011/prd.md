# Legible Failure for Invalid Policy and a Clear Brief-Quality Gate

## Overview

Two dogfooding-surfaced papercuts make loom's failure modes read as crashes or refusals when they are neither. An invalid value in `.loom/policy.yaml` escapes as a raw Node stack trace from the shared policy-load path, bricking *every* command and giving the operator no thread to pull. Separately, the brief-quality gate, when a brief meets the threshold but still has open clarifications, emits output byte-for-byte identical to a hard rejection and exits non-zero — so a passing-with-questions brief is indistinguishable from a below-threshold failure. This work intercepts both failure points and replaces crash/refusal output with structured, actionable messaging, **without touching enforcement, scoring, or guardrail semantics**.

## Goals

1. **Policy validation failures are self-diagnosable.** An operator can fix an invalid knob from the error message alone, without reading a stack trace or the source.
   - *Metric:* 100% of policy validation failures render file path + field path + value received + allowed values/constraint + fix hint; zero raw stack traces, verified across more than one command that loads policy.
2. **The brief gate's three outcomes are distinguishable.** Pass-clean, pass-with-clarifications, and below-threshold each produce a clearly labeled output and a distinct exit status.
   - *Metric:* the pass-with-clarifications case prints a labeled message naming the force flag and exits with a code distinct from the below-threshold failure code.
3. **No semantics drift.** Enforcement, scoring threshold, force-override behavior, and audit logging are unchanged.
   - *Metric:* below-threshold briefs still fail as today; the gate critique is still audit-logged; no guardrail is weakened.

## User Stories

- **As a loom operator,** I want an invalid policy knob to tell me the file, field, bad value, and allowed values, so that I can fix it without reading a stack trace. *(Must)*
- **As a loom operator,** I want a passing-but-questioned brief to look visibly different from a rejected one and to know the force flag is the way through, so that I don't mistake a pass for a refusal. *(Must)*
- **As a loom operator,** I want the prerequisites doctor to catch a bad policy knob proactively, so that I find it deliberately instead of by crashing a command. *(Should)*
- **As a loom maintainer/dogfooder,** I want self-describing errors, so that I can tell a config mistake from a loom bug without triage churn. *(Should)*

## Functional Requirements

- **FR-1:** On any policy validation failure, the CLI prints a structured message naming the **policy file path**, the **offending field path**, the **value received**, the **allowed values or constraint**, and a **one-line fix hint**.
- **FR-2:** No raw stack trace escapes for a policy *validation* error; the command exits **non-zero cleanly**.
- **FR-3:** The friendly render is applied at the **shared policy load/validate path** so every command that loads policy benefits, rather than wrapping each call site. `[ASSUMPTION]` a single shared policy-load function exists; if loading is duplicated, this is a small refactor.
- **FR-4:** The prerequisites **doctor** validates the policy file and reports an invalid knob as a **failed check**, carrying the same field-and-allowed-values detail and sharing the FR-1 render path to avoid drift.
- **FR-5:** With a valid policy, the doctor's policy check **passes**.
- **FR-6:** When a brief scores **at or above threshold with no clarifications**, planning proceeds **unchanged**.
- **FR-7:** When a brief scores **at or above threshold but has open clarifications**, the gate prints a clearly labeled **PASSED-with-clarifications** message that (a) lists the clarifications as *optional*, (b) names the **force flag** as the way to plan as-is or invites tightening the brief, and (c) exits with a status **distinct** from a below-threshold failure. `[ASSUMPTION]` the message must use the actual force-flag spelling, confirmed at implementation, not a paraphrase.
- **FR-8:** A **below-threshold** brief continues to fail exactly as it does today.
- **FR-9:** When multiple knobs are invalid, report **all** if the validator surfaces them cheaply; otherwise **first-error** is acceptable for v1. `[ASSUMPTION]`

## Non-Functional Requirements

- **NFR-1:** Policy *validation* errors never surface a raw Node stack trace to the operator (legibility).
- **NFR-2:** The gate critique remains **audit-logged before returning**, per the loom invariant that all agent actions are logged.
- **NFR-3:** The policy engine remains **structurally enforcing**; no guardrail is weakened and no invalid policy becomes easier to load.
- **NFR-4:** The scoring threshold and force-override semantics are **unchanged**; this work changes *how* outcomes are communicated, not *which* outcome is reached.

## Epics

This brief explicitly spans two independently deliverable papercuts touching different subsystems (the policy load/doctor path vs. the brief-quality gate); either can ship without the other. Accordingly:

- **epic-001 — Legible policy validation failures.** Friendly structured render at the shared load path + doctor policy check. Covers FR-1 through FR-5, FR-9.
- **epic-002 — Legible brief-quality gate.** Distinct, labeled pass-with-clarifications outcome and exit status. Covers FR-6 through FR-8.

## Out of Scope

- **Malformed or missing policy files.** Unparseable YAML or an absent `.loom/policy.yaml` is distinct from an invalid-*value* error; this work targets validation errors only, unless malformed-file handling is trivially adjacent. `[ASSUMPTION]`
- Any change to the **scoring threshold** or **force-override semantics**.
- Any **loosening of enforcement** or guardrail behavior.
- **Renaming or re-specifying** the force flag — the message names the existing flag as-is.
- New validation logic — the structured message is a **render** of the existing `zod` validation error, which already exposes field path, received value, and expected values. `[ASSUMPTION]`
