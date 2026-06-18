# Machine-Readable CLI Self-Description for LLM Agents

## Overview

Removing loom's MCP server left the CLI as loom's sole programmatic interface, but the CLI exposes only human-oriented `--help` prose — no consistent shape, no JSON output contracts, and no encoded command ordering (`epic` → `approve` → `run`). An LLM agent driving loom cannot reliably learn the capability surface or chain commands without reading source code. This PRD specifies a four-part CLI self-description capability: a schema-encoded description standard, a description for every registered command co-located with its definition, a `loom describe` command that emits the machine-readable manifest as JSON, and a completeness test that fails the suite if any command lacks a valid description. The guiding bar: from `loom describe` JSON alone, an LLM agent can accomplish loom's core tasks without source access.

## Goals

1. **Restore machine discoverability.** An LLM agent can accomplish the six core tasks — plan, approve, run, status, retry, reconcile — using `loom describe` JSON alone, without reading source. *Metric: an agent-driven (or inspection-based) dry run of all six core tasks completes using only `describe` output.*
2. **Guarantee complete coverage.** Every command the CLI registers has a description that validates against the standard. *Metric: the completeness test enumerates registered commands and fails if coverage is < 100%.*
3. **Eliminate drift at the source.** Descriptions are co-located with command definitions and feed both machine output and human help. *Metric: a single source of truth per command; no duplicate description store.*
4. **Zero regression.** Human `--help` still works, no command behavior changes, no MCP surface returns. *Metric: full build and test suite pass; existing `--help` output continues to function.*

## User Stories

- **As an LLM agent driving loom, I want** a machine-readable manifest of every command — arguments, flags, output shapes, exit codes, relationships, and task workflows — **so that** I can chain commands into tasks without reading source. *(Must)*
- **As an LLM agent, I want** to fetch a single command's description by name, **so that** I can look up just what I need without parsing the whole manifest. *(Should)*
- **As a loom contributor, I want** a documented description standard and a completeness test, **so that** I know immediately when a new or changed command is missing a valid description. *(Must)*
- **As a human operator, I want** help and a CLI reference generated from the same source as the machine output, **so that** documentation cannot drift from the code. *(Could)*

## Functional Requirements

- **FR-1** — Define a structured per-command description standard capturing: name/path, one-line summary, when-to-use guidance, positional arguments (name, type, required, description), options/flags (name, type, default, description, and whether the flag changes the output shape), output contract (including the JSON shape emitted under `--json` where supported), at least one usage example, exit codes and common error conditions, and command relationships (prerequisites and typical next steps).
- **FR-2** — Encode the standard as a validatable schema. `[ASSUMPTION]` The schema is expressed in a form consistent with loom's `schemas/` directory and `zod`/YAML conventions; the brief does not name the format.
- **FR-3** — Document the standard so future command authors can conform to it.
- **FR-4** — Author a description, conforming to the standard, for every command the CLI registers today — including the parity-port additions `pull-guidance` and `project` and the new `stop` and `propose` flags, and excluding removed commands such as `serve`. The authoritative command list is whatever the CLI registers, not a hand-maintained list.
- **FR-5** — Co-locate each description with its command definition as a single source of truth, feeding both machine output and human help where practical.
- **FR-6** — Capture a small set of task-level workflows that chain commands to accomplish a goal, anchored by the six core tasks named in acceptance — planning, approving, running, checking status, retrying, and reconciling — including the plan → approve → run path. `[ASSUMPTION]` "Retrying" maps to a retry/`run`-resume path and "reconciling" to the reconcile command; exact command names confirmed against the current CLI during implementation.
- **FR-7** — `loom describe` (no argument) emits the full machine-readable manifest as JSON, validating against the standard.
- **FR-8** — `loom describe <command>` emits a single command's description by name, validating against the standard.
- **FR-9** — A completeness test enumerates every registered command and fails the suite if any command lacks a complete, valid description, mirroring the parity-oracle pattern from the MCP-removal epic.
- **FR-10** — Update `docs/capabilities.md` in the same change to reflect the new `describe` command and any user-visible knobs, per repo policy.
- **FR-11** `[ASSUMPTION]` *(stretch)* — Optionally generate a human-readable CLI reference from the same description source, so docs cannot drift from code. Treated as a stretch deliverable consistent with the brief's "Optionally" framing.

## Non-Functional Requirements

- **NFR-1** — Existing human `--help` output must continue to function.
- **NFR-2** — No existing command behavior may change.
- **NFR-3** — No MCP server or tool surface may be reintroduced; discoverability is restored purely at the CLI layer.
- **NFR-4** — The full build and test suite must pass.

## Epics

This PRD is a single, cohesive epic:

- **Epic 1 — CLI Self-Description for LLM Agents.** Define and document the description standard and schema, author descriptions for every registered command co-located with their definitions, ship `loom describe` (full manifest + single-command lookup), capture the core task workflows, and enforce coverage with a completeness test.

## Out of Scope

- Reintroducing any MCP server or tool API. The anti-persona — MCP/tool-surface consumers — is deliberately not served.
- Changes to the observability surface (loom web); surface boundaries hold.
- Automated validation of prose *accuracy* (summaries, when-to-use). The completeness test checks presence and validity, not accuracy; prose accuracy is maintained by author discipline and review. `[ASSUMPTION]` Whether an accuracy guard is wanted is an open question deferred past V1.
- Asserting that the documented `--json` output contract matches the *actual* emitted JSON at runtime. Open question whether the completeness test (or a companion test) should validate real `--json` output against the declared contract; deferred past V1 unless pulled in during implementation.
