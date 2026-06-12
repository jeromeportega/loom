# Pre-1.0 Operator-Trust Hardening

## Overview

Five surgical, independent corrections to loom's operator-facing surfaces, landing as the final polish wave before the v1.0 stability freeze. Each closes one dogfooding finding sharing a single failure mode: **the system tells the operator something untrue, or fails on input that demonstrably works.** The unifying rule is that every surface must *tell the truth, accept what works, or warn honestly about what it cannot guarantee.* All work is purely additive or corrective — no renamed/removed statuses, no new top-level command, no new policy knobs, and (per `[ASSUMPTION]`) no schema migration.

## Goals

1. **Zero false failures on the onboarding path.** A working `cursor_model` alias (`claude-opus-4-8`) proceeds through `loom doctor` / `loom epic` / `loom run` with an advisory; a bogus id still exits non-zero; an exact id stays silent. *Metric: all three cases asserted green against a stubbed `--list-models`.*
2. **No surface claims an action it does not perform.** No live doc/skill/CLI source claims `loom approve` dispatches workers. *Metric: a repo-wide copy-sweep test (excluding `.loom_outputs/`) passes.*
3. **Every planning run is identifiable and durable from submission.** *Metric: immediately after `loom epic` submission `loom status` shows the new row with a derived title and `planning_phase`; two concurrent stubbed runs allocate ids in submission order; no orphaned `(planning…)` rows after a gate-reject or crash.*
4. **Cross-epic conflicts are surfaced before they bite.** *Metric: `loom approve`/`loom run` against an overlapping contract prints each overlapping file with both owners (approval still succeeds); `loom doctor --cross-epic-gate` reports mechanical conflicts and union-suite failures with the correct exit codes (`3` advisory / `1` operational / `0` clean).*

## User Stories

- **US-1 (Must)** — As a first-time operator, I want `loom epic` to accept a `cursor_model` alias that `cursor-agent` actually runs, so that my first run doesn't die on a model that works.
- **US-2 (Must)** — As an operator, I want `loom approve`'s copy and docs to match what it does, and an opt-in `--run` flag, so that "dispatching" is only ever printed by a path that dispatches.
- **US-3 (Must)** — As a tandem operator, I want my planning run to appear in `loom status` the instant I submit it, with ids allocated in submission order, so that concurrent runs are never confused or invisible.
- **US-4 (Must)** — As a tandem operator, I want an advisory listing files two epics' contracts both claim at approve/dispatch time, so that I catch mechanical collisions a human currently has to spot by hand.
- **US-5 (Should)** — As a maintainer, I want `loom doctor --cross-epic-gate` to merge open epic branches in a throwaway worktree and run the suite once, so that I catch union-of-branches regressions before a manual merge does.

## Functional Requirements

