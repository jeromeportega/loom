# Legible Failure for Invalid Policy and a Clear Brief-Quality Gate

## The Problem

Two operator-experience papercuts, both found while dogfooding loom, make loom's
failure modes read as crashes or refusals when they are neither.

1. **Invalid policy bricks the entire CLI.** When `.loom/policy.yaml` contains an
   invalid value for a knob — e.g. a string that is not one of the allowed enum
   values — the policy engine throws an unhandled validation error. Because every
   command loads policy, *every* loom command crashes with a raw Node stack trace.
   The dump names neither the offending file, nor the field, nor the value received,
   nor the allowed values. A single mistyped enum is indistinguishable from a loom bug,
   and the operator has no thread to pull.

2. **A passing brief looks like a refusal.** The brief-quality gate, on a brief whose
   score *meets or exceeds* the threshold but still has open clarifications, prints the
   passing score, then prints a clarification critique with an instruction to tighten
   and re-run, and exits non-zero. The output is byte-for-byte the shape of a hard
   failure. The operator cannot tell a passing-with-questions brief from a
   below-threshold rejection, and nothing signals that the force flag is the way through.

Both are cases where loom *knows* the right answer but communicates it as a crash or a
refusal.

## Target Users

- **Primary — loom operators** running `loom` commands against a configured repo. They
  hit policy validation on every command and the brief gate every time they plan an epic.
  They need errors they can act on without reading a stack trace or the source.
- **Secondary — loom maintainers / dogfooders** who triage operator reports. Clear,
  self-describing errors cut "is this my config or a loom bug?" support churn.
- **Anti-persona — the policy engine's enforcement path.** This work is about *legibility
  of failure*, not leniency. Nothing here should make an invalid policy easier to load or
  a weak brief easier to pass.

## Proposed Solution

Intercept the two failure points and replace crash/refusal output with structured,
actionable messaging — without touching enforcement or scoring semantics.

- **Friendly policy validation:** catch the policy validation error at load time and
  render a clear, structured message instead of letting it escape as a stack trace.
- **Proactive detection via doctor:** have the prerequisites doctor validate the policy
  file so an operator finds a bad knob deliberately, not by crashing a command.
- **Legible brief gate:** give the passing-with-clarifications case its own clearly
  labeled message and its own exit status, distinct from a below-threshold failure.

## Key Capabilities

1. On any policy validation failure, print a message naming: the **policy file path**,
   the **offending field path**, the **value received**, the **allowed values or
   constraint**, and a **one-line fix hint**.
2. Never let a raw stack trace escape for a policy *validation* error; exit non-zero
   cleanly. This benefits every command that loads policy via a single shared path.
3. The prerequisites **doctor** validates the policy file and reports an invalid knob as
   a **failed check**, carrying the same field-and-allowed-values detail.
4. When a brief scores **at or above threshold with no clarifications**, proceed to
   planning unchanged.
5. When a brief scores **at or above threshold but has open clarifications**, print a
   clearly labeled **PASSED-with-clarifications** message that lists the clarifications
   as *optional*, names the **force flag** as the way to plan as-is (or invites the
   operator to tighten the brief), and exits with a status **distinct** from a
   below-threshold failure.
6. A **below-threshold** brief continues to fail exactly as it does today.

## Constraints

- Do **not** change the scoring threshold behavior or the force-override semantics.
- Do **not** weaken any guardrail; the policy engine remains structurally enforcing.
- Keep the gate critique **audit-logged** as it is today (per loom invariant: all agent
  actions are logged before returning).
- Reuse the existing policy load path so the friendly error covers *all* commands, rather
  than wrapping each call site. `[ASSUMPTION]` a single shared policy-load/validate
  function exists; if loading is duplicated per command, this becomes a small refactor.
- `[ASSUMPTION]` Policy schema validation runs through `zod` (per repo tech stack), whose
  errors already expose field path, received value, and expected values — the structured
  message is a render of that error, not new validation logic.

## Risks and Open Questions

- **Three exit statuses, one gate.** The brief gate now distinguishes pass-clean,
  pass-with-clarifications, and below-threshold. Open question: which exit code
  represents pass-with-clarifications, and do any callers/scripts branch on the current
  non-zero code? `[ASSUMPTION]` a new, documented non-zero code is acceptable since the
  current behavior is the confusing one being fixed.
- **Multiple invalid knobs.** Does the friendly validator report only the first offending
  field or all of them? `[ASSUMPTION]` report all if the validator surfaces them cheaply;
  otherwise first-error is acceptable for v1.
- **Doctor scope.** Does the doctor already load policy, or must it gain a policy-aware
  check? Either way it should share the same render path as Part 1 to avoid drift.
- **Non-validation policy errors.** A missing or unparseable (malformed YAML) policy file
  is distinct from an invalid-value error. `[ASSUMPTION]` this work targets *validation*
  (bad value) errors; malformed-file handling is out of scope unless trivially adjacent.
- **`force` flag naming.** The brief assumes a force flag exists on the planning/gate
  path; the message must name the actual flag spelling, not a paraphrase.

## Success Criteria

- A `.loom/policy.yaml` with an invalid enum or constraint value produces a message
  naming the **file**, the **field**, the **received value**, and the **allowed
  values/constraint**, with **no raw stack trace**, and the command exits **non-zero
  cleanly** — verifiable across more than one command that loads policy.
- The **doctor** reports an invalid policy knob as a **failed check** carrying the same
  field-and-allowed-values detail; with a valid policy, the check passes.
- The brief gate, on a brief that **meets the threshold but has clarifications**, prints a
  clearly labeled **passed-with-clarifications** message that names the **force flag** as
  the way to proceed and exits with a status **distinct** from a below-threshold failure.
- A **below-threshold** brief still fails as before, and the gate critique is still
  **audit-logged**.
- Scoring threshold and force-override semantics are unchanged; no guardrail is weakened.
- The full **build and test suite pass**.
