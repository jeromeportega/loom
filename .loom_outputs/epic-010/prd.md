# Trustworthy Build, Test & Integration-Gate Reliability

## Overview

Loom's own dogfooding surfaced that its quality machinery — the integration gate, the build/test pipeline, the command self-description registry, and the release command — produces false signals in both directions: the gate fails sound code, dev-machine runs disagree with the gate, a new command can ship invisibly, and a release leaves the repo subtly broken. The unifying defect is that correctness is judged against *stale or derived state* instead of the *current source of truth*. This PRD covers four independently deliverable, independently verifiable fixes that make every quality check judge against current source — without weakening any guardrail.

## Goals

1. **Eliminate false gate failures from stale dependencies.** A correct cross-package API addition builds green through the integration gate — zero false failures on the reproduced cross-package scenario.
2. **Achieve dev/gate parity.** The full build + test suite passes on a long-lived working tree that previously built an older revision, matching a fresh checkout — zero failures from stale compiled tests or build-output leftovers.
3. **Make self-description complete and honest.** 100% of registered commands resolve to a description in `describe` output (including `publish` and `release`), proven by a test that enumerates the live registry.
4. **Make release clean and runnable.** The release command leaves the lockfile in sync with bumped versions, and a clean build yields a runnable linked command with zero manual fixes — while the gate still fails a genuine cross-story regression (guardrail integrity preserved).

## User Stories

- **As a loom contributor**, I want the integration gate to pass sound code, so that a correct PR is not wrongly withheld. (Must)
- **As a loom autonomous agent**, I want the gate to be a truthful arbiter of mergeability, so that a false failure does not stall autonomous delivery. (Must)
- **As a contributor on a long-lived working tree**, I want build/test to agree with the gate, so that I don't chase failures that vanish in a fresh checkout. (Must)
- **As a contributor adding a command**, I want it discovered automatically by `describe`, so that it cannot ship invisibly. (Must)
- **As a release manager**, I want the release command to leave a clean, runnable, in-sync repo, so that no manual lockfile or executable-bit fix is needed afterward. (Should)

## Functional Requirements

- **FR-1:** In the integration worktree, dependency packages are built in dependency order before their dependents (or the dependency install is refreshed), so a method added to `loom-core` in one story is visible to a dependent package built later in the same gate run.
- **FR-2:** A regression test reproduces the cross-package API-addition scenario by exercising the actual worktree-and-build path (not a simplified stand-in), and fails if the gate builds dependents against a stale dependency.
- **FR-3:** The build cleans per-package compiled output before building (or otherwise restricts the runner to tests that still exist in source), so renamed-away or deleted compiled tests under `dist/` cannot be discovered and run.
- **FR-4:** Removal-guard tests assert that a package is absent from version control (tracked state), not from disk, so an untracked build-output leftover does not fail them.
- **FR-5:** Manifest collection discovers a description for every command from the command sources.
- **FR-6:** The completeness test enumerates the live command registry and asserts that every registered command resolves to a description (the inverse of checking the already-collected list).
- **FR-7:** The existing `publish` command is wired into the manifest so `describe` lists it; `describe` returns a description for both `publish` and `release`.
- **FR-8:** The release command refreshes and stages the lockfile so it stays in sync with the bumped package versions.
- **FR-9:** A clean build sets the executable bit on the CLI entry, so the linked command is runnable without manual intervention.

## Non-Functional Requirements

- **NFR-1:** No guardrail is weakened — the integration gate must still fail on genuine cross-story regressions.
- **NFR-2:** No change to user-facing CLI behavior or human help output.
- **NFR-3:** Build/test fixes must hold on a long-lived working tree that previously built an older revision, not only in a fresh checkout.
- **NFR-4:** POSIX target (macOS/Linux dev + CI); Windows executable-bit behavior is out of scope. No MCP server is reintroduced (worker provisioning retained).

## Epics

The brief explicitly describes four parts that "are independently deliverable and independently verifiable; they share the theme but not the code paths." This is one of the rare multi-epic cases — four separable shipping units:

1. **Trustworthy integration gate** — build dependents against freshly built dependencies in the integration worktree (FR-1, FR-2).
2. **Clean build and test** — resilience to stale compiled output; removal-guards assert against version control (FR-3, FR-4).
3. **Honest self-description completeness** — drive manifest collection and its completeness test from the live registry; wire in `publish` (FR-5, FR-6, FR-7).
4. **Release and build polish** — keep the lockfile in sync and preserve the CLI executable bit (FR-8, FR-9).

## Out of Scope

- Any change to user-facing CLI behavior or human help output.
- Windows executable-bit handling.
- Reintroducing an MCP server.
- A `docs/capabilities.md` update — **[ASSUMPTION]** this is internal hygiene with no user-visible surface change, so none is expected; confirm before merge.