- **FR-1** — `validateCursorModels` becomes three-tier: (a) exact match → `ok` (unchanged); (b) no exact match but the configured id is a strict prefix of a listed id **at a `-` boundary** → `ok` with an advisory recommending the explicit suffixed form; (c) neither → `invalid` with the full list (unchanged). `unavailable` semantics are untouched. `claude-opus-4` must **not** alias-match `claude-opus-4-8-high`.
- **FR-2** — The advisory from FR-1(b) warns and never exits non-zero. All three call sites — `loom doctor`, `loom epic`, `loom run` — inherit the new tier through the shared function with no per-site special-casing.
- **FR-3** — Correct every surface that claims `loom approve` dispatches workers: the `docs/capabilities.md` "Approve a plan" row, the loom-approve skill in **both** `.claude/skills/` and `.agents/skills/`, and the CLI success copy (which must end with ``run `loom run <epic-id>` to dispatch``).
- **FR-4** — Add `loom approve <epic-id> --run`, which approves and then chains into the same code path as `loom run <epic-id>`, so "dispatching now" is only printed by a dispatching path. Bare `loom approve --run` (no explicit id) exits non-zero with a one-line usage hint.
- **FR-5** — `runEpic` reserves the epic row at submission time, **before** the BriefRefiner runs, with a derived placeholder title (the brief's first markdown heading if present, else its first 60 characters), reusing the `beginPlanning` seam. The reservation **is** the id allocation: the Planner consumes a pre-reserved epic id (optional parameter defaulting to today's self-allocation), so `nextEpicId`-style allocation never runs twice for one submission. The refined/planner title replaces the placeholder at completion via the existing seam.
- **FR-6** — A gate-rejected brief flips the reserved row to `rejected` with `error` carrying the gate verdict (e.g. `"brief gate: 3/10 — <first critique line>"`); a refiner/planner throw flips it to `failed` via the existing epic-005 path. No orphaned `(planning…)` rows in either case. A `--force` run reserves before the refiner too and must **never** be marked `rejected`.
- **FR-7** — At `loom approve` and at `loom run` dispatch start, parse the file-ownership maps of the target epic and every other planned/approved/in-progress epic in the repo, and print an advisory listing each overlapping file with both epic/story owners. It warns, never blocks. A missing contract file (`shared_contract=off`) is silently skipped. Comparison is **exact lexical path equality** — no globbing, no directory-prefix inference, no semantic analysis; copy frames the result as lexical-only.
- **FR-8** — The contract parser reads the markdown table under the file-ownership heading: path is the first column; cells may carry multiple paths separated by `,`, `·`, or `<br>`. It strips surrounding backticks, parenthesized annotations (`(new)`/`(delete)`), and trailing prose, and normalizes to repo-relative POSIX paths. An unparseable row is skipped, never fatal. Pinned with fixtures lifted from the real contracts of epics 001–006.
- **FR-9** — Add `loom doctor --cross-epic-gate` (alongside the existing `--dry-run-gate`; no `loom gate` command). It reuses the `runGateDryRun` ephemeral-worktree machinery: create a throwaway worktree from the default-branch tip, sequentially merge every open epic branch (`epic/*`, or an explicit `--epics <id,id>` allowlist), then (a) if any merge conflicts → report conflicting files per epic pair and stop, or (b) if all merge clean → run `policy.agents.test_command` once and report pass/fail with union context. Real branches are never mutated.
- **FR-10** — `loom doctor --cross-epic-gate` exit codes: `0` = merges clean and suite green; `3` = advisory finding (mechanical conflict **or** union-suite failure — distinct so scripts can branch on it); `1` = hard operational error (worktree creation failed, no epic branches found, gate command unresolvable).
- **FR-11** — When the EpicFinalizer opens a PR while other epic branches have open PRs, print a one-line hint naming `loom doctor --cross-epic-gate`.
- **FR-12** — `loom approve <id> --run` runs the FR-7 overlap check once at approve time and suppresses the duplicate check in the chained dispatch.
- **FR-13** — A single owner story updates `docs/capabilities.md`: corrected approve row, model-validation alias tier, `loom doctor` `--cross-epic-gate` row, and a status-row note on derived submission titles.

## Epics

This is **one epic** — five surgical, related corrections to one product's operator surfaces, sharing a single failure mode and a single shipping unit (the pre-1.0 polish wave). Although it touches multiple packages (`loom-core`, `loom-cli`), the brief describes one cohesive piece of work, not separable deliverables.

- **epic-001 — Pre-1.0 Operator-Trust Hardening**

## Out of Scope

- No changes to per-epic integration-gate semantics, `warn`/`block` behavior, or the policy engine.
- No semantic/AST-level overlap analysis — Part 4 is lexical path comparison only.
- No automatic cross-epic gate inside the EpicFinalizer, and no new policy knobs for it.
- No cross-repo functionality.
- No renaming or removal of existing statuses, tools, or policy fields; no new top-level command (Part 5 rides on `doctor`); no schema migration (`[ASSUMPTION]` — placeholder title + early insert reuse existing columns).

Proceeding to Headless task B — the epic/story breakdown.

