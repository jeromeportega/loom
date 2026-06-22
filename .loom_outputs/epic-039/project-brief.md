# Reliable Rejection of Unsafe and Non-Reusable Skill Candidates

## The Problem

Loom's skill judge is the gate on what enters the skill library. It scores a candidate skill from zero to ten on the non-agentic completion path and returns an accept-or-reject verdict with a reason. The skill-judge eval — an offline, operator-run harness scored by an independent LLM-as-judge — surfaced a false-accept gap: decision accuracy was only 70 percent, and **every error fell in the dangerous direction**.

Two anchor cases designed to be rejected were instead accepted:

1. **Non-reusable** — a candidate tied to loom-internal SQLite specifics, not a general-purpose skill.
2. **Unsafe** — a candidate that teaches a force-push (a destructive, history-rewriting operation).

The independent judge agreed both should have been rejected and rated the skill judge's accept verdict as *indefensible*. The asymmetry is what makes this urgent: a wrong reject merely loses one skill, but a wrong accept **pollutes the shared library** — and in the unsafe case, admits a skill that actively teaches dangerous behavior to every agent that later draws on it. The judge is currently too permissive precisely where permissiveness is most costly.

## Target Users

- **Primary — Loom operators** who curate the skill library and run the skill-judge eval. They rely on the judge to hold the line on safety and reusability so library quality does not degrade over time.
- **Secondary — Loom agents (and their downstream users)** that consume library skills at runtime. They silently inherit any unsafe or non-reusable skill that slips past the gate.
- **Anti-persona — the "let it in" contributor** who wants to fast-track a narrow, repo-specific helper or a convenient-but-destructive shortcut into the shared library. The hardened judge should reject these by design; we are explicitly *not* optimizing for frictionless admission.

## Proposed Solution

Sharpen the skill judge's **admission criteria in its prompt** so that safety and reusability become explicit, high-priority rejection criteria. A candidate is rejected when it is:

- **Unsafe** — teaches or encourages a dangerous or destructive operation (e.g., force-pushing, history rewriting, deleting data, disabling safety checks); or
- **Not genuinely reusable** — narrowly tied to one repo's internals, a one-off, or not generalizable.

These criteria take precedence over surface quality: a well-written, polished candidate that is unsafe or non-reusable is still rejected. The change is **principled, not fixture-tuned** — criteria are defined on general grounds and must not reference the eval's specific cases. Everything else about the judge — its path, output schema, parsing, and fail-open-on-error behavior — stays the same in shape; only the criteria text gets sharper.

## Key Capabilities

1. **High-priority safety rejection** — reject candidates that teach or encourage dangerous/destructive operations, named with representative examples rather than an exhaustive blocklist.
2. **High-priority reusability rejection** — reject candidates that are repo-specific, one-off, or not generalizable to a broader context.
3. **Override of surface quality** — apply safety and reusability gates regardless of how well-written or otherwise compelling a candidate appears.
4. **Preserved acceptance of good skills** — genuinely good, safe, reusable candidates continue to be accepted; the judge must not tip into indiscriminate strictness.
5. **Principled criteria** — express the new criteria generically, with no reference to eval fixtures.
6. **Unchanged output contract** — keep the zero-to-ten score, accept/reject verdict, reason field, parsing, and fail-open default unchanged in shape.
7. **Unit coverage of intent** — tests that exercise the sharpened criteria using mocked judge outputs, with no real model calls.

## Constraints

- The judge **stays on the non-agentic completion path**; only the admission-criteria prompt text changes.
- **Output schema, parsing, and fail-open-on-error behavior are unchanged in shape.** Fail-open (default-accept on error) is preserved as-is — hardening it is out of scope.
- **No guardrail may be weakened.**
- **Do not overfit** to the eval fixtures; safety and reusability are defined on principled grounds.
- The **full skill-judge eval is not run as a worker story** — it is operator-run. This effort ships the criteria change and unit tests; the operator re-runs the eval to confirm results.
- **Update skill docs** if admission criteria are documented there, and **pass the capabilities drift check** if any user-visible surface changes.

## Risks and Open Questions

- **Over-rejection is the central tension.** Tightening to catch the two false accepts must not start rejecting genuinely good skills. The eval's good-skill cases are the guardrail, but they are validated *after* merge by the operator, not in CI — there is a gap between landing the change and confirming no regression. [ASSUMPTION] Unit tests with mocked outputs are the only pre-merge signal that intent is encoded correctly.
- **Definitional boundaries.** "Unsafe" and "not reusable" must be precise enough to be actionable in the prompt yet general enough not to be a fixture-shaped blocklist. Edge cases (e.g., a legitimately reusable skill that *mentions* a destructive command in a safe, guarded way) need a clear handling stance.
- **Fail-open residual gap.** Because fail-open is preserved, a candidate can still be admitted when the judge errors. This is intentionally out of scope but remains a known path by which an unsafe skill could enter. [ASSUMPTION] Acceptable for this phase; worth flagging for a future hardening effort.
- **Score-knob interaction.** [ASSUMPTION] The `judge-minimum-score` policy knob still governs admission alongside the verdict; the criteria change should ensure an unsafe/non-reusable candidate rejects via the verdict regardless of any score it might otherwise earn. The architect should confirm verdict-vs-score precedence.
- **Documentation surface.** [ASSUMPTION] It is not yet confirmed whether admission criteria are currently documented in the skill docs; the doc update is conditional on that.

## Success Criteria

- The skill judge's admission criteria **explicitly and with high priority reject** (a) unsafe candidates that teach or encourage dangerous/destructive operations and (b) non-reusable candidates that are repo-specific, one-off, or non-generalizable.
- The criteria are a **principled prompt change** that does **not** reference the eval fixtures.
- **Genuinely good, safe, reusable skills are still accepted** — no indiscriminate strictness.
- The judge's **output schema, parsing, and fail-open behavior are unchanged in shape.**
- **Unit tests** cover the sharpened criteria intent using mocked judge outputs, with **no real model calls**.
- The **full skill-judge eval is not run as a worker story**; the operator re-runs it and confirms the unsafe and non-reusable cases now reject while the good cases still accept.
- **Skill docs are updated** if admission criteria are documented, and the **capabilities drift check passes** if a user-visible surface changes.
- The **full build and test suite pass.**
