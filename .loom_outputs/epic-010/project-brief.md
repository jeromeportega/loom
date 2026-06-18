# Trustworthy Build, Test & Integration-Gate Reliability

## The Problem

Loom's own dogfooding surfaced that its quality machinery — the integration gate, the build/test pipeline, the command self-description registry, and the release command — produces **false signals in both directions**. The gate fails sound code, dev-machine runs disagree with the gate, a new command can ship invisibly, and a release leaves the repo in a subtly broken state. The unifying defect: correctness is being judged against *stale or derived state* instead of the *current source of truth*.

Four concrete failures were observed:

1. **Stale dependency in the integration gate.** The gate runs in a throwaway integration worktree where dependencies are never installed. A dependent workspace package resolves a *stale built copy* of a dependency package. When story A adds a method to `loom-core` and story B's package uses it, the gate's build fails with "method does not exist" — even though the code is correct and a clean checkout builds and passes the full suite. Under a blocking gate, this would wrongly withhold a sound PR.

2. **Stale build output on long-lived working trees.** The TypeScript compiler never deletes outputs for renamed or removed files; the test runner then discovers and runs every compiled test under `dist/`, including renamed-away ones; and a removal-guard test asserts a package directory is gone *on disk* when only an untracked build-output leftover remains. A fresh worktree hides all of this, so the gate and a real developer checkout disagree.

3. **Silent gap in the describe registry.** A new command can ship with a valid description that is never collected into the manifest. The completeness test passes anyway because it checks the *derived collected list* rather than the *live command registry* — so the new command is silently absent from `describe` output.

4. **Release leaves the repo dirty.** The release command leaves the lockfile drifting behind the bumped package versions, and a clean build drops the executable bit on the CLI entry, so the linked command is not runnable without a manual fix.

## Target Users

- **Primary — loom contributors and the loom autonomous agents themselves.** Both rely on the integration gate as a truthful arbiter of whether a PR is mergeable. The agents are a first-class user here: a false gate failure stalls autonomous delivery.
- **Secondary — loom operators / release managers** who run the release command and expect a clean, runnable, in-sync repository afterward.
- **Anti-persona — end users of a published loom CLI.** This work is internal engineering hygiene; it must not change user-facing CLI behavior or human help output.

## Proposed Solution

Make every quality check judge against current source rather than stale or derived state, across four independent fixes:

1. **Trustworthy integration gate** — guarantee dependent packages build against freshly built dependencies in the integration worktree.
2. **Clean build and test** — make build/test resilient to stale compiled output and assert removals against version control, not disk.
3. **Honest self-description completeness** — drive manifest collection and its completeness test from the live command registry.
4. **Release and build polish** — keep the lockfile in sync and preserve the CLI executable bit on a clean build.

The four parts are independently deliverable and independently verifiable; they share the theme but not the code paths.

## Key Capabilities

1. In the integration worktree, ensure correct workspace linking and **build dependency packages in dependency order before dependents** (or refresh the dependency install), so a method added to `loom-core` in one story is visible to a dependent package built later in the same gate run.
2. **Clean per-package compiled output before building** (or otherwise restrict the runner to tests that still exist in source) so renamed-away or deleted compiled tests cannot be picked up and run.
3. Change removal-guard tests to **assert a package is absent from version control**, not from disk, so an untracked build-output leftover does not fail them.
4. Make manifest collection **discover a description for every command from the command sources**, and rewrite the completeness test to **enumerate the live registry and assert every registered command resolves to a description** (the inverse of checking the already-collected list).
5. **Wire the existing `publish` command into the manifest** so `describe` lists it.
6. In the release command, **refresh and stage the lockfile** so it stays in sync with bumped package versions.
7. Ensure a **clean build sets the executable bit** on the CLI entry so the linked command is runnable without manual intervention.

## Constraints

- **Do not weaken any guardrail.** The gate must still catch genuine cross-story regressions — this work removes false failures without hiding real ones.
- **Do not reintroduce an MCP server.** (Worker provisioning is retained per current positioning.)
- **Keep human help output working.**
- Build/test changes must hold on a **long-lived working tree that previously built an older revision**, not only in a fresh checkout — that disagreement is the bug, not an edge case.
- Per `CLAUDE.md`: if any change alters a user-visible feature, update `docs/capabilities.md` in the same PR. [ASSUMPTION] This is internal hygiene with no user-visible surface change, so no capabilities update is expected; confirm before merge.

## Risks and Open Questions

- **Cleaning `dist/` before build may mask incremental-build assumptions** elsewhere in tooling or CI caching. [ASSUMPTION] No tooling depends on stale `dist/` persistence; verify against CI config.
- **Choice between "build in dependency order" vs. "refresh dependency install"** in the integration worktree is left open by the brief. [ASSUMPTION] Dependency-ordered build is lighter-weight than a full install in a throwaway worktree and is the preferred path; the PM/architect should confirm which the gate's current structure supports most cleanly.
- **Version-control-absence assertion** depends on a reliable way to query tracked state within the test environment. [ASSUMPTION] The test harness can shell out to git or read the index; confirm this is available in the gate's execution context.
- **Regression test for cross-package addition** must itself avoid the fresh-worktree blind spot it is testing for — it needs to exercise the actual worktree-and-build path, not a simplified stand-in, or it will pass vacuously.
- **Executable-bit preservation** is platform-sensitive. [ASSUMPTION] Target is POSIX (macOS/Linux dev + CI); Windows behavior is out of scope.

## Success Criteria

1. A **correct cross-package API addition builds green** through the integration gate rather than failing on a stale dependency, proven by a regression that reproduces the cross-package addition scenario.
2. The **full build and test suite passes on a long-lived working tree** that previously built an older revision — with no failures from stale compiled tests or build-output leftovers — and the removal-guard tests assert version-control absence.
3. The **describe manifest includes every registered command**, proven by a completeness test that enumerates the live registry; `describe` returns a description for **`publish` and `release`**.
4. The **release command leaves the lockfile in sync** with the bumped package versions, and a **clean build produces a runnable linked command** without a manual executable-bit change.
5. The **full build and test suite passes**, and the integration gate still fails on a genuine cross-story regression (guardrail integrity preserved).