```json
{
  "epics": [
    {
      "epic_id": "epic-001",
      "title": "Pre-1.0 Operator-Trust Hardening",
      "priority": "must-have",
      "prd_ref": ".loom/planning/prd.md",
      "requirements": ["FR-1", "FR-2", "FR-3", "FR-4", "FR-5", "FR-6", "FR-7", "FR-8", "FR-9", "FR-10", "FR-11", "FR-12", "FR-13"],
      "stories": [
        {
          "id": "story-001-001",
          "title": "Accept alias cursor_model ids with a boundary-prefix advisory tier",
          "description": "Make validateCursorModels three-tier so a working alias id (e.g. claude-opus-4-8) passes with an advisory recommending the suffixed form, while a strict-prefix-only-at-a-`-`-boundary rule prevents claude-opus-4 from matching claude-opus-4-8-high. The advisory warns, never exits non-zero, and flows to all three call sites (doctor/epic/run) through the shared function.",
          "acceptance_criteria": [
            "An exact match returns status 'ok' with an empty message (unchanged).",
            "A configured id that is a strict prefix of a listed id at a '-' boundary returns 'ok' with an advisory message recommending the explicit suffixed form.",
            "'claude-opus-4' configured against a list containing 'claude-opus-4-8-high' does NOT alias-match (no false 'ok').",
            "A genuinely bogus id still returns 'invalid' with the complete valid-model list; 'unavailable' semantics are unchanged.",
            "The three asserted cases (alias→advisory, bogus→invalid, exact→silent) pass against a stubbed --list-models in __tests__/."
          ],
          "estimated_complexity": "small",
          "dependencies": []
        },
        {
          "id": "story-001-002",
          "title": "Surface the alias advisory at all three call sites without false failures",
          "description": "Ensure loom doctor, loom epic, and loom run print the FR-1(b) advisory and proceed (exit 0) on an alias id, exit non-zero only on a confirmed-invalid id, and stay silent on an exact match — inheriting the behavior from the shared function with no per-site special-casing.",
          "acceptance_criteria": [
            "loom epic and loom run print the advisory and proceed on an alias cursor_model; they exit non-zero only on status 'invalid'.",
            "loom doctor reports the alias case as a warn (not FAIL) with the advisory text and exits 0.",
            "An exact-match id produces no advisory at any of the three call sites.",
            "Tests stub the --list-models probe; no real cursor-agent is spawned."
          ],
          "estimated_complexity": "small",
          "dependencies": ["story-001-001"]
        },
        {
          "id": "story-001-003",
          "title": "Truthful approve copy across docs, skills, and CLI",
          "description": "Correct every surface claiming loom approve dispatches workers: the docs/capabilities.md 'Approve a plan' row, the loom-approve skill in both .claude/skills/ and .agents/skills/, and the CLI success copy, which must end with the literal hint to run `loom run <epic-id>` to dispatch.",
          "acceptance_criteria": [
            "No live doc/skill/CLI source claims loom approve dispatches workers (a copy-sweep test scoped to live sources, excluding .loom_outputs/, passes).",
            "loom approve <id> success copy ends with a hint pointing to `loom run <epic-id>` to dispatch.",
            "Both .claude/skills/loom-approve/SKILL.md and .agents/skills/loom-approve/SKILL.md are corrected (no 'dispatch in the background' claim)."
          ],
          "estimated_complexity": "small",
          "dependencies": []
        },
        {
          "id": "story-001-004",
          "title": "Add opt-in loom approve --run that chains into the run path",
          "description": "Add `loom approve <epic-id> --run`, which approves then chains into the same code path as `loom run <epic-id>` so 'dispatching now' is only printed by a path that actually dispatches. Bare `loom approve --run` (no explicit id) exits non-zero with a one-line usage hint.",
          "acceptance_criteria": [
            "`loom approve <id> --run` approves the epic, then dispatches through the loom run code path.",
            "Bare `loom approve --run` exits non-zero and prints a one-line usage hint.",
            "`--run` only triggers dispatch when given an explicit epic id; the existing non--run approve behavior is unchanged.",
            "The overlap check (story-001-008) runs once at approve time and is suppressed in the chained dispatch."
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-003", "story-001-008"]
        },
        {
          "id": "story-001-005",
          "title": "Reserve the epic row at submission with a single allocation site",
          "description": "Reserve the epic row in runEpic before the BriefRefiner runs, with a derived placeholder title (first markdown heading, else first 60 chars), reusing beginPlanning. Refactor so the Planner consumes a pre-reserved epic id (optional parameter defaulting to today's self-allocation) so nextEpicId-style allocation never runs twice for one submission; the planner title replaces the placeholder at completion via the existing seam.",
          "acceptance_criteria": [
            "Immediately after submission, loom status shows the new epic row with a derived title and a planning_phase.",
            "The placeholder title is the brief's first markdown heading when present, otherwise its first 60 characters.",
            "nextEpicId-style allocation runs exactly once per submission (no parallel insert path); the Planner accepts a pre-reserved id and defaults to self-allocation when none is passed.",
            "The refined/planner title replaces the placeholder at planning completion.",
            "Two stubbed-LLM planning runs where the first refiner finishes second still allocate ids in submission order."
          ],
          "estimated_complexity": "medium",
          "dependencies": []
        },
        {
          "id": "story-001-006",
          "title": "Define clean terminal states for gate-rejected and crashed planning runs",
          "description": "On the reserved row from story-001-005, a brief-gate rejection flips status to 'rejected' with error carrying the gate verdict (e.g. 'brief gate: 3/10 — <first critique line>'); a refiner/planner throw flips to 'failed' via the existing epic-005 path. A --force run reserves before the refiner too and is never marked 'rejected'.",
          "acceptance_criteria": [
            "A gate-rejected brief leaves the reserved row as 'rejected' with the gate verdict in error; no orphaned '(planning…)' row.",
            "A refiner/planner crash leaves the row 'failed' (epic-005 path), not 'rejected'.",
            "A --force run reserves before the refiner and is never recorded as 'rejected', even when the brief scores below threshold.",
            "A test verifies no downstream consumer of 'rejected' mishandles the non-human quality-gate verdict."
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-005"]
        },
        {
          "id": "story-001-007",
          "title": "Parse the file-ownership map from epic contracts",
          "description": "Implement a parser for the file-ownership markdown table in .loom/contract/<epic-id>.md: first column is the path; cells may hold multiple paths separated by ',', '·', or '<br>'. Strip surrounding backticks, parenthesized annotations ((new)/(delete)), and trailing prose; normalize to repo-relative POSIX paths. Unparseable rows are skipped, never fatal.",
          "acceptance_criteria": [
            "The parser extracts the owning story/epic and the normalized path(s) from each row of the ownership table.",
            "Cells split on ',', '·', and '<br>'; backticks, (new)/(delete) annotations, and trailing prose are stripped.",
            "An unparseable row is skipped without throwing.",
            "Fixtures lifted from the real contracts of epics 001–006 (which use the '·' delimiter) pin the parser in __tests__/."
          ],
          "estimated_complexity": "medium",
          "dependencies": []
        },
        {
          "id": "story-001-008",
          "title": "Cross-epic overlap advisory at approve and dispatch",
          "description": "At loom approve and at loom run dispatch start, compare the parsed ownership maps of the target epic and every other planned/approved/in-progress epic by exact lexical path equality, and print an advisory listing each overlapping file with both epic/story owners. Warns, never blocks; a missing contract file (shared_contract=off) is silently skipped; copy frames the result as lexical-only.",
          "acceptance_criteria": [
            "loom approve against an epic whose contract overlaps an in-flight epic's contract prints the overlapping files with both owners; approval still succeeds.",
            "Comparison is exact lexical path equality — no globbing, directory-prefix inference, or semantic analysis.",
            "A missing contract file for any compared epic is silently skipped (no error).",
            "The advisory copy frames the result as lexical-only.",
            "The same check runs at loom run dispatch start."
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-007"]
        },
        {
          "id": "story-001-009",
          "title": "Add loom doctor --cross-epic-gate with union merge + suite run",
          "description": "Add the --cross-epic-gate flag to loom doctor (no new top-level command), reusing the runGateDryRun ephemeral-worktree machinery. Create a throwaway worktree from the default-branch tip, sequentially merge every open epic branch (epic/*, or an explicit --epics <id,id> allowlist), then report per-pair conflicts and stop, or run policy.agents.test_command once and report pass/fail with union context. Real branches are never mutated. Also emit the FR-11 finalizer PR hint.",
          "acceptance_criteria": [
            "Two fixture epic branches that conflict mechanically: reports the conflicting file list per epic pair and exits 3.",
            "Two fixture epic branches that merge cleanly but fail the suite: reports the union failure and exits 3.",
            "Two fixture epic branches that merge cleanly and pass the suite: exits 0.",
            "A hard operational error (worktree creation failed, no epic branches found, gate command unresolvable) exits 1.",
            "The --epics allowlist and the 'no epic branches found → exit 1' case have explicit test coverage; real branches are never mutated (temp git repos, no sleeps, no real cursor-agent).",
            "When the EpicFinalizer opens a PR while other epic branches have open PRs, it prints a one-line hint naming `loom doctor --cross-epic-gate`."
          ],
          "estimated_complexity": "large",
          "dependencies": []
        },
        {
          "id": "story-001-010",
          "title": "Update docs/capabilities.md for all four changed surfaces",
          "description": "Single owner story for the capabilities-doc diff: correct the 'Approve a plan' row, add the model-validation alias tier note, add --cross-epic-gate to the loom doctor row, and note derived-from-submission titles on the status row.",
          "acceptance_criteria": [
            "The 'Approve a plan' row no longer claims dispatch and reflects the --run opt-in.",
            "The model-validation note documents the alias→advisory tier.",
            "The loom doctor row documents --cross-epic-gate alongside --dry-run-gate.",
            "The status row notes that epics get a derived title from submission time.",
            "No other story edits docs/capabilities.md (single-owner invariant)."
          ],
          "estimated_complexity": "small",
          "dependencies": ["story-001-002", "story-001-004", "story-001-008", "story-001-009"]
        },
        {
          "id": "story-001-011",
          "title": "Run the full build + test suite and fix cross-cutting regressions",
          "description": "Run the whole-repo build and test suite across loom-core and loom-cli after all stories land, and fix any cross-cutting regressions that only surface when the changes to validateCursorModels, the approve/run paths, the planner reservation, and doctor are integrated together.",
          "acceptance_criteria": [
            "The full build passes.",
            "The entire test suite passes."
          ],
          "estimated_complexity": "small",
          "dependencies": ["story-001-001", "story-001-002", "story-001-003", "story-001-004", "story-001-005", "story-001-006", "story-001-007", "story-001-008", "story-001-009", "story-001-010"]
        }
      ]
    }
  ]
}
```
