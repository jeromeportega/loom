# Machine-Readable CLI Self-Description for LLM Agents

## The Problem

Loom recently removed its MCP server, leaving the CLI as the only interface to the system and loom web as the observability surface. The MCP server previously gave LLM clients structured, discoverable tool schemas — typed arguments, output contracts, and tool relationships an agent could read once and then act on. With it gone, an agent driving loom (Claude Code or similar) has only human-oriented `--help` text: prose tuned for human reading, not machine parsing, with no consistent shape, no JSON output contracts, and no encoded notion that `epic` precedes `approve` precedes `run`. The result is a discoverability regression: the CLI can be operated by a human who reads help pages, but an LLM agent cannot reliably learn the full capability surface or chain commands into tasks without reading source code.

This matters because the CLI is now loom's sole programmatic interface. If agents cannot drive it reliably, loom loses the LLM-client integration the MCP server provided — without gaining back the observability or usability the removal was meant to clarify.

## Target Users

- **Primary — LLM agents driving loom through the CLI.** Interfaces like Claude Code that need to discover loom's commands, understand each command's arguments, output shapes, and relationships, and chain them to accomplish loom tasks (planning, approving, running, status, retry, reconcile) without source-code access.
- **Secondary — loom contributors.** Engineers adding or changing CLI commands, who need a documented standard and a completeness test that tells them when a description is missing or invalid.
- **Secondary — human operators reading docs/help.** Where practical, the same source feeds human help and a generated CLI reference, so humans benefit from descriptions that cannot drift from the code.
- **Anti-persona — MCP/tool-surface consumers.** This work deliberately does **not** serve clients expecting a reintroduced MCP server or tool API. Discoverability is restored purely at the CLI layer.

## Proposed Solution

A four-part CLI self-description capability:

1. **A schema-encoded standard** for LLM-parseable command descriptions, documented so future commands conform.
2. **A description for every command the CLI exposes today**, authored to the standard, co-located with the command definitions as a single source of truth so machine output and human help share one origin.
3. **A `loom describe` command** that emits the full machine-readable manifest as JSON, or a single command's description by name — output that validates against the standard.
4. **A completeness test** that enumerates every registered command and asserts each has a valid description, failing the suite if any command lacks one.

The guiding aim: from `loom describe` JSON alone, an LLM agent can learn to accomplish loom's core tasks without reading source.

## Key Capabilities

1. **Define and document the description standard** — a structured, consistent shape per command capturing: name/path, one-line summary, when-to-use guidance, positional arguments (name, type, required, description), options/flags (name, type, default, description, whether it changes output shape), output contract (including the JSON shape emitted under `--json` where supported), at least one usage example, exit codes and common error conditions, and command relationships (prerequisites and typical next steps).
2. **Capture task-level workflows** — a small set of common recipes that chain commands to accomplish a goal (e.g., the plan → approve → run path).
3. **Encode the standard as a validatable schema** and document it for future authors.
4. **Author descriptions for every current command** — including parity-port additions (`pull-guidance`, `project`) and the new `stop` and `propose` flags; excluding removed commands such as `serve`.
5. **Co-locate descriptions with command definitions** as the single source of truth, feeding both machine output and human help where practical.
6. **Ship `loom describe`** — full manifest as JSON, or single-command lookup by name, validating against the standard.
7. **Enforce completeness via test** — enumerate registered commands and fail if any lacks a complete, valid description.
8. **[ASSUMPTION] Optionally generate a human-readable CLI reference** from the same source, so docs cannot drift from code. Treated as a stretch deliverable, consistent with the "Optionally" framing in the brief.

## Constraints

- **No MCP reintroduction.** Do not bring back any MCP server or tool surface. This is pure CLI self-description.
- **Surface boundaries hold.** CLI remains the usability surface; loom web remains the observability surface.
- **Human help keeps working.** Existing `--help` output must continue to function.
- **No behavior changes.** Do not break any existing command behavior.
- **Single source of truth, co-located.** Descriptions live with command definitions to prevent drift between machine output, human help, and docs.
- **Follows existing precedent.** The completeness test mirrors the parity-oracle pattern from the MCP-removal epic. `[ASSUMPTION]` The schema is expressed in a form consistent with loom's existing `schemas/` directory and `zod`/YAML conventions; the brief does not name the format.
- **Capabilities page.** Per repo policy, the new `describe` command and any user-visible knobs are added to `docs/capabilities.md` in the same change.

## Risks and Open Questions

- **Drift despite co-location.** Co-locating descriptions reduces but does not eliminate drift; the completeness test checks *presence and validity*, not *accuracy* of prose (summaries, when-to-use). `[ASSUMPTION]` Prose accuracy is maintained by author discipline and review, not automated checks — open question whether any accuracy guard is wanted.
- **"Changes the output shape" semantics.** The flag attribute "whether it changes the output shape" needs a precise, testable definition so authors apply it consistently. Open question: is this a free-form note or an enumerated contract?
- **Output-contract fidelity.** The JSON output shape is documented per command, but nothing yet asserts the documented shape matches the *actual* emitted JSON. Open question: should the completeness test (or a companion test) validate real `--json` output against the declared contract? Without it, the agent-facing contract can silently diverge from runtime behavior.
- **Workflow selection.** Which task-level workflows to encode is a judgment call. Acceptance names six core tasks — planning, approving, running, checking status, retrying, reconciling — so those anchor the minimum set. `[ASSUMPTION]` "Retrying" maps to a retry/`run`-resume path and "reconciling" to a reconcile command; exact command names to be confirmed against the current CLI.
- **Command inventory completeness.** The brief calls out inclusions (`pull-guidance`, `project`, `stop`, `propose` flags) and exclusions (`serve`), but the authoritative list is whatever the CLI registers today. Open question resolved by construction: the completeness test enumerates registered commands, so the inventory is derived, not hand-maintained.
- **The "agent could learn from JSON alone" criterion.** This is partly qualitative. Open question: how is it evaluated — by inspection, or by an actual agent-driven dry run of the six core tasks?

## Success Criteria

- A documented, schema-encoded standard for command descriptions exists and can validate a description.
- Every CLI command has a description that validates against the standard, enforced by a completeness test that **fails** if any registered command lacks a valid one.
- `loom describe` emits the full manifest as JSON and emits a single command's description when given a command name; both outputs validate against the standard.
- Descriptions include: summary, when-to-use, arguments, flags with types and defaults, the JSON output shape where applicable, at least one example, exit/error behavior, command relationships, and a few task-level workflows.
- From `loom describe` JSON output alone, an LLM agent could learn to accomplish planning, approving, running, status, retry, and reconcile without reading source code.
- No MCP server or tool surface is reintroduced; human `--help` output still works; no existing command behavior is broken.
- The full build and test suite pass.
- `docs/capabilities.md` reflects the new `describe` command and any user-visible knobs.
