# Capabilities Documentation Drift Guard

## The Problem

`docs/capabilities.md` is loom's declared single source of truth for what an operator can do with the version on `main`. The project rule — *any user-visible change updates the capabilities page in the same change* — is honor-system only, and it has not held. The page has silently drifted from the code in four observed ways:

1. It **omits** several real policy knobs that the schema actually defines.
2. It **documents commands that were never implemented**.
3. It **documents policy knobs that do not exist** in the code.
4. It **carries a stale entry under its "What loom does NOT do" section** for a backend that has since been removed.

Nothing mechanically catches any of this. The result: the page and the code disagree, and an operator who trusts the page is misled — the exact failure the single-source-of-truth rule was meant to prevent. A secondary instance of the same class of problem exists in the releasing runbook, whose hand-maintained package list can fall out of step with the actual workspace set.

## Target Users

- **Primary — operators of loom.** They read `docs/capabilities.md` to learn what commands and policy knobs exist. They are harmed directly when the page lies.
- **Primary — loom maintainers/contributors.** They are bound by the "update the page in the same PR" rule and currently have no automated backstop; they need the drift caught in CI/local test runs rather than in review-by-eye.
- **Secondary — release engineers** following the releasing runbook, who need its package list to match the real workspaces.
- **Anti-persona — end-user prose readers.** This work must not turn the page into machine-generated output; the check verifies *coverage*, it does not author or autogenerate human-readable descriptions.

## Proposed Solution

A coverage check that compares loom's **live, authoritative surface** against `docs/capabilities.md` and fails when they disagree, plus a one-time correction of the drift that exists today, plus the same anti-drift treatment applied to the releasing runbook's package list.

The check enumerates the surface from authoritative live sources — the registered CLI subcommands and the policy knobs declared in the schema — never from a hand-maintained list. It asserts bidirectional consistency: every live subcommand and every schema knob is represented on the page, **and** the page documents no command or knob that does not exist. It is wired into the test suite and, where it fits, exposed as a mode of the prerequisites doctor so operators and CI both catch drift mechanically.

## Key Capabilities

1. **Enumerate the live CLI surface** — derive the set of subcommands from the actual command registration (e.g. `init`, `epic`, `approve`, `run`, `status`, `diff`, `review`, `artifacts`, `traces`, `audit`, `autonomy`), not a static list.
2. **Enumerate the live policy-knob surface** — derive the set of policy knobs from `schemas/policy.schema.yaml`.
3. **Assert coverage both ways** — fail if the page omits a real subcommand or knob; fail if the page documents one that does not exist.
4. **Run as a test** in the suite so drift breaks the build.
5. **Expose a doctor mode** — surface the same check through the prerequisites doctor where it fits.
6. **Fix today's drift** — add missing real knobs/commands, remove documented-but-nonexistent ones, and correct the stale removed-backend entry in the "does NOT do" section, until the check passes.
7. **Runbook parity** — make the releasing runbook's package list derive from, or be verified against, the actual workspace set so adding/removing a package cannot silently leave it stale.

## Constraints

- **Do not invent capabilities.** The page must describe only what the code actually does.
- **Do not weaken any guardrail.** This is a documentation-integrity change, not a policy change.
- **Keep the page human-readable.** The check verifies coverage only; it must not autogenerate prose.
- **Enumerate from authoritative live sources** (command registry, schema, workspace manifest) — no parallel hand-maintained inventory that could itself drift.
- Per project convention, the check and any new doctor mode are themselves user-visible surface and must be reflected on the capabilities page in the same change.

## Risks and Open Questions

- **What is the stale removed-backend entry?** `[ASSUMPTION]` Given recent direction, the removed backend under "does NOT do" is the MCP server surface (with worker provisioning retained). The fix must reflect actual current behavior, not assumed behavior — confirm against the code before editing.
- **Does a "prerequisites doctor" command exist today, and under what name?** `[ASSUMPTION]` It maps to a `loom doctor`-style command. If no such surface exists, "wire it as a doctor mode" is best-effort ("where it fits") and the test-suite wiring is the binding requirement.
- **Page-representation matching is fuzzy.** Matching a subcommand/knob name to "represented on the page" risks false passes (substring coincidence) or false failures (a knob documented under a different heading). The matching rule needs to be precise enough to be trustworthy without being so strict it forces a rigid page format. `[ASSUMPTION]` Exact token/identifier matching against a defined region of the page is acceptable.
- **Schema-to-operator-knob mapping.** Not every schema field is necessarily a user-facing policy knob. The check must enumerate the operator-visible knobs the page is meant to cover, which may be a defined subset rather than every schema property.
- **Synonyms and aliases.** If a command has aliases or a knob has a documented alternate name, the check must not flag a correctly-documented entry as missing.

## Success Criteria

- A drift check exists that **enumerates the live subcommands and the schema policy knobs from authoritative live sources** (not a hand-maintained list).
- The check **fails** when the capabilities page omits a real subcommand or knob, **and** fails when the page documents a subcommand or knob that does not exist.
- The check runs **as a test in the suite**, and is exposed as a **mode of the prerequisites doctor** where that surface fits.
- Today's drift is **fixed and the check passes**: every real knob and command is present on the page, no nonexistent command or knob remains, and the stale removed-backend entry under "does NOT do" is removed or corrected to reflect actual behavior.
- The **releasing runbook package list is derived from or verified against the actual workspace set**, such that adding or removing a package cannot leave it silently stale.
- The **full build and test suite pass**.
