# PRD: Capabilities Documentation Drift Guard

## Overview

`docs/capabilities.md` is loom's declared single source of truth for what an operator can do on `main`, governed by an honor-system rule that user-visible changes update the page in the same PR. That rule has not held: the page omits real policy knobs, documents commands and knobs that do not exist, and carries a stale "does NOT do" entry for a removed backend. This work adds a coverage check that compares loom's live, authoritative surface (registered CLI subcommands and schema-declared policy knobs) against the page and fails on disagreement, corrects today's drift until the check passes, and extends the same anti-drift treatment to the releasing runbook's package list. The check verifies *coverage*, never authoring prose — the page stays human-written.

## Goals

1. **Mechanically catch capabilities drift.** Success: a test in the suite fails whenever the page omits a real subcommand/knob or documents one that does not exist; passing the suite is impossible while the page and code disagree.
2. **Eliminate today's drift.** Success: all four observed drift types (omitted real knobs, phantom commands, phantom knobs, stale removed-backend entry) are corrected and the new check passes on `main`.
3. **Source the check only from authoritative live surfaces.** Success: the subcommand set is derived from the command registry and the knob set from `schemas/policy.schema.yaml` — zero hand-maintained inventories in the check.
4. **Extend anti-drift to the releasing runbook.** Success: the runbook's package list is derived from or verified against the actual workspace set, so adding/removing a package cannot leave it silently stale.

## User Stories

- **(Must)** As a **loom operator**, I want the capabilities page to accurately list every command and policy knob that exists, so that I can trust it instead of being misled by phantom or missing entries.
- **(Must)** As a **loom maintainer/contributor**, I want drift caught automatically in CI/local test runs, so that I get a mechanical backstop instead of relying on review-by-eye to enforce the same-PR rule.
- **(Should)** As an **operator or CI job**, I want the drift check surfaced through the prerequisites doctor where it fits, so that I can run it on demand outside a full test run.
- **(Should)** As a **release engineer**, I want the releasing runbook's package list to match the real workspaces, so that I do not follow a stale list when cutting a release.

## Functional Requirements

- **FR-1** Enumerate the live CLI subcommand surface from the actual command registration (not a static list), e.g. `init`, `epic`, `approve`, `run`, `status`, `diff`, `review`, `artifacts`, `traces`, `audit`, `autonomy`.
- **FR-2** Enumerate the live operator-visible policy-knob surface from `schemas/policy.schema.yaml`. Where not every schema field is an operator-facing knob, the check covers a defined subset and that subset rule is explicit.
- **FR-3** Assert coverage bidirectionally: fail if the page omits a real subcommand or knob, **and** fail if the page documents a subcommand or knob that does not exist.
- **FR-4** Use a precise page-representation matching rule — exact token/identifier matching against a defined region of the page — that tolerates documented aliases/synonyms for commands and knobs without flagging correctly-documented entries as missing, and without passing on substring coincidence.
- **FR-5** Run the drift check as a test in the suite so that drift breaks the build.
- **FR-6** Expose the same check as a mode of the prerequisites doctor where that surface fits; if no such surface exists, the test-suite wiring is the binding requirement and the doctor mode is best-effort.
- **FR-7** Fix today's drift until the check passes: add missing real knobs/commands, remove documented-but-nonexistent commands/knobs, and remove or correct the stale removed-backend entry under "What loom does NOT do" to reflect actual current behavior. `[ASSUMPTION]` the removed backend is the MCP server surface (worker provisioning retained); confirm against the code before editing.
- **FR-8** Make the releasing runbook's package list derive from, or be verified against, the actual workspace set, such that adding/removing a package cannot silently leave it stale.
- **FR-9** Reflect the new check and any new doctor mode on the capabilities page itself in the same change, per project convention that they are user-visible surface.

## Non-Functional Requirements

- **NFR-1 (Integrity)** The check must not weaken any guardrail; this is a documentation-integrity change, not a policy change.
- **NFR-2 (Authoritativeness)** The check must read its surface only from authoritative live sources (command registry, schema, workspace manifest) — no parallel hand-maintained inventory that could itself drift.
- **NFR-3 (Human-readability)** The check verifies coverage only and must not autogenerate or rewrite the page's human-readable prose.

## Epics

- **Epic 1 — Capabilities Documentation Drift Guard.** A single cohesive unit: the coverage check (CLI + knob enumeration, bidirectional assertion, test wiring, doctor mode), the one-time drift correction, and the releasing-runbook parity treatment.

## Out of Scope

- Autogenerating or machine-authoring the human-readable descriptions on `docs/capabilities.md`.
- Fuzzy/semantic matching beyond exact token/identifier matching against a defined page region.
- Coverage of any surface other than CLI subcommands and operator-visible policy knobs (e.g. individual command flags, MCP tools, environment variables) unless required to correct an observed drift.
- Any change to policy behavior, command behavior, or guardrails.
